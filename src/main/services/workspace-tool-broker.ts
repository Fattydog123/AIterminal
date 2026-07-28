import type {
  AgentEvent,
  ApprovalMode,
  GitSummary,
  WorkspaceDirectoryResult,
  WorkspaceFileResult
} from '../../shared/contracts.ts'
import {
  containsSensitiveCredential,
  redactCredentialContent,
  redactSensitiveText
} from '../security/redaction.ts'
import { AgentApprovalService } from './agent-approval-service.ts'
import {
  normalizeWorkspaceCommandArgv,
  WorkspaceToolError,
  type LocalAccessScope,
  type WorkspaceCommandResult,
  type WorkspaceDeleteResult,
  type WorkspaceGitDiffResult,
  type WorkspaceGlobResult,
  type WorkspaceReplaceResult,
  type WorkspaceSearchResult
} from './workspace-tool-service.ts'
import {
  ResponsesClientError,
  type ResponsesFunctionToolCall,
  type ResponsesFunctionToolDefinition,
  type ResponsesJsonObject
} from './responses-client.ts'

export interface AgentWorkspaceToolService {
  listDirectory(
    input: { workspaceToken: string; relativePath: string },
    ownerWebContentsId: number,
    options?: { signal?: AbortSignal; accessScope?: LocalAccessScope }
  ): Promise<WorkspaceDirectoryResult>
  readFile(
    input: { workspaceToken: string; relativePath: string; startLine?: number; lineCount?: number },
    ownerWebContentsId: number,
    options?: { signal?: AbortSignal; accessScope?: LocalAccessScope }
  ): Promise<WorkspaceFileResult>
  gitSummary(
    input: { workspaceToken: string },
    ownerWebContentsId: number,
    options?: { signal?: AbortSignal; accessScope?: LocalAccessScope }
  ): Promise<GitSummary>
  gitDiff(
    input: { workspaceToken: string },
    ownerWebContentsId: number,
    options?: { signal?: AbortSignal; accessScope?: LocalAccessScope }
  ): Promise<WorkspaceGitDiffResult>
  writeFile(
    input: {
      workspaceToken: string
      relativePath: string
      content: string
      expectedRevision?: string
    },
    ownerWebContentsId: number,
    options?: { signal?: AbortSignal; accessScope?: LocalAccessScope }
  ): Promise<WorkspaceFileResult>
  searchFiles(
    input: {
      workspaceToken: string
      relativePath: string
      query: string
      caseSensitive: boolean
      regex?: boolean
    },
    ownerWebContentsId: number,
    options?: { signal?: AbortSignal; accessScope?: LocalAccessScope }
  ): Promise<WorkspaceSearchResult>
  globFiles(
    input: {
      workspaceToken: string
      relativePath: string
      pattern: string
    },
    ownerWebContentsId: number,
    options?: { signal?: AbortSignal; accessScope?: LocalAccessScope }
  ): Promise<WorkspaceGlobResult>
  replaceInFile(
    input: {
      workspaceToken: string
      relativePath: string
      oldText: string
      newText: string
      expectedRevision: string
    },
    ownerWebContentsId: number,
    options?: { signal?: AbortSignal; accessScope?: LocalAccessScope }
  ): Promise<WorkspaceReplaceResult>
  runCommand(
    input: {
      workspaceToken: string
      relativePath: string
      argv: readonly string[]
    },
    ownerWebContentsId: number,
    options?: { signal?: AbortSignal; accessScope?: LocalAccessScope }
  ): Promise<WorkspaceCommandResult>
  deletePath(
    input: {
      workspaceToken: string
      relativePath: string
      recursive: boolean
    },
    ownerWebContentsId: number,
    options?: { signal?: AbortSignal; accessScope?: LocalAccessScope }
  ): Promise<WorkspaceDeleteResult>
}

export type WorkspaceToolExposure = 'agent' | 'plan' | 'review' | 'delegated-read'

export interface WorkspaceToolBrokerOptions {
  readonly approvals: AgentApprovalService
  readonly workspaceTools: AgentWorkspaceToolService
  readonly onEvent: (event: AgentEvent) => void
}

export interface WorkspaceToolBrokerInvocation {
  readonly turnId: string
  readonly toolCall: ResponsesFunctionToolCall
  readonly workspaceToken: string
  readonly ownerWebContentsId: number
  readonly approvalMode: ApprovalMode
  /** Keeps an isolated worktree bounded even when its parent turn has full approval. */
  readonly accessScope?: LocalAccessScope
  readonly exposure: WorkspaceToolExposure
  readonly reviewDiffLoaded: boolean
  readonly signal: AbortSignal
  readonly apiKey: string
  /** Supplies the Agent runtime's fixed invalid-call error without a module cycle. */
  readonly invalidToolCall: () => Error
  readonly delegated?: {
    readonly taskIndex: number
    readonly toolOrdinal: number
  }
}

export interface WorkspaceToolBrokerResult {
  readonly ok: boolean
  readonly output: string
  /** True only after a successful, approved `git_diff` operation. */
  readonly activatedReviewDiff: boolean
}

const RELATIVE_PATH_MAX_CHARACTERS = 4_096
const SEARCH_QUERY_MAX_CHARACTERS = 4_096
// A "partial:" prefix marks a ranged or truncated read_file revision. It must
// pass lexical validation so the service can answer write_file with its
// guidance error instead of a generic invalid-call failure.
const EXPECTED_REVISION_PATTERN = /^(?:partial:)?[a-f0-9]{64}$/u
const MAX_TOOL_OUTPUT_BYTES = 384 * 1024
const MAX_SUBAGENT_TOOL_OUTPUT_BYTES = 96 * 1024
const OUTSIDE_WORKSPACE_TOOL_LABEL = '目标不在当前工作区'
const OUTSIDE_WORKSPACE_TOOL_FAILURE = 'tool_failed: The requested target is outside the current workspace. ' +
  'No local operation was performed. Select System Full Access or choose the target workspace, then retry.'
const INVALID_TOOL_CALL_LABEL = '无效工具调用'
const INVALID_TOOL_CALL_FAILURE = 'tool_failed: The model proposed an invalid local tool call. ' +
  'No local operation was performed. Retry using only the advertised local tools and their exact argument schema.'

