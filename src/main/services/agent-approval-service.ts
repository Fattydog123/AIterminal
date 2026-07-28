import { createHmac, randomBytes } from 'node:crypto'

import type { AgentEvent, ApprovalMode } from '../../shared/contracts.ts'
import {
  ConsentStore,
  type LocalToolOperationCategory
} from '../security/consent-store.ts'
import { redactSensitiveContent, redactSensitiveText } from '../security/redaction.ts'

export interface AgentToolApprovalRequest {
  turnId: string
  callId: string
  workspaceToken: string
  operation: LocalToolOperationCategory
  toolName: string
  arguments: Readonly<Record<string, unknown>>
  label: string
  detail?: string
  risk: 'low' | 'medium' | 'high'
  mode: ApprovalMode
  signal: AbortSignal
}

export interface AgentToolAuthorization {
  approvalHandle: string
  workspaceToken: string
  operation: LocalToolOperationCategory
  requestDigest: string
  decisionSource: 'user' | 'session' | 'policy' | 'full'
}

export interface AgentApprovalServiceOptions {
  consents: ConsentStore
  onEvent: (event: AgentEvent) => void
  now?: () => number
  approvalTtlMs?: number
  /**
   * Optional DPAPI-backed storage for "always allow" grants. Grants persist
   * only when the workspace resolves to a stable identity below; everything
   * else stays session-scoped exactly as before.
   */
  persistence?: { read(): Promise<string | null>; write(value: string): Promise<void> }
  /**
   * Resolves a session workspace token to a stable identity so a persisted
   * grant follows the workspace, not the token. Returning null keeps the
   * grant in memory only.
   */
  resolveWorkspaceIdentity?: (workspaceToken: string) => Promise<{ device: string; inode: string } | null>
}

/**
 * Renderer-visible description of one "always allow this session" grant.
 * Deliberately excludes the workspace token and the internal scope key; the
 * id is an opaque digest that only supports revocation.
 */
export interface AgentSessionScopeDescriptor {
  readonly id: string
  readonly toolName: string
  readonly operation: LocalToolOperationCategory
  readonly risk: 'low' | 'medium' | 'high'
}

interface PendingApproval {
  turnId: string
  expiresAt: number
  timer: NodeJS.Timeout
  sessionScopeKey: string | null
  /** Present only for ask_user questions: the number of offered options. */
  optionCount?: number
  abort: () => void
  settle: (decision: string) => void
}

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const WORKSPACE_TOKEN_PATTERN = /^ws_[A-Za-z0-9_-]{43}$/u
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/u
const DEFAULT_APPROVAL_TTL_MS = 2 * 60_000
const MIN_APPROVAL_TTL_MS = 1_000
const MAX_APPROVAL_TTL_MS = 10 * 60_000
const MAX_PENDING_APPROVALS = 256
const MAX_APPROVAL_DETAIL_CHARACTERS = 8 * 1024
const MAX_SESSION_ALLOWLIST_ENTRIES = 128
// delete_path stays one-shot: destructive removals must be confirmed each time.
const SESSION_SCOPE_EXCLUDED_TOOLS = new Set(['delete_path'])

export class AgentApprovalError extends Error {
  readonly code: 'invalid_configuration' | 'invalid_request' | 'capacity_exceeded' | 'disposed'

  constructor(code: AgentApprovalError['code']) {
    super({
      invalid_configuration: 'The Agent approval service configuration is invalid.',
      invalid_request: 'The Agent approval request is invalid.',
      capacity_exceeded: 'Too many Agent approvals are pending.',
      disposed: 'The Agent approval service is no longer available.'
    }[code])
    this.name = 'AgentApprovalError'
    this.code = code
    this.stack = `${this.name}: ${this.message}`
  }
}

export class AgentApprovalService {
  readonly #consents: ConsentStore
  readonly #onEvent: AgentApprovalServiceOptions['onEvent']
  readonly #now: () => number
  readonly #approvalTtlMs: number
  readonly #digestKey: Buffer
  readonly #pending = new Map<string, PendingApproval>()
  readonly #sessionAllowlist = new Map<string, AgentSessionScopeDescriptor>()
  readonly #persistentScopeKeys = new Set<string>()
  readonly #persistence: AgentApprovalServiceOptions['persistence']
  readonly #resolveWorkspaceIdentity: AgentApprovalServiceOptions['resolveWorkspaceIdentity']
  readonly #ready: Promise<void>
  #persistTail: Promise<void> = Promise.resolve()
  #disposed = false

