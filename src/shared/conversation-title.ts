const INTERNAL_TITLE_BLOCKS = [
  'command-name',
  'command-message',
  'command-args',
  'local-command-stdout',
  'system-reminder',
  'environment_context',
  'user_info',
] as const

const INTERNAL_BLOCK_PATTERN = new RegExp(
  `<(${INTERNAL_TITLE_BLOCKS.join('|')})\\b[^>]*>[\\s\\S]*?<\\/\\1>`,
  'giu',
)
const INTERNAL_TAG_PATTERN = new RegExp(
  `<\\/?(?:${INTERNAL_TITLE_BLOCKS.join('|')})\\b[^>]*>`,
  'giu',
)
const CONTROL_ONLY_COMMAND = /^\/(?:effort|model|permissions?|status|compact|resume|delegate(?:-[\w-]+)?)\b(?:\s+.*)?$/iu
const GENERATED_SLUG = /^(?:[a-z0-9]+-){3,}[a-z0-9-]{8,}$/iu

/** Produces the short, user-facing title shown in the task tree. */
export function conversationTitleFromText(
  value: string | undefined,
  fallback: string,
  maxCharacters = 80,
): string {
  if (value === undefined || maxCharacters < 2) return fallback

  const visible = value
    .replace(INTERNAL_BLOCK_PATTERN, ' ')
    .replace(INTERNAL_TAG_PATTERN, ' ')
    .replace(/^\s*#\s*(?:Files mentioned by the user|My request for Codex)\s*:?\s*/gimu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()

  if (!visible || CONTROL_ONLY_COMMAND.test(visible) || GENERATED_SLUG.test(visible)) return fallback
  if (visible.length <= maxCharacters) return visible
  return `${visible.slice(0, maxCharacters - 1).trimEnd()}…`
}