const WORKSPACE_PATH_TOOL_NAMES = new Set([
  'list_directory',
  'search_files',
  'glob',
  'read_file',
  'delete_path',
  'write_file',
  'replace_in_file',
  'run_command'
])

const AGENT_TOOLS: readonly ResponsesFunctionToolDefinition[] = Object.freeze([
  Object.freeze({
    type: 'function',
    name: 'list_directory',
    description: 'List one non-recursive directory level. Absolute paths are available in System Full Access.',
    strict: false,
    parameters: {
      type: 'object',
      properties: {
        relative_path: {
          type: 'string',
          description: 'Workspace-relative directory path, or an absolute path in System Full Access. Use "." for the workspace root.'
        }
      },
      required: ['relative_path'],
      additionalProperties: false
    }
  }),
  Object.freeze({
    type: 'function',
    name: 'search_files',
    description: 'Recursively search eligible UTF-8 files for a bounded literal string or regular expression. Dependency and build directories are skipped unless the search is rooted inside one. Absolute paths are available in System Full Access.',
    strict: false,
    parameters: {
      type: 'object',
      properties: {
        relative_path: {
          type: 'string',
          description: 'Workspace-relative directory path, or an absolute path in System Full Access. Use "." for the workspace root.'
        },
        query: {
          type: 'string',
          description: 'Non-empty text to search for. Treated as a literal string unless regex is true.'
        },
        case_sensitive: {
          type: 'boolean',
          description: 'Whether letter casing must match exactly.'
        },
        regex: {
          type: 'boolean',
          description: 'Optional. Set true to treat query as a bounded regular expression supporting literals, ., [...], *, +, ?, {m,n}, |, ^, $, \\d \\w \\s \\b. Backreferences and lookarounds are not supported.'
        }
      },
      required: ['relative_path', 'query', 'case_sensitive'],
      additionalProperties: false
    }
  }),
  Object.freeze({
    type: 'function',
    name: 'glob',
    description: 'Find files by name pattern, newest first. Supports *, ?, **, [...], and {a,b}; a pattern without "/" matches file names at any depth. Dependency and build directories are skipped unless relative_path is rooted inside one.',
    strict: false,
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Relative glob pattern, e.g. "*.ts", "src/**/*.test.ts", or "config.{json,yaml}".'
        },
        relative_path: {
          type: 'string',
          description: 'Optional workspace-relative directory to search under; defaults to the workspace root. Absolute paths are available in System Full Access.'
        }
      },
      required: ['pattern'],
      additionalProperties: false
    }
  }),
  Object.freeze({
    type: 'function',
    name: 'read_file',
    description: 'Read one UTF-8 text file, optionally only a line range. Absolute paths are available in System Full Access. A ranged or truncated read returns a revision marked "partial:", which replace_in_file accepts but write_file rejects: read the whole file before replacing all of it.',
    strict: false,
    parameters: {
      type: 'object',
      properties: {
        relative_path: {
          type: 'string',
          description: 'Workspace-relative file path, or an absolute path in System Full Access.'
        },
        start_line: {
          type: 'integer',
          description: 'Optional 1-based first line to return. Use with line_count to read part of a large file.'
        },
        line_count: {
          type: 'integer',
          description: 'Optional maximum number of lines to return starting at start_line.'
        }
      },
      required: ['relative_path'],
      additionalProperties: false
    }
  }),
  Object.freeze({
    type: 'function',
    name: 'delete_path',
    description: 'Delete one local file or directory. In System Full Access, path may be absolute or outside the selected workspace; set recursive to true for a directory and use this tool instead of guessing a shell command.',
    strict: false,
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Local file or directory path. It may be absolute, use parent traversal, or point outside the selected workspace in System Full Access.'
        },
        recursive: {
          type: 'boolean',
          description: 'Set true only when deleting a directory and its contents.'
        }
      },
      required: ['path', 'recursive'],
      additionalProperties: false
    }
  }),
  Object.freeze({
    type: 'function',
    name: 'git_summary',
    description: 'Read the current Git branch and bounded working-tree change statistics.',
    strict: false,
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  }),
  Object.freeze({
    type: 'function',
    name: 'git_diff',
    description: 'Read a bounded, redacted patch for safe tracked changes in the selected workspace.',
    strict: false,
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  }),
  Object.freeze({
    type: 'function',
    name: 'run_command',
    description: 'Run one bounded argv command. System Full Access permits absolute working directories, absolute arguments, and explicit shell executables.',
    strict: false,
    parameters: {
      type: 'object',
      properties: {
        relative_path: {
          type: 'string',
          description: 'Workspace-relative working directory, or an absolute directory in System Full Access. Use "." for the workspace root.'
        },
        argv: {
          type: 'array',
          minItems: 1,
          maxItems: 64,
          items: {
            type: 'string',
            description: 'One executable or argument. Shell command strings are not supported.'
          }
        }
      },
      required: ['relative_path', 'argv'],
      additionalProperties: false
    }
  }),
  Object.freeze({
    type: 'function',
    name: 'write_file',
    description: 'Create or atomically replace one UTF-8 text file. Absolute paths are available in System Full Access.',
    strict: false,
    parameters: {
      type: 'object',
      properties: {
        relative_path: {
          type: 'string',
          description: 'Workspace-relative file path, or an absolute path in System Full Access.'
        },
        content: { type: 'string', description: 'Complete UTF-8 file content to write.' },
        expected_revision: {
          type: 'string',
          description: 'Required SHA-256 revision returned by read_file when replacing an existing file. A "partial:" revision cannot authorize replacing the whole file; read the file without a line range first.'
        }
      },
      required: ['relative_path', 'content'],
      additionalProperties: false
    }
  }),
  Object.freeze({
    type: 'function',
    name: 'replace_in_file',
    description: 'Atomically replace exactly one literal match in an existing UTF-8 file. Absolute paths are available in System Full Access.',
    strict: false,
    parameters: {
      type: 'object',
      properties: {
        relative_path: {
          type: 'string',
          description: 'Workspace-relative file path, or an absolute path in System Full Access.'
        },
        old_text: {
          type: 'string',
          description: 'Non-empty literal text that must occur exactly once in the current file.'
        },
        new_text: { type: 'string', description: 'Replacement text for the unique literal match.' },
        expected_revision: {
          type: 'string',
          description: 'Required revision returned by read_file for the current file. A "partial:" revision from a ranged or truncated read is accepted.'
        }
      },
      required: ['relative_path', 'old_text', 'new_text', 'expected_revision'],
      additionalProperties: false
    }
  })
])