  constructor(options: AgentApprovalServiceOptions) {
    if (
      !isPlainRecord(options) ||
      !(options.consents instanceof ConsentStore) ||
      typeof options.onEvent !== 'function' ||
      (options.now !== undefined && typeof options.now !== 'function') ||
      (options.approvalTtlMs !== undefined && !isBoundedTtl(options.approvalTtlMs)) ||
      (options.persistence !== undefined && (
        typeof options.persistence.read !== 'function' ||
        typeof options.persistence.write !== 'function'
      )) ||
      (options.resolveWorkspaceIdentity !== undefined && typeof options.resolveWorkspaceIdentity !== 'function')
    ) {
      throw new AgentApprovalError('invalid_configuration')
    }
    this.#consents = options.consents
    this.#onEvent = options.onEvent
    this.#now = options.now ?? Date.now
    this.#approvalTtlMs = options.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS
    this.#persistence = options.persistence
    this.#resolveWorkspaceIdentity = options.resolveWorkspaceIdentity
    try {
      this.#digestKey = randomBytes(32)
    } catch {
      throw new AgentApprovalError('invalid_configuration')
    }
    // Failing to read persisted grants degrades to an empty allowlist; it must
    // never block approvals themselves.
    this.#ready = this.#loadPersistedScopes().catch(() => undefined)
  }

