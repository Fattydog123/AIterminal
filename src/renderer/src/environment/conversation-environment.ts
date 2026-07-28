import type { AgentExecutionEntry } from '../conversation/conversation-session'

export type SubagentRunState = 'none' | 'running' | 'completed' | 'partial' | 'failed'

export interface SubagentRunSummary {
  readonly state: SubagentRunState
  readonly total: number
  readonly running: number
  readonly completed: number
  readonly failed: number
  readonly batchSeen: boolean
}

export interface ConversationSource {
  readonly url: string
  readonly title: string
  readonly hostname: string
}

const SUBAGENT_BATCH_ID = /^tool:subagent:batch:/u
const SUBAGENT_TASK_ID = /^tool:subagent:\d+:tool:/u
const MAX_SOURCES = 12
const MAX_SOURCE_URL_CHARACTERS = 2_048
const MAX_SOURCE_TITLE_CHARACTERS = 96

export function summarizeSubagentRun(
  entries: readonly AgentExecutionEntry[],
): SubagentRunSummary {
  const explicitTasks = entries.filter((entry) => entry.kind === 'subagent')
  const tasks = explicitTasks.length > 0
    ? explicitTasks
    : entries.filter((entry) => SUBAGENT_TASK_ID.test(entry.id))
  const batches = entries.filter((entry) => SUBAGENT_BATCH_ID.test(entry.id))
  const running = tasks.filter((entry) => entry.status === 'running' || entry.status === 'waiting').length
  const completed = tasks.filter((entry) => entry.status === 'completed').length
  const failed = tasks.filter((entry) => entry.status === 'failed' || entry.status === 'cancelled').length
  const batchRunning = batches.some((entry) => entry.status === 'running' || entry.status === 'waiting')
  const batchFailed = batches.some((entry) => entry.status === 'failed' || entry.status === 'cancelled')
  const batchSeen = batches.length > 0

  const state: SubagentRunState = running > 0 || batchRunning
    ? 'running'
    : failed > 0 && completed > 0
      ? 'partial'
      : failed > 0 || batchFailed
        ? 'failed'
        : tasks.length > 0 || batchSeen
          ? 'completed'
          : 'none'

  return Object.freeze({
    state,
    total: tasks.length,
    running,
    completed,
    failed,
    batchSeen,
  })
}

export function extractConversationSources(markdown: string): readonly ConversationSource[] {
  if (!markdown.trim()) return Object.freeze([])
  const visibleText = stripMarkdownCode(markdown)
  const sources = new Map<string, ConversationSource>()

  const addSource = (rawUrl: string, rawTitle = ''): void => {
    if (sources.size >= MAX_SOURCES) return
    const candidate = trimUrlPunctuation(rawUrl.replace(/&amp;/giu, '&'))
    if (!candidate || candidate.length > MAX_SOURCE_URL_CHARACTERS) return
    let parsed: URL
    try {
      parsed = new URL(candidate)
    } catch {
      return
    }
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password
    ) return

    parsed.hash = ''
    const url = parsed.href
    if (sources.has(url)) return
    const hostname = parsed.hostname.replace(/^www\./iu, '')
    const normalizedTitle = rawTitle
      .replace(/[*_~`]/gu, '')
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, MAX_SOURCE_TITLE_CHARACTERS)
    sources.set(url, Object.freeze({
      url,
      title: normalizedTitle || hostname,
      hostname,
    }))
  }

  const markdownLinks = /(?<!!)\[([^\]\r\n]{1,160})\]\(\s*(https?:\/\/(?:[^\s()]|\([^\s()]*\))+)(?:\s+["'][^"']*["'])?\s*\)/giu
  for (const match of visibleText.matchAll(markdownLinks)) addSource(match[2] ?? '', match[1] ?? '')

  const bareLinks = /https?:\/\/[^\s<>{}\[\]"'`]+/giu
  for (const match of visibleText.matchAll(bareLinks)) addSource(match[0] ?? '')

  return Object.freeze([...sources.values()])
}

function stripMarkdownCode(markdown: string): string {
  return markdown
    .replace(/```[^\n]*\n[\s\S]*?```/gu, ' ')
    .replace(/~~~[^\n]*\n[\s\S]*?~~~/gu, ' ')
    .replace(/`[^`\r\n]*`/gu, ' ')
}

function trimUrlPunctuation(value: string): string {
  let result = value.trim().replace(/[.,!?;:。，！？；：、]+$/gu, '')
  while (result.endsWith(')') && count(result, ')') > count(result, '(')) result = result.slice(0, -1)
  while (result.endsWith(']') && count(result, ']') > count(result, '[')) result = result.slice(0, -1)
  return result
}

function count(value: string, character: string): number {
  return [...value].filter((candidate) => candidate === character).length
}