const PLAN_TOOLS: readonly ResponsesFunctionToolDefinition[] = Object.freeze(
  AGENT_TOOLS.filter((tool) =>
    tool.name !== 'git_diff' &&
    tool.name !== 'run_command' &&
    tool.name !== 'delete_path' &&
    tool.name !== 'write_file' &&
    tool.name !== 'replace_in_file'
  )
)

const REVIEW_TOOLS: readonly ResponsesFunctionToolDefinition[] = Object.freeze(
  AGENT_TOOLS.filter((tool) =>
    tool.name === 'list_directory' ||
    tool.name === 'search_files' ||
    tool.name === 'glob' ||
    tool.name === 'read_file' ||
    tool.name === 'git_summary' ||
    tool.name === 'git_diff'
  )
)

const DELEGATED_READ_TOOLS: readonly ResponsesFunctionToolDefinition[] = Object.freeze(
  AGENT_TOOLS.filter((tool) =>
    tool.name === 'list_directory' ||
    tool.name === 'search_files' ||
    tool.name === 'glob' ||
    tool.name === 'read_file'
  )
)

const DELEGATED_READ_TOOL_NAMES = new Set(DELEGATED_READ_TOOLS.map((tool) => tool.name))

export function workspaceToolDefinitions(
  exposure: WorkspaceToolExposure
): readonly ResponsesFunctionToolDefinition[] {
  switch (exposure) {
    case 'agent': return AGENT_TOOLS
    case 'plan': return PLAN_TOOLS
    case 'review': return REVIEW_TOOLS
    case 'delegated-read': return DELEGATED_READ_TOOLS
  }
}

export class WorkspaceToolBroker {
  readonly #approvals: AgentApprovalService
  readonly #workspaceTools: AgentWorkspaceToolService
  readonly #onEvent: (event: AgentEvent) => void
  #disposed = false

  constructor(options: WorkspaceToolBrokerOptions) {
    if (
      !options ||
      typeof options !== 'object' ||
      !(options.approvals instanceof AgentApprovalService) ||
      typeof options.workspaceTools?.listDirectory !== 'function' ||
      typeof options.workspaceTools?.readFile !== 'function' ||
      typeof options.workspaceTools?.gitSummary !== 'function' ||
      typeof options.workspaceTools?.gitDiff !== 'function' ||
      typeof options.workspaceTools?.writeFile !== 'function' ||
      typeof options.workspaceTools?.searchFiles !== 'function' ||
      typeof options.workspaceTools?.globFiles !== 'function' ||
      typeof options.workspaceTools?.replaceInFile !== 'function' ||
      typeof options.workspaceTools?.runCommand !== 'function' ||
      typeof options.workspaceTools?.deletePath !== 'function' ||
      typeof options.onEvent !== 'function'
    ) {
      throw new Error('Workspace tool broker configuration is invalid.')
    }
    this.#approvals = options.approvals
    this.#workspaceTools = options.workspaceTools
    this.#onEvent = options.onEvent
  }

  definitions(exposure: WorkspaceToolExposure): readonly ResponsesFunctionToolDefinition[] {
    return workspaceToolDefinitions(exposure)
  }

  resolveApproval(approvalId: unknown, decision: unknown): boolean {
    return this.#approvals.resolve(approvalId, decision)
  }

  cancelTurn(turnId: string): void {
    this.#approvals.cancelTurn(turnId)
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#approvals.dispose()
  }