  async authorize(request: AgentToolApprovalRequest): Promise<AgentToolAuthorization | null> {
    if (this.#disposed) throw new AgentApprovalError('disposed')
    const normalized = normalizeApprovalRequest(request)
    if (normalized.signal.aborted) return null

    const requestDigest = createHmac('sha256', this.#digestKey)
      .update(canonicalJson({
        v: 1,
        turnId: normalized.turnId,
        callId: normalized.callId,
        workspaceToken: normalized.workspaceToken,
        operation: normalized.operation,
        toolName: normalized.toolName,
        arguments: normalized.arguments
      }))
      .digest('hex')

    let decisionSource: AgentToolAuthorization['decisionSource']
    const sessionScope = normalized.mode === 'full' ? null : await this.#sessionScope(normalized)
    if (normalized.mode !== 'full') await this.#ready
    if (normalized.signal.aborted || this.#disposed) return null
    if (normalized.mode === 'request') {
      if (sessionScope !== null && this.#sessionAllowlist.has(sessionScope.key)) {
        decisionSource = 'session'
      } else {
        const outcome = await this.#requestUserDecision(normalized, sessionScope)
        if (outcome === 'deny') return null
        decisionSource = outcome === 'allow_session' ? 'session' : 'user'
      }
    } else if (normalized.mode === 'auto') {
      if (isPolicyAutoApprovable(normalized.operation, normalized.risk)) {
        decisionSource = 'policy'
      } else if (sessionScope !== null && this.#sessionAllowlist.has(sessionScope.key)) {
        decisionSource = 'session'
      } else {
        const outcome = await this.#requestUserDecision(normalized, sessionScope)
        if (outcome === 'deny') return null
        decisionSource = outcome === 'allow_session' ? 'session' : 'user'
      }
    } else {
      decisionSource = 'full'
    }

    if (normalized.signal.aborted || this.#disposed) return null
    const grant = this.#consents.issueLocalToolApproval({
      workspaceToken: normalized.workspaceToken,
      operation: normalized.operation,
      requestDigest
    })
    return Object.freeze({
      approvalHandle: grant.approvalHandle,
      workspaceToken: normalized.workspaceToken,
      operation: normalized.operation,
      requestDigest,
      decisionSource
    })
  }

  consume(authorization: AgentToolAuthorization): boolean {
    if (this.#disposed || !isAuthorization(authorization)) return false
    return this.#consents.consumeLocalToolApproval({
      approvalHandle: authorization.approvalHandle,
      workspaceToken: authorization.workspaceToken,
      operation: authorization.operation,
      requestDigest: authorization.requestDigest
    })
  }

  resolve(approvalId: unknown, decision: unknown): boolean {
    const optionDecision = typeof decision === 'string' && /^option:[0-3]$/u.test(decision)
    if (
      this.#disposed ||
      typeof approvalId !== 'string' ||
      !SAFE_ID_PATTERN.test(approvalId) ||
      (decision !== 'allow_once' && decision !== 'allow_session' && decision !== 'deny' && !optionDecision)
    ) {
      return false
    }
    const pending = this.#pending.get(approvalId)
    if (!pending) return false
    // Question and approval decisions must not cross: an option pick is only
    // valid for a pending question and within its offered range, while the
    // allow decisions are only valid for real tool approvals.
    if (optionDecision) {
      if (pending.optionCount === undefined) return false
      const optionIndex = Number.parseInt((decision as string).slice('option:'.length), 10)
      if (optionIndex >= pending.optionCount) return false
    } else if (decision !== 'deny' && pending.optionCount !== undefined) {
      return false
    }
    if (decision === 'allow_session' && pending.sessionScopeKey === null) return false
    this.#pending.delete(approvalId)
    clearTimeout(pending.timer)
    pending.abort()
    pending.settle(decision as string)
    return true
  }

  /**
   * Ask the user a bounded multiple-choice question through the approval
   * surface. Resolves to the selected option index, or null when the user
   * declines, the request times out, or the turn is cancelled.
   */
  async askUser(request: {
    turnId: unknown
    question: unknown
    options: unknown
    signal: unknown
  }): Promise<number | null> {
    if (this.#disposed) throw new AgentApprovalError('disposed')
    const normalized = normalizeUserQuestion(request)
    if (this.#pending.size >= MAX_PENDING_APPROVALS) {
      throw new AgentApprovalError('capacity_exceeded')
    }
    const approvalId = issueApprovalId(this.#pending)
    const now = this.#readNow()
    const expiresAt = now + this.#approvalTtlMs

    return await new Promise<number | null>((resolve) => {
      let settled = false
      const finish = (decision: string): void => {
        if (settled) return
        settled = true
        normalized.signal.removeEventListener('abort', onAbort)
        resolve(decision.startsWith('option:')
          ? Number.parseInt(decision.slice('option:'.length), 10)
          : null)
      }
      const onAbort = (): void => {
        const pending = this.#pending.get(approvalId)
        if (pending) {
          this.#pending.delete(approvalId)
          clearTimeout(pending.timer)
        }
        finish('deny')
      }
      const timer = setTimeout(() => {
        this.#pending.delete(approvalId)
        normalized.signal.removeEventListener('abort', onAbort)
        finish('deny')
      }, this.#approvalTtlMs)
      timer.unref()

      this.#pending.set(approvalId, {
        turnId: normalized.turnId,
        expiresAt,
        timer,
        sessionScopeKey: null,
        optionCount: normalized.options.length,
        abort: () => normalized.signal.removeEventListener('abort', onAbort),
        settle: finish
      })
      normalized.signal.addEventListener('abort', onAbort, { once: true })
      this.#emit({
        type: 'turn-status',
        turnId: normalized.turnId,
        status: 'waiting-approval',
        message: 'Agent 正在等待你的选择。'
      })
      this.#emit({
        type: 'approval-request',
        turnId: normalized.turnId,
        approvalId,
        label: redactSensitiveText(normalized.question),
        risk: 'low',
        expiresAt: new Date(expiresAt).toISOString(),
        question: { options: normalized.options.map((option) => redactSensitiveText(option)) }
      })
    })
  }

  cancelTurn(turnId: string): void {
    for (const [approvalId, pending] of this.#pending) {
      if (pending.turnId !== turnId) continue
      this.#pending.delete(approvalId)
      clearTimeout(pending.timer)
      pending.abort()
      pending.settle('deny')
    }
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.abort()
      pending.settle('deny')
    }
    this.#pending.clear()
    this.#sessionAllowlist.clear()
  }

  async #requestUserDecision(
    request: ReturnType<typeof normalizeApprovalRequest>,
    sessionScope: { key: string; persistent: boolean } | null
  ): Promise<'allow_once' | 'allow_session' | 'deny'> {
    const sessionScopeKey = sessionScope?.key ?? null
    if (this.#pending.size >= MAX_PENDING_APPROVALS) {
      throw new AgentApprovalError('capacity_exceeded')
    }
    const approvalId = issueApprovalId(this.#pending)
    const now = this.#readNow()
    const expiresAt = now + this.#approvalTtlMs

    return await new Promise<'allow_once' | 'allow_session' | 'deny'>((resolve) => {
      let settled = false
      const finish = (decision: string): void => {
        if (settled) return
        settled = true
        request.signal.removeEventListener('abort', onAbort)
        if (decision === 'allow_session' && sessionScope !== null) {
          this.#rememberSessionScope(sessionScope.key, {
            toolName: request.toolName,
            operation: request.operation,
            risk: request.risk
          }, sessionScope.persistent)
        }
        // resolve() never routes an option decision to a tool approval, so
        // anything but the two allow decisions settles as a denial.
        resolve(decision === 'allow_once' || decision === 'allow_session' ? decision : 'deny')
      }
      const onAbort = (): void => {
        const pending = this.#pending.get(approvalId)
        if (pending) {
          this.#pending.delete(approvalId)
          clearTimeout(pending.timer)
        }
        finish('deny')
      }
      const timer = setTimeout(() => {
        this.#pending.delete(approvalId)
        request.signal.removeEventListener('abort', onAbort)
        finish('deny')
      }, this.#approvalTtlMs)
      timer.unref()

      this.#pending.set(approvalId, {
        turnId: request.turnId,
        expiresAt,
        timer,
        sessionScopeKey,
        abort: () => request.signal.removeEventListener('abort', onAbort),
        settle: finish
      })
      request.signal.addEventListener('abort', onAbort, { once: true })
      this.#emit({
        type: 'turn-status',
        turnId: request.turnId,
        status: 'waiting-approval',
        message: 'Agent 正在等待本次本地操作批准。'
      })
      this.#emit({
        type: 'approval-request',
        turnId: request.turnId,
        approvalId,
        label: redactSensitiveText(request.label),
        // redactSensitiveText truncates to a single short message; a command or
        // diff preview must stay reviewable, so redact without that cap and
        // bound the result against the renderer event contract instead.
        ...(request.detail === undefined ? {} : { detail: boundedApprovalDetail(redactSensitiveContent(request.detail)) }),
        risk: request.risk,
        ...(sessionScopeKey === null ? {} : { allowSessionScope: true }),
        expiresAt: new Date(expiresAt).toISOString()
      })
    })
  }

  /** Grants issued via "always allow this session", without workspace tokens. */
  listSessionScopes(): AgentSessionScopeDescriptor[] {
    if (this.#disposed) return []
    return [...this.#sessionAllowlist.values()].map((entry) => ({ ...entry }))
  }

  revokeSessionScope(id: unknown): boolean {
    if (this.#disposed || typeof id !== 'string' || !SAFE_ID_PATTERN.test(id)) return false
    for (const [key, entry] of this.#sessionAllowlist) {
      if (entry.id === id) {
        this.#sessionAllowlist.delete(key)
        if (this.#persistentScopeKeys.delete(key)) this.#queuePersistScopes()
        return true
      }
    }
    return false
  }

  #rememberSessionScope(
    sessionScopeKey: string,
    scope: Omit<AgentSessionScopeDescriptor, 'id'>,
    persistent = false
  ): void {
    if (this.#sessionAllowlist.has(sessionScopeKey)) return
    if (this.#sessionAllowlist.size >= MAX_SESSION_ALLOWLIST_ENTRIES) {
      const oldest = this.#sessionAllowlist.keys().next().value
      if (oldest !== undefined) {
        this.#sessionAllowlist.delete(oldest)
        this.#persistentScopeKeys.delete(oldest)
      }
    }
    this.#sessionAllowlist.set(sessionScopeKey, Object.freeze({
      // The scope key embeds the workspace identity; the renderer only ever
      // sees this keyed digest, which supports nothing beyond revocation.
      id: createHmac('sha256', this.#digestKey).update(sessionScopeKey).digest('hex').slice(0, 32),
      ...scope
    }))
    if (persistent) {
      this.#persistentScopeKeys.add(sessionScopeKey)
      this.#queuePersistScopes()
    }
  }

  /**
   * Grants keyed by a stable workspace identity survive restarts; a token
   * that no longer resolves falls back to a token-scoped in-memory grant.
   */
  async #sessionScope(
    request: ReturnType<typeof normalizeApprovalRequest>
  ): Promise<{ key: string; persistent: boolean } | null> {
    if (SESSION_SCOPE_EXCLUDED_TOOLS.has(request.toolName)) return null
    let workspace = `token:${request.workspaceToken}`
    let persistent = false
    if (this.#resolveWorkspaceIdentity !== undefined) {
      try {
        const identity = await this.#resolveWorkspaceIdentity(request.workspaceToken)
        if (
          identity !== null &&
          typeof identity === 'object' &&
          typeof identity.device === 'string' &&
          typeof identity.inode === 'string' &&
          identity.device.length > 0 &&
          identity.device.length <= 128 &&
          identity.inode.length > 0 &&
          identity.inode.length <= 128
        ) {
          workspace = `id:${identity.device}:${identity.inode}`
          persistent = this.#persistence !== undefined
        }
      } catch {
        // Unresolvable identity degrades to a session-only grant.
      }
    }
    return {
      key: canonicalJson({
        v: 2,
        workspace,
        toolName: request.toolName,
        operation: request.operation,
        risk: request.risk
      }),
      persistent
    }
  }

  async #loadPersistedScopes(): Promise<void> {
    if (this.#persistence === undefined) return
    const raw = await this.#persistence.read()
    if (raw === null || typeof raw !== 'string' || raw.length > 256 * 1024) return
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return
    for (const entry of parsed.slice(0, MAX_SESSION_ALLOWLIST_ENTRIES)) {
      if (!isPersistedScopeEntry(entry) || this.#sessionAllowlist.has(entry.key)) continue
      this.#sessionAllowlist.set(entry.key, Object.freeze({
        id: createHmac('sha256', this.#digestKey).update(entry.key).digest('hex').slice(0, 32),
        toolName: entry.toolName,
        operation: entry.operation,
        risk: entry.risk
      }))
      this.#persistentScopeKeys.add(entry.key)
    }
  }

  #queuePersistScopes(): void {
    if (this.#persistence === undefined) return
    this.#persistTail = this.#persistTail
      .then(async () => {
        const entries: Array<{ key: string; toolName: string; operation: string; risk: string }> = []
        for (const [key, descriptor] of this.#sessionAllowlist) {
          if (!this.#persistentScopeKeys.has(key)) continue
          entries.push({
            key,
            toolName: descriptor.toolName,
            operation: descriptor.operation,
            risk: descriptor.risk
          })
        }
        await this.#persistence!.write(JSON.stringify(entries))
      })
      .catch(() => undefined)
  }

  #readNow(): number {
    const now = this.#now()
    if (!Number.isSafeInteger(now) || now < 0) throw new AgentApprovalError('invalid_configuration')
    return now
  }

  #emit(event: AgentEvent): void {
    try {
      this.#onEvent(event)
    } catch {
      // Approval state is authoritative even if Renderer delivery fails.
    }
  }
}