  async dispatch(input: WorkspaceToolBrokerInvocation): Promise<WorkspaceToolBrokerResult> {
    if (this.#disposed) throw input.invalidToolCall()
    const accessScope: LocalAccessScope = input.accessScope ?? (
      input.approvalMode === 'full' ? 'system' : 'workspace'
    )
    const delegated = input.delegated
    const callId = delegated === undefined
      ? input.toolCall.callId
      : `subagent:${delegated.taskIndex + 1}:tool:${delegated.toolOrdinal}`
    const fixedLabel = delegated === undefined
      ? undefined
      : `只读子任务 ${delegated.taskIndex + 1} 操作 ${delegated.toolOrdinal}`
    const emitFailure = (label: string): void => {
      this.#emit({ type: 'tool-status', turnId: input.turnId, callId, label, status: 'failed' })
    }

    if (input.exposure === 'delegated-read' && !DELEGATED_READ_TOOL_NAMES.has(input.toolCall.name)) {
      emitFailure(fixedLabel!)
      throw input.invalidToolCall()
    }
    if (accessScope === 'workspace' && hasOutsideWorkspaceTarget(input.toolCall)) {
      emitFailure(fixedLabel ?? OUTSIDE_WORKSPACE_TOOL_LABEL)
      return { ok: false, output: OUTSIDE_WORKSPACE_TOOL_FAILURE, activatedReviewDiff: false }
    }

    let proposal: WorkspaceToolProposal
    try {
      proposal = parseWorkspaceToolProposal(input.toolCall, accessScope, input.invalidToolCall)
      if (
        input.exposure === 'delegated-read' &&
        (!isReadOnlyToolProposal(proposal) ||
          !isSafeDelegatedToolProposal(proposal, input.apiKey, accessScope))
      ) {
        throw input.invalidToolCall()
      }
    } catch {
      emitFailure(fixedLabel ?? INVALID_TOOL_CALL_LABEL)
      if (input.exposure === 'delegated-read') throw input.invalidToolCall()
      return { ok: false, output: INVALID_TOOL_CALL_FAILURE, activatedReviewDiff: false }
    }

    const label = fixedLabel ?? proposal.label
    if (input.exposure === 'review' && !isReviewToolProposal(proposal)) {
      emitFailure(label)
      return {
        ok: false,
        output: 'Code review mode blocks file writes, commands, and delegation. No local operation was performed.',
        activatedReviewDiff: false
      }
    }
    if (input.exposure === 'review' && !input.reviewDiffLoaded && proposal.kind !== 'git_diff') {
      emitFailure(label)
      return {
        ok: false,
        output: 'Code review must load the approved Git diff before any additional workspace context.',
        activatedReviewDiff: false
      }
    }
    if (
      accessScope !== 'system' && (
        (proposal.kind === 'write_file' && containsTurnCredential(proposal.content, input.apiKey)) ||
        (proposal.kind === 'replace_in_file' && containsTurnCredential(proposal.newText, input.apiKey))
      )
    ) {
      emitFailure(label)
      return {
        ok: false,
        output: 'Local credential policy denied this write before approval. No local operation was performed.',
        activatedReviewDiff: false
      }
    }
    if (input.exposure === 'plan' && !['read', 'enumerate', 'search'].includes(proposal.operation)) {
      emitFailure(label)
      return {
        ok: false,
        output: 'Plan mode blocks file writes and command execution. No local operation was performed.',
        activatedReviewDiff: false
      }
    }

    const authorization = await this.#approvals.authorize({
      turnId: input.turnId,
      callId,
      workspaceToken: input.workspaceToken,
      operation: proposal.operation,
      toolName: input.toolCall.name,
      arguments: input.toolCall.arguments,
      label: delegated === undefined ? proposal.label : `只读子任务 ${delegated.taskIndex + 1}：${proposal.label}`,
      ...(delegated === undefined && approvalDetail(proposal) !== null
        ? { detail: approvalDetail(proposal)! }
        : {}),
      risk: delegated === undefined ? proposal.risk : 'low',
      mode: input.approvalMode,
      signal: input.signal
    })
    throwIfCancelled(input.signal)
    if (!authorization) {
      emitFailure(label)
      return {
        ok: false,
        output: delegated === undefined
          ? 'The user or local policy denied this exact local tool call. No local operation was performed.'
          : 'The user or local policy denied this exact subagent read. No local operation was performed.',
        activatedReviewDiff: false
      }
    }
    if (!this.#approvals.consume(authorization)) throw input.invalidToolCall()

    this.#emit({
      type: 'turn-status',
      turnId: input.turnId,
      status: 'running',
      message: delegated === undefined
        ? accessScope === 'system' ? '正在执行系统操作。' : '正在执行工作区操作。'
        : '子智能体正在处理任务。'
    })
    this.#emit({ type: 'tool-status', turnId: input.turnId, callId, label, status: 'running' })

    try {
      const execution = await this.#executeProposal(proposal, input)
      if (!execution.committedWrite) throwIfCancelled(input.signal)
      const output = delegated === undefined
        ? boundToolOutput(redactWorkspaceToolOutput(execution.rawOutput, input.apiKey, accessScope))
        : boundUtf8Text(
            redactWorkspaceToolOutput(execution.rawOutput, input.apiKey, accessScope),
            MAX_SUBAGENT_TOOL_OUTPUT_BYTES,
            '\n[subagent tool output truncated by local safety limit]'
          )
      this.#emit({ type: 'tool-status', turnId: input.turnId, callId, label, status: 'completed' })
      return {
        ok: true,
        output: output || (delegated === undefined
          ? 'The approved local tool completed without displayable output.'
          : 'The approved read-only subagent tool completed without displayable output.'),
        activatedReviewDiff: proposal.kind === 'git_diff'
      }
    } catch (error) {
      if (isCancellation(error) || isWorkspaceToolCancellation(error) || input.signal.aborted) {
        throw new ResponsesClientError('cancelled')
      }
      emitFailure(label)
      return { ok: false, output: fixedWorkspaceToolFailure(error), activatedReviewDiff: false }
    }
  }

  async #executeProposal(
    proposal: WorkspaceToolProposal,
    input: WorkspaceToolBrokerInvocation
  ): Promise<{ rawOutput: string; committedWrite: boolean }> {
    const ownerWebContentsId = input.ownerWebContentsId
    const workspaceToken = input.workspaceToken
    const accessScope: LocalAccessScope = input.accessScope ?? (
      input.approvalMode === 'full' ? 'system' : 'workspace'
    )
    const options = { signal: input.signal, accessScope }
    if (proposal.kind === 'list_directory') {
      return {
        rawOutput: formatListDirectoryResult(await this.#workspaceTools.listDirectory(
          { workspaceToken, relativePath: proposal.relativePath }, ownerWebContentsId, options
        )),
        committedWrite: false
      }
    }
    if (proposal.kind === 'search_files') {
      return {
        rawOutput: formatSearchFilesResult(await this.#workspaceTools.searchFiles({
          workspaceToken,
          relativePath: proposal.relativePath,
          query: proposal.query,
          caseSensitive: proposal.caseSensitive,
          ...(proposal.regex ? { regex: true } : {})
        }, ownerWebContentsId, options)),
        committedWrite: false
      }
    }
    if (proposal.kind === 'glob') {
      return {
        rawOutput: formatGlobResult(await this.#workspaceTools.globFiles({
          workspaceToken,
          relativePath: proposal.relativePath,
          pattern: proposal.pattern
        }, ownerWebContentsId, options)),
        committedWrite: false
      }
    }
    if (proposal.kind === 'read_file') {
      return {
        rawOutput: formatReadFileResult(await this.#workspaceTools.readFile(
          {
            workspaceToken,
            relativePath: proposal.relativePath,
            ...(proposal.startLine === undefined ? {} : { startLine: proposal.startLine }),
            ...(proposal.lineCount === undefined ? {} : { lineCount: proposal.lineCount })
          },
          ownerWebContentsId,
          options
        )),
        committedWrite: false
      }
    }
    if (proposal.kind === 'git_summary') {
      return {
        rawOutput: formatGitSummary(await this.#workspaceTools.gitSummary({ workspaceToken }, ownerWebContentsId, options)),
        committedWrite: false
      }
    }
    if (proposal.kind === 'git_diff') {
      return {
        rawOutput: formatGitDiff(await this.#workspaceTools.gitDiff({ workspaceToken }, ownerWebContentsId, options)),
        committedWrite: false
      }
    }
    if (proposal.kind === 'run_command') {
      return {
        rawOutput: formatRunCommandResult(await this.#workspaceTools.runCommand({
          workspaceToken,
          relativePath: proposal.relativePath,
          argv: proposal.argv
        }, ownerWebContentsId, options)),
        committedWrite: false
      }
    }
    if (proposal.kind === 'delete_path') {
      return {
        rawOutput: formatDeletePathResult(await this.#workspaceTools.deletePath({
          workspaceToken,
          relativePath: proposal.relativePath,
          recursive: proposal.recursive
        }, ownerWebContentsId, options)),
        committedWrite: true
      }
    }
    if (proposal.kind === 'write_file') {
      return {
        rawOutput: formatWriteFileResult(await this.#workspaceTools.writeFile({
          workspaceToken,
          relativePath: proposal.relativePath,
          content: proposal.content,
          ...(proposal.expectedRevision === undefined ? {} : { expectedRevision: proposal.expectedRevision })
        }, ownerWebContentsId, options)),
        committedWrite: true
      }
    }
    return {
      rawOutput: formatReplaceInFileResult(await this.#workspaceTools.replaceInFile({
        workspaceToken,
        relativePath: proposal.relativePath,
        oldText: proposal.oldText,
        newText: proposal.newText,
        expectedRevision: proposal.expectedRevision
      }, ownerWebContentsId, options)),
      committedWrite: true
    }
  }

  #emit(event: AgentEvent): void {
    try {
      this.#onEvent(event)
    } catch {
      // Renderer delivery must not affect authorization or local execution.
    }
  }
}

type WorkspaceToolProposal =
  | { kind: 'list_directory'; operation: 'enumerate'; relativePath: string; label: string; risk: 'low' }
  | { kind: 'search_files'; operation: 'search'; relativePath: string; query: string; caseSensitive: boolean; regex: boolean; label: string; risk: 'low' }
  | { kind: 'glob'; operation: 'search'; relativePath: string; pattern: string; label: string; risk: 'low' }
  | { kind: 'read_file'; operation: 'read'; relativePath: string; startLine?: number; lineCount?: number; label: string; risk: 'low' }
  | { kind: 'git_summary'; operation: 'enumerate'; label: string; risk: 'low' }
  | { kind: 'git_diff'; operation: 'execute'; label: string; risk: 'medium' }
  | { kind: 'run_command'; operation: 'execute'; relativePath: string; argv: readonly string[]; label: string; risk: 'high' }
  | { kind: 'delete_path'; operation: 'write'; relativePath: string; recursive: boolean; label: string; risk: 'high' }
  | { kind: 'write_file'; operation: 'write'; relativePath: string; content: string; expectedRevision?: string; label: string; risk: 'medium' }
  | { kind: 'replace_in_file'; operation: 'write'; relativePath: string; oldText: string; newText: string; expectedRevision: string; label: string; risk: 'medium' }

type ReadOnlyToolProposal = Extract<
  WorkspaceToolProposal,
  { kind: 'list_directory' | 'search_files' | 'glob' | 'read_file' }
>