function normalizeApprovalRequest(request: AgentToolApprovalRequest): AgentToolApprovalRequest {
  if (!isPlainRecord(request)) throw new AgentApprovalError('invalid_request')
  const turnId = request.turnId
  const callId = request.callId
  const workspaceToken = request.workspaceToken
  const operation = request.operation
  const toolName = request.toolName
  const requestArguments = request.arguments
  const label = request.label
  const detail = request.detail
  const risk = request.risk
  const mode = request.mode
  const signal = request.signal
  if (
    typeof turnId !== 'string' ||
    !SAFE_ID_PATTERN.test(turnId) ||
    typeof callId !== 'string' ||
    !SAFE_ID_PATTERN.test(callId) ||
    typeof workspaceToken !== 'string' ||
    !WORKSPACE_TOKEN_PATTERN.test(workspaceToken) ||
    typeof operation !== 'string' ||
    !['read', 'enumerate', 'search', 'write', 'open', 'execute'].includes(operation) ||
    typeof toolName !== 'string' ||
    !TOOL_NAME_PATTERN.test(toolName) ||
    !isPlainRecord(requestArguments) ||
    typeof label !== 'string' ||
    label.length < 1 ||
    label.length > 1_024 ||
    (detail !== undefined && (
      typeof detail !== 'string' ||
      detail.length < 1 ||
      detail.length > MAX_APPROVAL_DETAIL_CHARACTERS ||
      detail.includes('\0')
    )) ||
    typeof risk !== 'string' ||
    !['low', 'medium', 'high'].includes(risk) ||
    typeof mode !== 'string' ||
    !['request', 'auto', 'full'].includes(mode) ||
    !isAbortSignal(signal)
  ) {
    throw new AgentApprovalError('invalid_request')
  }
  let argumentsSnapshot: Record<string, unknown>
  try {
    argumentsSnapshot = structuredClone(requestArguments)
  } catch {
    throw new AgentApprovalError('invalid_request')
  }
  if (!isPlainRecord(argumentsSnapshot)) throw new AgentApprovalError('invalid_request')
  assertJsonValue(argumentsSnapshot, 0, { nodes: 0 })
  freezeJsonValue(argumentsSnapshot)
  return Object.freeze({
    turnId,
    callId,
    workspaceToken,
    operation,
    toolName,
    arguments: argumentsSnapshot,
    label,
    ...(detail === undefined ? {} : { detail }),
    risk,
    mode,
    signal
  })
}