function parseWorkspaceToolProposal(
  toolCall: ResponsesFunctionToolCall,
  accessScope: LocalAccessScope,
  invalidToolCall: () => Error
): WorkspaceToolProposal {
  const argumentsValue = toolCall.arguments
  if (toolCall.name === 'list_directory') {
    if (!hasExactKeys(argumentsValue, ['relative_path']) || typeof argumentsValue.relative_path !== 'string') {
      throw invalidToolCall()
    }
    const relativePath = normalizeLexicalDirectoryPath(argumentsValue.relative_path, accessScope, invalidToolCall)
    return { kind: 'list_directory', operation: 'enumerate', relativePath, label: `查看本地目录：${relativePath}`, risk: 'low' }
  }
  if (toolCall.name === 'read_file') {
    if (
      !hasOnlyAllowedKeys(argumentsValue, ['relative_path', 'start_line', 'line_count']) ||
      typeof argumentsValue.relative_path !== 'string' ||
      !isOptionalReadLine(argumentsValue.start_line) ||
      !isOptionalReadLine(argumentsValue.line_count)
    ) {
      throw invalidToolCall()
    }
    const relativePath = normalizeLexicalRelativePath(argumentsValue.relative_path, accessScope, invalidToolCall)
    const startLine = argumentsValue.start_line as number | undefined
    const lineCount = argumentsValue.line_count as number | undefined
    const range = startLine === undefined && lineCount === undefined
      ? ''
      : `（第 ${startLine ?? 1} 行起${lineCount === undefined ? '' : `，共 ${lineCount} 行`}）`
    return {
      kind: 'read_file',
      operation: 'read',
      relativePath,
      ...(startLine === undefined ? {} : { startLine }),
      ...(lineCount === undefined ? {} : { lineCount }),
      label: `读取本地文件：${relativePath}${range}`,
      risk: 'low'
    }
  }
  if (toolCall.name === 'search_files') {
    if (
      !hasOnlyAllowedKeys(argumentsValue, ['relative_path', 'query', 'case_sensitive', 'regex']) ||
      !Object.hasOwn(argumentsValue, 'relative_path') ||
      !Object.hasOwn(argumentsValue, 'query') ||
      !Object.hasOwn(argumentsValue, 'case_sensitive') ||
      (argumentsValue.regex !== undefined && typeof argumentsValue.regex !== 'boolean') ||
      typeof argumentsValue.relative_path !== 'string' ||
      typeof argumentsValue.query !== 'string' ||
      argumentsValue.query.length < 1 ||
      argumentsValue.query.length > SEARCH_QUERY_MAX_CHARACTERS ||
      /[\r\n\u0000-\u001f\u007f]/u.test(argumentsValue.query) ||
      typeof argumentsValue.case_sensitive !== 'boolean'
    ) throw invalidToolCall()
    const relativePath = normalizeLexicalDirectoryPath(argumentsValue.relative_path, accessScope, invalidToolCall)
    const useRegex = argumentsValue.regex === true
    return {
      kind: 'search_files',
      operation: 'search',
      relativePath,
      query: argumentsValue.query,
      caseSensitive: argumentsValue.case_sensitive,
      regex: useRegex,
      label: useRegex ? `正则搜索本地文件：${relativePath}` : `搜索本地文件：${relativePath}`,
      risk: 'low'
    }
  }
  if (toolCall.name === 'glob') {
    if (
      !hasOnlyAllowedKeys(argumentsValue, ['pattern', 'relative_path']) ||
      !Object.hasOwn(argumentsValue, 'pattern') ||
      typeof argumentsValue.pattern !== 'string' ||
      argumentsValue.pattern.length < 1 ||
      argumentsValue.pattern.length > SEARCH_QUERY_MAX_CHARACTERS ||
      argumentsValue.pattern.includes('\0') ||
      (argumentsValue.relative_path !== undefined && typeof argumentsValue.relative_path !== 'string')
    ) throw invalidToolCall()
    const relativePath = argumentsValue.relative_path === undefined
      ? '.'
      : normalizeLexicalDirectoryPath(argumentsValue.relative_path, accessScope, invalidToolCall)
    return {
      kind: 'glob',
      operation: 'search',
      relativePath,
      pattern: argumentsValue.pattern,
      label: relativePath === '.'
        ? `匹配文件名：${argumentsValue.pattern}`
        : `匹配文件名：${argumentsValue.pattern}（于 ${relativePath}）`,
      risk: 'low'
    }
  }
  if (toolCall.name === 'git_summary') {
    if (!hasExactKeys(argumentsValue, [])) throw invalidToolCall()
    return { kind: 'git_summary', operation: 'enumerate', label: '读取当前工作区的 Git 状态摘要', risk: 'low' }
  }
  if (toolCall.name === 'git_diff') {
    if (!hasExactKeys(argumentsValue, [])) throw invalidToolCall()
    return { kind: 'git_diff', operation: 'execute', label: '读取代码审查所需的 Git 变更', risk: 'medium' }
  }
  if (toolCall.name === 'run_command') {
    if (!hasExactKeys(argumentsValue, ['relative_path', 'argv']) || typeof argumentsValue.relative_path !== 'string') {
      throw invalidToolCall()
    }
    const relativePath = normalizeLexicalDirectoryPath(argumentsValue.relative_path, accessScope, invalidToolCall)
    let argv: readonly string[]
    try {
      argv = normalizeWorkspaceCommandArgv(argumentsValue.argv, accessScope)
    } catch {
      throw invalidToolCall()
    }
    return { kind: 'run_command', operation: 'execute', relativePath, argv, label: commandApprovalLabel(argv), risk: 'high' }
  }
  if (toolCall.name === 'delete_path') {
    const usesCanonicalPath = hasExactKeys(toolCall.arguments, ['path', 'recursive'])
    const usesLegacyPath = hasExactKeys(toolCall.arguments, ['relative_path', 'recursive'])
    const pathValue = usesCanonicalPath
      ? toolCall.arguments.path
      : usesLegacyPath
        ? toolCall.arguments.relative_path
        : undefined
    if (typeof pathValue !== 'string' || typeof toolCall.arguments.recursive !== 'boolean') {
      throw invalidToolCall()
    }
    const relativePath = normalizeLexicalDirectoryPath(
      pathValue,
      accessScope,
      invalidToolCall
    )
    return {
      kind: 'delete_path',
      operation: 'write',
      relativePath,
      recursive: toolCall.arguments.recursive,
      label: `删除本地路径：${relativePath}`,
      risk: 'high'
    }
  }
  if (toolCall.name === 'write_file') {
    const keys = Object.keys(argumentsValue)
    if (
      !keys.every((key) => ['relative_path', 'content', 'expected_revision'].includes(key)) ||
      !Object.hasOwn(argumentsValue, 'relative_path') ||
      !Object.hasOwn(argumentsValue, 'content') ||
      typeof argumentsValue.relative_path !== 'string' ||
      typeof argumentsValue.content !== 'string' ||
      (argumentsValue.expected_revision !== undefined && (
        typeof argumentsValue.expected_revision !== 'string' ||
        !EXPECTED_REVISION_PATTERN.test(argumentsValue.expected_revision)
      ))
    ) throw invalidToolCall()
    const relativePath = normalizeLexicalRelativePath(argumentsValue.relative_path, accessScope, invalidToolCall)
    return {
      kind: 'write_file',
      operation: 'write',
      relativePath,
      content: argumentsValue.content,
      ...(argumentsValue.expected_revision === undefined ? {} : { expectedRevision: argumentsValue.expected_revision }),
      label: `${argumentsValue.expected_revision ? '更新' : '创建'}本地文件：${relativePath}`,
      risk: 'medium'
    }
  }
  if (toolCall.name === 'replace_in_file') {
    if (
      !hasExactKeys(argumentsValue, ['relative_path', 'old_text', 'new_text', 'expected_revision']) ||
      typeof argumentsValue.relative_path !== 'string' ||
      typeof argumentsValue.old_text !== 'string' ||
      argumentsValue.old_text.length < 1 ||
      argumentsValue.old_text.includes('\0') ||
      typeof argumentsValue.new_text !== 'string' ||
      argumentsValue.new_text.includes('\0') ||
      typeof argumentsValue.expected_revision !== 'string' ||
      !EXPECTED_REVISION_PATTERN.test(argumentsValue.expected_revision)
    ) throw invalidToolCall()
    const relativePath = normalizeLexicalRelativePath(argumentsValue.relative_path, accessScope, invalidToolCall)
    return {
      kind: 'replace_in_file',
      operation: 'write',
      relativePath,
      oldText: argumentsValue.old_text,
      newText: argumentsValue.new_text,
      expectedRevision: argumentsValue.expected_revision,
      label: `替换本地文件内容：${relativePath}`,
      risk: 'medium'
    }
  }
  throw invalidToolCall()
}

function isReadOnlyToolProposal(proposal: WorkspaceToolProposal): proposal is ReadOnlyToolProposal {
  return proposal.kind === 'list_directory' ||
    proposal.kind === 'search_files' ||
    proposal.kind === 'glob' ||
    proposal.kind === 'read_file'
}

function isReviewToolProposal(proposal: WorkspaceToolProposal): boolean {
  return proposal.kind === 'list_directory' ||
    proposal.kind === 'search_files' ||
    proposal.kind === 'glob' ||
    proposal.kind === 'read_file' ||
    proposal.kind === 'git_summary' ||
    proposal.kind === 'git_diff'
}