function isAuthorization(value: unknown): value is AgentToolAuthorization {
  return isPlainRecord(value) &&
    typeof value.approvalHandle === 'string' &&
    typeof value.workspaceToken === 'string' &&
    WORKSPACE_TOKEN_PATTERN.test(value.workspaceToken) &&
    typeof value.requestDigest === 'string' &&
    /^[a-f0-9]{64}$/u.test(value.requestDigest) &&
    typeof value.operation === 'string' &&
    ['read', 'enumerate', 'search', 'write', 'open', 'execute'].includes(value.operation) &&
    typeof value.decisionSource === 'string' &&
    ['user', 'session', 'policy', 'full'].includes(value.decisionSource)
}

/**
 * Session scope binds {workspace, tool, operation, risk} — not exact arguments —
 * so "always allow" covers subsequent calls of the same tool in the same
 * workspace while destructive removals stay excluded. See #sessionScope for
 * how the workspace component is derived.
 */
const SESSION_SCOPE_OPERATIONS = ['read', 'enumerate', 'search', 'write', 'open', 'execute'] as const
const SESSION_SCOPE_RISKS = ['low', 'medium', 'high'] as const

function isPersistedScopeEntry(value: unknown): value is {
  key: string
  toolName: string
  operation: LocalToolOperationCategory
  risk: 'low' | 'medium' | 'high'
} {
  if (!isPlainRecord(value)) return false
  const keys = Object.keys(value)
  return (
    keys.length === 4 &&
    ['key', 'toolName', 'operation', 'risk'].every((key) => Object.hasOwn(value, key)) &&
    typeof value.key === 'string' &&
    value.key.length >= 1 &&
    value.key.length <= 1_024 &&
    value.key.startsWith('{') &&
    typeof value.toolName === 'string' &&
    TOOL_NAME_PATTERN.test(value.toolName) &&
    !SESSION_SCOPE_EXCLUDED_TOOLS.has(value.toolName) &&
    typeof value.operation === 'string' &&
    (SESSION_SCOPE_OPERATIONS as readonly string[]).includes(value.operation) &&
    typeof value.risk === 'string' &&
    (SESSION_SCOPE_RISKS as readonly string[]).includes(value.risk)
  )
}