function isSafeDelegatedToolProposal(
  proposal: ReadOnlyToolProposal,
  apiKey: string,
  accessScope: LocalAccessScope
): boolean {
  if (containsUnsafeDelegatedText(proposal.relativePath, apiKey, accessScope)) return false
  if (proposal.kind === 'search_files') return !containsUnsafeDelegatedText(proposal.query, apiKey, accessScope)
  if (proposal.kind === 'glob') return !containsUnsafeDelegatedText(proposal.pattern, apiKey, accessScope)
  return true
}

function containsUnsafeDelegatedText(
  value: string,
  apiKey: string,
  accessScope: LocalAccessScope
): boolean {
  return containsTurnCredential(value, apiKey) ||
    (accessScope === 'workspace' && containsAbsolutePathReference(value)) ||
    /(?:\[|<)\s*(?:system|developer|assistant)\s*(?:\]|>)/iu.test(value) ||
    /ignore\s+(?:all\s+)?(?:previous|prior)\s+instructions/iu.test(value)
}

function containsAbsolutePathReference(value: string): boolean {
  const normalized = value.replaceAll('\\', '/')
  return /(?:^|\s)[A-Za-z]:\//u.test(normalized) ||
    /(?:^|\s)\/{1,2}(?!\s)/u.test(normalized) ||
    normalized.includes('../') || normalized.includes('/..')
}

function hasOutsideWorkspaceTarget(toolCall: ResponsesFunctionToolCall): boolean {
  if (!WORKSPACE_PATH_TOOL_NAMES.has(toolCall.name)) return false
  const relativePath = toolCall.name === 'delete_path'
    ? toolCall.arguments.path ?? toolCall.arguments.relative_path
    : toolCall.arguments.relative_path
  if (typeof relativePath !== 'string') return false
  const normalized = relativePath.replaceAll('\\', '/')
  return /^[A-Za-z]:/u.test(normalized) || normalized.startsWith('/') || normalized.split('/').includes('..')
}

function normalizeLexicalRelativePath(
  value: string,
  accessScope: LocalAccessScope,
  invalidToolCall: () => Error
): string {
  if (accessScope === 'system') return normalizeLexicalSystemPath(value, false, invalidToolCall)
  if (
    value.length < 1 ||
    value.length > RELATIVE_PATH_MAX_CHARACTERS ||
    value.includes('\0') ||
    /[\r\n]/u.test(value) ||
    /^[A-Za-z]:/u.test(value) ||
    /^[/\\]/u.test(value) ||
    value.includes(':')
  ) throw invalidToolCall()
  const segments = value.replaceAll('\\', '/').split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.endsWith('.') || segment.endsWith(' '))) {
    throw invalidToolCall()
  }
  return segments.join('/')
}

function normalizeLexicalDirectoryPath(
  value: string,
  accessScope: LocalAccessScope,
  invalidToolCall: () => Error
): string {
  if (accessScope === 'system') return normalizeLexicalSystemPath(value, true, invalidToolCall)
  return value === '.' ? '.' : normalizeLexicalRelativePath(value, accessScope, invalidToolCall)
}

function normalizeLexicalSystemPath(
  value: string,
  allowCurrentDirectory: boolean,
  invalidToolCall: () => Error
): string {
  if (
    value.length < 1 ||
    value.length > RELATIVE_PATH_MAX_CHARACTERS ||
    value.includes('\0') ||
    /[\r\n]/u.test(value) ||
    (!allowCurrentDirectory && value === '.')
  ) {
    throw invalidToolCall()
  }
  return value
}