// Redaction can lengthen text; re-bound so the renderer event validator never drops the request.
function boundedApprovalDetail(detail: string): string {
  return detail.length <= MAX_APPROVAL_DETAIL_CHARACTERS
    ? detail
    : `${detail.slice(0, MAX_APPROVAL_DETAIL_CHARACTERS - 16)}\n…（已截断）`
}

function isPolicyAutoApprovable(
  operation: LocalToolOperationCategory,
  risk: AgentToolApprovalRequest['risk']
): boolean {
  if (risk === 'low') return ['read', 'enumerate', 'search'].includes(operation)
  if (risk === 'medium') return ['write', 'open', 'execute'].includes(operation)
  return false
}

const MAX_QUESTION_CHARACTERS = 1_024
const MAX_QUESTION_OPTIONS = 4
const MAX_QUESTION_OPTION_CHARACTERS = 256

// allowWhitespace keeps tab/newline legal inside a multi-line question while
// options stay single-line; 0x7f and the remaining C0 range always fail.
function containsQuestionControlCharacters(value: string, allowWhitespace: boolean): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code === 0x7f) return true
    if (code > 0x1f) continue
    if (allowWhitespace && (code === 0x09 || code === 0x0a || code === 0x0d)) continue
    return true
  }
  return false
}

function normalizeUserQuestion(request: {
  turnId: unknown
  question: unknown
  options: unknown
  signal: unknown
}): { turnId: string; question: string; options: string[]; signal: AbortSignal } {
  const { turnId, question, options, signal } = request
  if (
    typeof turnId !== 'string' ||
    !SAFE_ID_PATTERN.test(turnId) ||
    typeof question !== 'string' ||
    question.trim().length < 1 ||
    question.length > MAX_QUESTION_CHARACTERS ||
    containsQuestionControlCharacters(question, true) ||
    !Array.isArray(options) ||
    options.length < 2 ||
    options.length > MAX_QUESTION_OPTIONS ||
    !options.every((option) =>
      typeof option === 'string' &&
      option.trim().length >= 1 &&
      option.length <= MAX_QUESTION_OPTION_CHARACTERS &&
      !containsQuestionControlCharacters(option, false)
    ) ||
    !isAbortSignal(signal)
  ) {
    throw new AgentApprovalError('invalid_request')
  }
  return { turnId, question: question.trim(), options: options.map((option) => option.trim()), signal }
}