function hasExactKeys(value: ResponsesJsonObject, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

/** Every present key must be allowed; optional keys may be absent. */
function hasOnlyAllowedKeys(value: ResponsesJsonObject, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}

function isOptionalReadLine(value: unknown): boolean {
  return value === undefined || (Number.isSafeInteger(value) && (value as number) >= 1)
}

function commandApprovalLabel(argv: readonly string[]): string {
  return '运行工作区命令：' + redactSensitiveText(argv.join(' '))
}

const MAX_APPROVAL_DETAIL_CHARACTERS = 8 * 1024
const MAX_APPROVAL_PREVIEW_LINES = 40

/**
 * Human-reviewable preview shown inside the approval dialog. Content passes
 * through the shared redaction layer again at the emit boundary; this only
 * shapes and bounds what a user needs to judge the exact operation.
 */
function approvalDetail(proposal: WorkspaceToolProposal): string | null {
  switch (proposal.kind) {
    case 'run_command':
      return boundApprovalDetail([
        `$ ${proposal.argv.join(' ')}`,
        `工作目录：${proposal.relativePath === '.' ? '（工作区根目录）' : proposal.relativePath}`
      ].join('\n'))
    case 'write_file':
      return boundApprovalDetail(
        `写入 ${proposal.relativePath}（${Buffer.byteLength(proposal.content, 'utf8')} 字节）：\n` +
        previewLines(proposal.content)
      )
    case 'replace_in_file':
      return boundApprovalDetail([
        `替换 ${proposal.relativePath} 中的内容：`,
        '--- 原文',
        previewLines(proposal.oldText),
        '+++ 替换为',
        previewLines(proposal.newText)
      ].join('\n'))
    case 'delete_path':
      return boundApprovalDetail(
        `删除 ${proposal.relativePath}${proposal.recursive ? '（包含其所有子目录和文件）' : ''}`
      )
    default:
      return null
  }
}

function previewLines(content: string): string {
  const lines = content.split('\n')
  if (lines.length <= MAX_APPROVAL_PREVIEW_LINES) return content
  return [
    ...lines.slice(0, MAX_APPROVAL_PREVIEW_LINES),
    `…（其余 ${lines.length - MAX_APPROVAL_PREVIEW_LINES} 行已省略）`
  ].join('\n')
}

function boundApprovalDetail(detail: string): string {
  return boundUtf8Text(detail.replaceAll('\0', ''), MAX_APPROVAL_DETAIL_CHARACTERS, '\n…（预览已截断）')
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new ResponsesClientError('cancelled')
}

function isCancellation(error: unknown): boolean {
  return error instanceof ResponsesClientError && error.code === 'cancelled'
}

export function isWorkspaceToolCancellation(error: unknown): boolean {
  return error instanceof WorkspaceToolError && error.code === 'cancelled'
}

function fixedWorkspaceToolFailure(error: unknown): string {
  const code = error instanceof WorkspaceToolError
    ? fixedWorkspaceToolFailureCode(error.code)
    : 'unavailable'
  return JSON.stringify({ ok: false, code })
}

function fixedWorkspaceToolFailureCode(code: WorkspaceToolError['code']): string {
  // Distinct from a revision conflict: retrying is useless until the model
  // re-reads the file without a line range.
  if (code === 'partial_revision') return 'partial_read_revision'
  if (code === 'invalid_pattern') return 'invalid_pattern'
  if (code === 'write_conflict' || code === 'workspace_changed') return 'revision_conflict'
  if (code === 'path_not_found' || code === 'path_not_file' || code === 'path_not_directory') return 'not_found'
  if (
    code === 'sensitive_path' ||
    code === 'path_outside_workspace' ||
    code === 'reparse_point_rejected' ||
    code === 'hard_link_rejected' ||
    code === 'write_not_allowed' ||
    code === 'invalid_relative_path' ||
    code === 'command_rejected'
  ) return 'protected_path'
  if (code === 'file_too_large' || code === 'git_output_too_large' || code === 'command_output_too_large') return 'too_large'
  if (code === 'command_timeout') return 'timed_out'
  return 'unavailable'
}

function formatGlobResult(result: WorkspaceGlobResult): string {
  const lines = [`Truncated: ${result.truncated ? 'yes' : 'no'}`, '--- begin untrusted glob matches (newest first) ---']
  for (const file of result.files) lines.push(`${file.relativePath}\t${file.sizeBytes} bytes`)
  lines.push('--- end untrusted glob matches ---')
  return lines.join('\n')
}

function formatListDirectoryResult(result: WorkspaceDirectoryResult): string {
  const lines = [`Truncated: ${result.truncated ? 'yes' : 'no'}`, '--- begin untrusted directory entries ---']
  for (const entry of result.entries) lines.push(`${entry.kind}\t${entry.relativePath}`)
  lines.push('--- end untrusted directory entries ---')
  return lines.join('\n')
}

function formatReadFileResult(result: WorkspaceFileResult): string {
  return [
    `Relative workspace file: ${result.relativePath}`,
    `Revision: ${result.revision}`,
    `Truncated: ${result.truncated ? 'yes' : 'no'}`,
    '--- begin untrusted file content ---',
    result.content,
    '--- end untrusted file content ---'
  ].join('\n')
}

function formatSearchFilesResult(result: WorkspaceSearchResult): string {
  const lines = [`Truncated: ${result.truncated ? 'yes' : 'no'}`, '--- begin untrusted search matches ---']
  for (const match of result.matches) lines.push(`${match.relativePath}:${match.line}:${match.column}\t${match.preview}`)
  lines.push('--- end untrusted search matches ---')
  return lines.join('\n')
}

function formatWriteFileResult(result: WorkspaceFileResult): string {
  return [
    `Workspace file written: ${result.relativePath}`,
    `New revision: ${result.revision}`,
    'The complete content was committed through a same-directory temporary file.'
  ].join('\n')
}

function formatReplaceInFileResult(result: WorkspaceReplaceResult): string {
  return [
    `Workspace file updated: ${result.relativePath}`,
    `New revision: ${result.revision}`,
    `Literal replacements committed: ${result.replacements}`
  ].join('\n')
}

function formatGitSummary(result: GitSummary): string {
  const lines = [
    `Git branch: ${result.branch || '(detached or unavailable)'}`,
    `Change totals: +${result.additions} -${result.deletions}`
  ]
  for (const file of result.files) lines.push(`${file.status}\t+${file.additions}\t-${file.deletions}\t${file.relativePath}`)
  return lines.join('\n')
}

function formatGitDiff(result: WorkspaceGitDiffResult): string {
  const lines = [
    `Tracked files included: ${result.files.length}`,
    `Untracked files not included in the patch: ${result.untrackedFiles.length}`,
    `Truncated: ${result.truncated ? 'yes' : 'no'}`
  ]
  for (const relativePath of result.files) lines.push(`tracked\t${relativePath}`)
  for (const relativePath of result.untrackedFiles) lines.push(`untracked\t${relativePath}`)
  lines.push('--- begin untrusted redacted git patch ---')
  lines.push(result.patch || '(no safe tracked patch content)')
  lines.push('--- end untrusted redacted git patch ---')
  return lines.join('\n')
}

function formatRunCommandResult(result: WorkspaceCommandResult): string {
  return [
    'Workspace command cwd: ' + result.relativePath,
    'Exit code: ' + String(result.exitCode),
    '--- begin untrusted command stdout ---',
    result.stdout || '(empty)',
    '--- end untrusted command stdout ---',
    '--- begin untrusted command stderr ---',
    result.stderr || '(empty)',
    '--- end untrusted command stderr ---'
  ].join('\n')
}

function formatDeletePathResult(result: WorkspaceDeleteResult): string {
  return [
    `Deleted local ${result.kind}: ${result.relativePath}`,
    `Removed: ${result.removed ? 'yes' : 'no'}`
  ].join('\n')
}

function boundToolOutput(value: string): string {
  return boundUtf8Text(value, MAX_TOOL_OUTPUT_BYTES, '\n[tool output truncated by local safety limit]')
}

function boundUtf8Text(value: string, maximumBytes: number, suffix: string): string {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length <= maximumBytes) return value
  const suffixBytes = Buffer.byteLength(suffix, 'utf8')
  let end = Math.max(0, maximumBytes - suffixBytes)
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1
  return `${bytes.subarray(0, end).toString('utf8')}${suffix}`
}

function redactWorkspaceToolOutput(
  raw: string,
  apiKey: string,
  accessScope: LocalAccessScope
): string {
  const withoutCurrentApiKey = apiKey ? raw.replaceAll(apiKey, '<redacted>') : raw
  let safe = redactCredentialContent(withoutCurrentApiKey)
  while (apiKey && safe.includes(apiKey)) safe = safe.replaceAll(apiKey, '')
  return safe
}

function containsTurnCredential(raw: string, apiKey: string): boolean {
  return (apiKey.length > 0 && raw.includes(apiKey)) || containsSensitiveCredential(raw, [apiKey])
}