function issueApprovalId(records: ReadonlyMap<string, unknown>): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = `approval_${randomBytes(18).toString('base64url')}`
    if (!records.has(id)) return id
  }
  throw new AgentApprovalError('capacity_exceeded')
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

function assertJsonValue(value: unknown, depth: number, budget: { nodes: number }): void {
  budget.nodes += 1
  if (depth > 16 || budget.nodes > 4_096) throw new AgentApprovalError('invalid_request')
  if (value === null || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new AgentApprovalError('invalid_request')
    return
  }
  if (typeof value === 'string') {
    if (value.length > 64 * 1024 || value.includes('\0')) throw new AgentApprovalError('invalid_request')
    return
  }
  if (Array.isArray(value)) {
    for (const child of value) assertJsonValue(child, depth + 1, budget)
    return
  }
  if (!isPlainRecord(value)) throw new AgentApprovalError('invalid_request')
  for (const [key, child] of Object.entries(value)) {
    if (key.length > 128 || ['__proto__', 'prototype', 'constructor'].includes(key)) {
      throw new AgentApprovalError('invalid_request')
    }
    assertJsonValue(child, depth + 1, budget)
  }
}

function freezeJsonValue(value: unknown): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return
  for (const child of Array.isArray(value) ? value : Object.values(value)) freezeJsonValue(child)
  Object.freeze(value)
}

function isAbortSignal(value: unknown): value is AbortSignal {
  if (value === null || typeof value !== 'object') return false
  const signal = value as AbortSignal
  return typeof signal.aborted === 'boolean' &&
    typeof signal.addEventListener === 'function' &&
    typeof signal.removeEventListener === 'function'
}

function isBoundedTtl(value: unknown): value is number {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= MIN_APPROVAL_TTL_MS &&
    value <= MAX_APPROVAL_TTL_MS
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
