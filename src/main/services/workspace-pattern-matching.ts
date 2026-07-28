/**
 * Bounded pattern engines for the workspace search tools.
 *
 * The regular-expression engine compiles to a Thompson NFA and matches by
 * parallel state simulation, so matching time is linear in the line length no
 * matter what the pattern looks like — a hostile or accidental catastrophic
 * pattern can never stall the main process the way a backtracking engine can.
 * Backreferences and lookarounds are rejected at compile time.
 *
 * The glob engine matches path segments with an iterative wildcard algorithm
 * and resolves `**` through memoized segment recursion; both are polynomial
 * and bounded by the compile-time caps below.
 */

export class PatternCompileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PatternCompileError'
    this.stack = `${this.name}: ${this.message}`
  }
}

export interface TextPatternMatch {
  readonly start: number
  readonly end: number
}

export interface CompiledTextPattern {
  findMatch(line: string, fromIndex: number): TextPatternMatch | null
}

export interface CompiledGlobPattern {
  matchesPath(relativePath: string): boolean
}

const MAX_PATTERN_CHARACTERS = 512
const MAX_NFA_INSTRUCTIONS = 2_048
const MAX_BOUNDED_REPEAT = 64
const MAX_GLOB_VARIANTS = 64
const MAX_GLOB_SEGMENTS = 64
const MAX_PATH_SEGMENTS = 256

type CharPredicate = (code: number) => boolean

type RegexNode =
  | { readonly type: 'empty' }
  | { readonly type: 'char'; readonly test: CharPredicate }
  | { readonly type: 'assert'; readonly kind: AssertKind }
  | { readonly type: 'concat'; readonly parts: readonly RegexNode[] }
  | { readonly type: 'alternate'; readonly options: readonly RegexNode[] }
  | { readonly type: 'repeat'; readonly node: RegexNode; readonly min: number; readonly max: number | null }

type AssertKind = 'start' | 'end' | 'word' | 'not-word'

type Instruction =
  | { readonly op: 'char'; readonly test: CharPredicate; next: number }
  | { readonly op: 'split'; next: number; alt: number }
  | { readonly op: 'assert'; readonly kind: AssertKind; next: number }
  | { readonly op: 'match' }

const WORD_CHARACTER = /[A-Za-z0-9_]/u
const WHITESPACE_CHARACTER = /\s/u
const DIGIT_CHARACTER = /[0-9]/u

function isWordCode(code: number): boolean {
  return WORD_CHARACTER.test(String.fromCharCode(code))
}

function foldedCodes(code: number, caseInsensitive: boolean): readonly number[] {
  if (!caseInsensitive) return [code]
  const character = String.fromCharCode(code)
  const lower = character.toLowerCase()
  const upper = character.toUpperCase()
  const codes = [code]
  if (lower.length === 1 && lower.charCodeAt(0) !== code) codes.push(lower.charCodeAt(0))
  if (upper.length === 1 && upper.charCodeAt(0) !== code) codes.push(upper.charCodeAt(0))
  return codes
}

function literalPredicate(literal: number, caseInsensitive: boolean): CharPredicate {
  if (!caseInsensitive) return (code) => code === literal
  const accepted = new Set(foldedCodes(literal, true))
  return (code) => {
    if (accepted.has(code)) return true
    for (const folded of foldedCodes(code, true)) if (accepted.has(folded)) return true
    return false
  }
}

function rangePredicate(low: number, high: number, caseInsensitive: boolean): CharPredicate {
  if (!caseInsensitive) return (code) => code >= low && code <= high
  return (code) => {
    for (const folded of foldedCodes(code, true)) if (folded >= low && folded <= high) return true
    return false
  }
}

function classEscapePredicate(letter: string): CharPredicate | null {
  switch (letter) {
    case 'd': return (code) => DIGIT_CHARACTER.test(String.fromCharCode(code))
    case 'D': return (code) => !DIGIT_CHARACTER.test(String.fromCharCode(code))
    case 'w': return (code) => isWordCode(code)
    case 'W': return (code) => !isWordCode(code)
    case 's': return (code) => WHITESPACE_CHARACTER.test(String.fromCharCode(code))
    case 'S': return (code) => !WHITESPACE_CHARACTER.test(String.fromCharCode(code))
    default: return null
  }
}

const SINGLE_CHARACTER_ESCAPES: Readonly<Record<string, number>> = Object.freeze({
  t: 0x09,
  n: 0x0a,
  r: 0x0d,
  f: 0x0c,
  v: 0x0b,
  '0': 0x00
})

const PUNCTUATION_ESCAPES = new Set([
  '\\', '/', '.', '*', '+', '?', '(', ')', '[', ']', '{', '}', '|', '^', '$', '-'
])

class RegexParser {
  readonly #pattern: string
  readonly #caseInsensitive: boolean
  #index = 0

  constructor(pattern: string, caseInsensitive: boolean) {
    this.#pattern = pattern
    this.#caseInsensitive = caseInsensitive
  }

  parse(): RegexNode {
    const node = this.#parseAlternation()
    if (this.#index < this.#pattern.length) {
      throw new PatternCompileError('The pattern has an unmatched ")" or trailing syntax.')
    }
    return node
  }

  #peek(): string {
    return this.#pattern[this.#index] ?? ''
  }

  #next(): string {
    const character = this.#pattern[this.#index] ?? ''
    this.#index += 1
    return character
  }

  #parseAlternation(): RegexNode {
    const options: RegexNode[] = [this.#parseConcat()]
    while (this.#peek() === '|') {
      this.#next()
      options.push(this.#parseConcat())
    }
    return options.length === 1 ? options[0]! : { type: 'alternate', options }
  }

  #parseConcat(): RegexNode {
    const parts: RegexNode[] = []
    while (this.#index < this.#pattern.length && this.#peek() !== '|' && this.#peek() !== ')') {
      parts.push(this.#parseRepeat())
    }
    if (parts.length === 0) return { type: 'empty' }
    return parts.length === 1 ? parts[0]! : { type: 'concat', parts }
  }

  #parseRepeat(): RegexNode {
    let node = this.#parseAtom()
    const quantifier = this.#peek()
    if (quantifier === '*' || quantifier === '+' || quantifier === '?') {
      this.#next()
      this.#assertQuantifiable(node)
      node = quantifier === '*'
        ? { type: 'repeat', node, min: 0, max: null }
        : quantifier === '+'
          ? { type: 'repeat', node, min: 1, max: null }
          : { type: 'repeat', node, min: 0, max: 1 }
    } else if (quantifier === '{') {
      this.#next()
      this.#assertQuantifiable(node)
      node = { type: 'repeat', node, ...this.#parseBoundedRepeat() }
    }
    const trailing = this.#peek()
    if (trailing === '*' || trailing === '+' || trailing === '?' || trailing === '{') {
      throw new PatternCompileError('Stacked quantifiers are not supported; group the inner repetition first.')
    }
    return node
  }

  #assertQuantifiable(node: RegexNode): void {
    if (node.type === 'assert' || node.type === 'empty') {
      throw new PatternCompileError('A quantifier must follow a character, class, or group.')
    }
  }

  #parseBoundedRepeat(): { min: number; max: number | null } {
    const readNumber = (): number | null => {
      let digits = ''
      while (/[0-9]/u.test(this.#peek())) digits += this.#next()
      if (digits.length === 0) return null
      const value = Number.parseInt(digits, 10)
      if (!Number.isSafeInteger(value) || value > MAX_BOUNDED_REPEAT) {
        throw new PatternCompileError(`A bounded repeat may not exceed {${MAX_BOUNDED_REPEAT}}.`)
      }
      return value
    }
    const min = readNumber()
    if (min === null) throw new PatternCompileError('A "{" repetition must contain digits; escape a literal "{" as "\\{".')
    let max: number | null = min
    if (this.#peek() === ',') {
      this.#next()
      max = this.#peek() === '}' ? null : readNumber()
      if (max !== null && max < min) {
        throw new PatternCompileError('A bounded repeat maximum must not be below its minimum.')
      }
      if (max === null && this.#peek() !== '}') {
        throw new PatternCompileError('A "{m,n}" repetition is malformed.')
      }
    }
    if (this.#next() !== '}') throw new PatternCompileError('A "{m,n}" repetition is missing its closing "}".')
    return { min, max }
  }

  #parseAtom(): RegexNode {
    const character = this.#next()
    switch (character) {
      case '(': {
        if (this.#peek() === '?') {
          this.#next()
          if (this.#peek() !== ':') {
            throw new PatternCompileError('Lookarounds and special groups are not supported; use a plain "(...)" group.')
          }
          this.#next()
        }
        const node = this.#parseAlternation()
        if (this.#next() !== ')') throw new PatternCompileError('A group is missing its closing ")".')
        return node
      }
      case '[':
        return { type: 'char', test: this.#parseCharacterClass() }
      case '.':
        return { type: 'char', test: () => true }
      case '^':
        return { type: 'assert', kind: 'start' }
      case '$':
        return { type: 'assert', kind: 'end' }
      case '\\':
        return this.#parseEscape()
      case '*':
      case '+':
      case '?':
        throw new PatternCompileError('A quantifier must follow a character, class, or group.')
      case ')':
        throw new PatternCompileError('The pattern has an unmatched ")".')
      case '':
        throw new PatternCompileError('The pattern ends unexpectedly.')
      default:
        return { type: 'char', test: literalPredicate(character.charCodeAt(0), this.#caseInsensitive) }
    }
  }

  #parseEscape(): RegexNode {
    const letter = this.#next()
    if (letter === '') throw new PatternCompileError('The pattern ends with a dangling "\\".')
    if (letter === 'b') return { type: 'assert', kind: 'word' }
    if (letter === 'B') return { type: 'assert', kind: 'not-word' }
    const classEscape = classEscapePredicate(letter)
    if (classEscape !== null) return { type: 'char', test: classEscape }
    if (Object.hasOwn(SINGLE_CHARACTER_ESCAPES, letter)) {
      const code = SINGLE_CHARACTER_ESCAPES[letter]!
      return { type: 'char', test: (candidate) => candidate === code }
    }
    if (PUNCTUATION_ESCAPES.has(letter)) {
      return { type: 'char', test: literalPredicate(letter.charCodeAt(0), this.#caseInsensitive) }
    }
    if (letter === 'x' || letter === 'u') {
      const width = letter === 'x' ? 2 : 4
      let digits = ''
      for (let i = 0; i < width; i += 1) {
        const digit = this.#next()
        if (!/[0-9a-fA-F]/u.test(digit)) {
          throw new PatternCompileError(`A "\\${letter}" escape needs exactly ${width} hex digits.`)
        }
        digits += digit
      }
      return { type: 'char', test: literalPredicate(Number.parseInt(digits, 16), this.#caseInsensitive) }
    }
    if (/[1-9]/u.test(letter)) {
      throw new PatternCompileError('Backreferences are not supported by the bounded search engine.')
    }
    throw new PatternCompileError(`The escape "\\${letter}" is not supported.`)
  }

  #parseCharacterClass(): CharPredicate {
    const predicates: CharPredicate[] = []
    let negated = false
    if (this.#peek() === '^') {
      negated = true
      this.#next()
    }
    let first = true
    while (true) {
      const character = this.#next()
      if (character === '') throw new PatternCompileError('A character class is missing its closing "]".')
      if (character === ']' && !first) break
      first = false
      let lowCode: number | null = null
      if (character === '\\') {
        const letter = this.#next()
        if (letter === '') throw new PatternCompileError('A character class ends with a dangling "\\".')
        const classEscape = classEscapePredicate(letter)
        if (classEscape !== null) {
          predicates.push(classEscape)
          continue
        }
        if (Object.hasOwn(SINGLE_CHARACTER_ESCAPES, letter)) {
          lowCode = SINGLE_CHARACTER_ESCAPES[letter]!
        } else if (PUNCTUATION_ESCAPES.has(letter) || letter === ']') {
          lowCode = letter.charCodeAt(0)
        } else {
          throw new PatternCompileError(`The escape "\\${letter}" is not supported inside a character class.`)
        }
      } else {
        lowCode = character.charCodeAt(0)
      }
      if (this.#peek() === '-' && this.#pattern[this.#index + 1] !== ']' && this.#pattern[this.#index + 1] !== undefined) {
        this.#next()
        let highRaw = this.#next()
        if (highRaw === '\\') {
          const letter = this.#next()
          if (Object.hasOwn(SINGLE_CHARACTER_ESCAPES, letter)) highRaw = String.fromCharCode(SINGLE_CHARACTER_ESCAPES[letter]!)
          else if (PUNCTUATION_ESCAPES.has(letter) || letter === ']') highRaw = letter
          else throw new PatternCompileError('A character-class range may not end with a class escape.')
        }
        const highCode = highRaw.charCodeAt(0)
        if (highCode < lowCode) throw new PatternCompileError('A character-class range is reversed.')
        predicates.push(rangePredicate(lowCode, highCode, this.#caseInsensitive))
      } else {
        predicates.push(literalPredicate(lowCode, this.#caseInsensitive))
      }
    }
    if (predicates.length === 0) throw new PatternCompileError('A character class may not be empty.')
    return (code) => {
      let matched = false
      for (const predicate of predicates) {
        if (predicate(code)) {
          matched = true
          break
        }
      }
      return negated ? !matched : matched
    }
  }
}

class NfaBuilder {
  readonly instructions: Instruction[] = []

  push(instruction: Instruction): number {
    if (this.instructions.length >= MAX_NFA_INSTRUCTIONS) {
      throw new PatternCompileError('The pattern is too complex for the bounded search engine; simplify it.')
    }
    this.instructions.push(instruction)
    return this.instructions.length - 1
  }

  compile(node: RegexNode, next: number): number {
    switch (node.type) {
      case 'empty':
        return next
      case 'char':
        return this.push({ op: 'char', test: node.test, next })
      case 'assert':
        return this.push({ op: 'assert', kind: node.kind, next })
      case 'concat': {
        let current = next
        for (let index = node.parts.length - 1; index >= 0; index -= 1) {
          current = this.compile(node.parts[index]!, current)
        }
        return current
      }
      case 'alternate': {
        const entries = node.options.map((option) => this.compile(option, next))
        let current = entries[entries.length - 1]!
        for (let index = entries.length - 2; index >= 0; index -= 1) {
          current = this.push({ op: 'split', next: entries[index]!, alt: current })
        }
        return current
      }
      case 'repeat': {
        let current = next
        if (node.max === null) {
          const loop = this.push({ op: 'split', next: -1, alt: next })
          const entry = this.compile(node.node, loop)
          ;(this.instructions[loop] as Extract<Instruction, { op: 'split' }>).next = entry
          current = loop
          for (let index = 0; index < node.min; index += 1) {
            current = this.compile(node.node, current)
          }
          return current
        }
        for (let index = 0; index < node.max - node.min; index += 1) {
          const entry = this.compile(node.node, current)
          current = this.push({ op: 'split', next: entry, alt: current })
        }
        for (let index = 0; index < node.min; index += 1) {
          current = this.compile(node.node, current)
        }
        return current
      }
    }
  }
}

class TextPattern implements CompiledTextPattern {
  readonly #instructions: readonly Instruction[]
  readonly #start: number
  readonly #matchPc: number

  constructor(instructions: readonly Instruction[], start: number, matchPc: number) {
    this.#instructions = instructions
    this.#start = start
    this.#matchPc = matchPc
  }

  findMatch(line: string, fromIndex: number): TextPatternMatch | null {
    const instructions = this.#instructions
    const length = line.length
    const from = Math.max(0, fromIndex)
    if (from > length) return null

    const stateCount = instructions.length
    let current = new Int32Array(stateCount).fill(-1)
    let following = new Int32Array(stateCount).fill(-1)
    let currentActive: number[] = []
    let followingActive: number[] = []
    const pending: number[] = []
    let matchStart = -1
    let matchEnd = -1

    const boundaryAt = (position: number): boolean => {
      const before = position > 0 && isWordCode(line.charCodeAt(position - 1))
      const after = position < length && isWordCode(line.charCodeAt(position))
      return before !== after
    }

    const addThread = (list: Int32Array, active: number[], pc: number, start: number, position: number): void => {
      pending.length = 0
      pending.push(pc, start)
      while (pending.length > 0) {
        const threadStart = pending.pop()!
        const threadPc = pending.pop()!
        const existing = list[threadPc]!
        if (existing !== -1 && existing <= threadStart) continue
        if (existing === -1) active.push(threadPc)
        list[threadPc] = threadStart
        const instruction = instructions[threadPc]!
        if (instruction.op === 'split') {
          pending.push(instruction.alt, threadStart, instruction.next, threadStart)
        } else if (instruction.op === 'assert') {
          const holds = instruction.kind === 'start'
            ? position === 0
            : instruction.kind === 'end'
              ? position === length
              : instruction.kind === 'word'
                ? boundaryAt(position)
                : !boundaryAt(position)
          if (holds) pending.push(instruction.next, threadStart)
        }
      }
    }

    for (let position = from; position <= length; position += 1) {
      if (matchStart === -1) addThread(current, currentActive, this.#start, position, position)
      const matchCandidate = current[this.#matchPc]!
      if (matchCandidate !== -1 && (matchStart === -1 || matchCandidate <= matchStart)) {
        if (matchStart === -1 || matchCandidate < matchStart || position > matchEnd) {
          matchStart = matchCandidate
          matchEnd = position
        }
      }
      if (position === length || currentActive.length === 0) break
      const code = line.charCodeAt(position)
      for (const pc of currentActive) {
        const start = current[pc]!
        if (start === -1) continue
        if (matchStart !== -1 && start > matchStart) continue
        const instruction = instructions[pc]!
        if (instruction.op === 'char' && instruction.test(code)) {
          addThread(following, followingActive, instruction.next, start, position + 1)
        }
      }
      for (const pc of currentActive) current[pc] = -1
      const swapList = current
      current = following
      following = swapList
      const swapActive = currentActive
      currentActive = followingActive
      followingActive = swapActive
      followingActive.length = 0
      if (matchStart !== -1 && currentActive.length === 0) break
    }

    if (matchStart === -1) return null
    return { start: matchStart, end: matchEnd }
  }
}

export function compileSearchPattern(pattern: string, caseSensitive: boolean): CompiledTextPattern {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    throw new PatternCompileError('The search pattern may not be empty.')
  }
  if (pattern.length > MAX_PATTERN_CHARACTERS) {
    throw new PatternCompileError(`The search pattern may not exceed ${MAX_PATTERN_CHARACTERS} characters.`)
  }
  const ast = new RegexParser(pattern, !caseSensitive).parse()
  const builder = new NfaBuilder()
  const matchPc = builder.push({ op: 'match' })
  const start = builder.compile(ast, matchPc)
  return new TextPattern(builder.instructions, start, matchPc)
}

type GlobToken =
  | { readonly type: 'literal'; readonly code: number }
  | { readonly type: 'any' }
  | { readonly type: 'star' }
  | { readonly type: 'class'; readonly test: CharPredicate }

type GlobSegment =
  | { readonly type: 'globstar' }
  | { readonly type: 'tokens'; readonly tokens: readonly GlobToken[] }

function parseGlobSegment(segment: string): GlobSegment {
  if (segment === '**') return { type: 'globstar' }
  const tokens: GlobToken[] = []
  let index = 0
  while (index < segment.length) {
    const character = segment[index]!
    if (character === '*') {
      // Consecutive stars inside one segment behave like a single star.
      if (tokens.length === 0 || tokens[tokens.length - 1]!.type !== 'star') tokens.push({ type: 'star' })
      index += 1
      continue
    }
    if (character === '?') {
      tokens.push({ type: 'any' })
      index += 1
      continue
    }
    if (character === '[') {
      const closing = findGlobClassEnd(segment, index)
      if (closing < 0) throw new PatternCompileError('A glob character class is missing its closing "]".')
      tokens.push({ type: 'class', test: parseGlobClass(segment.slice(index + 1, closing)) })
      index = closing + 1
      continue
    }
    tokens.push({ type: 'literal', code: character.toLowerCase().charCodeAt(0) })
    index += 1
  }
  return { type: 'tokens', tokens }
}

function findGlobClassEnd(segment: string, openIndex: number): number {
  let index = openIndex + 1
  if (segment[index] === '!' || segment[index] === '^') index += 1
  if (segment[index] === ']') index += 1
  while (index < segment.length) {
    if (segment[index] === ']') return index
    index += 1
  }
  return -1
}

function parseGlobClass(body: string): CharPredicate {
  let content = body
  let negated = false
  if (content.startsWith('!') || content.startsWith('^')) {
    negated = true
    content = content.slice(1)
  }
  if (content.length === 0) throw new PatternCompileError('A glob character class may not be empty.')
  const predicates: CharPredicate[] = []
  let index = 0
  while (index < content.length) {
    const low = content[index]!.toLowerCase().charCodeAt(0)
    if (content[index + 1] === '-' && index + 2 < content.length) {
      const high = content[index + 2]!.toLowerCase().charCodeAt(0)
      if (high < low) throw new PatternCompileError('A glob character-class range is reversed.')
      predicates.push(rangePredicate(low, high, true))
      index += 3
      continue
    }
    predicates.push(literalPredicate(low, true))
    index += 1
  }
  return (code) => {
    let matched = false
    for (const predicate of predicates) {
      if (predicate(code)) {
        matched = true
        break
      }
    }
    return negated ? !matched : matched
  }
}

function matchGlobTokens(tokens: readonly GlobToken[], text: string): boolean {
  let tokenIndex = 0
  let textIndex = 0
  let starToken = -1
  let starText = -1
  while (textIndex < text.length) {
    const token = tokens[tokenIndex]
    if (token !== undefined && token.type === 'star') {
      starToken = tokenIndex
      starText = textIndex
      tokenIndex += 1
      continue
    }
    const code = text.charCodeAt(textIndex)
    if (
      token !== undefined && (
        (token.type === 'literal' && token.code === code) ||
        token.type === 'any' ||
        (token.type === 'class' && token.test(code))
      )
    ) {
      tokenIndex += 1
      textIndex += 1
      continue
    }
    if (starToken >= 0) {
      starText += 1
      textIndex = starText
      tokenIndex = starToken + 1
      continue
    }
    return false
  }
  while (tokens[tokenIndex]?.type === 'star') tokenIndex += 1
  return tokenIndex === tokens.length
}

function expandGlobBraces(pattern: string): string[] {
  const openIndex = pattern.indexOf('{')
  if (openIndex < 0) return [pattern]
  let depth = 0
  let closeIndex = -1
  const alternatives: number[] = []
  for (let index = openIndex; index < pattern.length; index += 1) {
    const character = pattern[index]!
    if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) {
        closeIndex = index
        break
      }
    } else if (character === ',' && depth === 1) {
      alternatives.push(index)
    }
  }
  if (closeIndex < 0) throw new PatternCompileError('A glob brace group is missing its closing "}".')
  const prefix = pattern.slice(0, openIndex)
  const suffix = pattern.slice(closeIndex + 1)
  const body = pattern.slice(openIndex + 1, closeIndex)
  const cuts = alternatives.map((absolute) => absolute - openIndex - 1)
  const parts: string[] = []
  let previous = 0
  for (const cut of cuts) {
    parts.push(body.slice(previous, cut))
    previous = cut + 1
  }
  parts.push(body.slice(previous))
  const expanded: string[] = []
  for (const part of parts) {
    for (const variant of expandGlobBraces(prefix + part + suffix)) {
      expanded.push(variant)
      if (expanded.length > MAX_GLOB_VARIANTS) {
        throw new PatternCompileError(`A glob pattern may not expand to more than ${MAX_GLOB_VARIANTS} variants.`)
      }
    }
  }
  return expanded
}

class GlobPattern implements CompiledGlobPattern {
  readonly #variants: readonly (readonly GlobSegment[])[]

  constructor(variants: readonly (readonly GlobSegment[])[]) {
    this.#variants = variants
  }

  matchesPath(relativePath: string): boolean {
    if (typeof relativePath !== 'string' || relativePath.length === 0 || relativePath === '.') return false
    const segments = relativePath.replaceAll('\\', '/').toLowerCase().split('/')
    if (segments.length > MAX_PATH_SEGMENTS) return false
    for (const variant of this.#variants) {
      if (matchGlobSegments(variant, segments)) return true
    }
    return false
  }
}

function matchGlobSegments(pattern: readonly GlobSegment[], path: readonly string[]): boolean {
  const memo = new Map<number, boolean>()
  const step = (patternIndex: number, pathIndex: number): boolean => {
    const key = patternIndex * (MAX_PATH_SEGMENTS + 1) + pathIndex
    const cached = memo.get(key)
    if (cached !== undefined) return cached
    let result: boolean
    if (patternIndex === pattern.length) {
      result = pathIndex === path.length
    } else {
      const segment = pattern[patternIndex]!
      if (segment.type === 'globstar') {
        result = step(patternIndex + 1, pathIndex) ||
          (pathIndex < path.length && step(patternIndex, pathIndex + 1))
      } else if (pathIndex === path.length) {
        result = false
      } else {
        result = matchGlobTokens(segment.tokens, path[pathIndex]!) && step(patternIndex + 1, pathIndex + 1)
      }
    }
    memo.set(key, result)
    return result
  }
  return step(0, 0)
}

export function compileGlobPattern(pattern: string): CompiledGlobPattern {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    throw new PatternCompileError('The glob pattern may not be empty.')
  }
  if (pattern.length > MAX_PATTERN_CHARACTERS) {
    throw new PatternCompileError(`The glob pattern may not exceed ${MAX_PATTERN_CHARACTERS} characters.`)
  }
  if (/[\u0000-\u001f\u007f]/u.test(pattern)) {
    throw new PatternCompileError('The glob pattern may not contain control characters.')
  }
  let normalized = pattern.replaceAll('\\', '/')
  while (normalized.startsWith('./')) normalized = normalized.slice(2)
  if (normalized.startsWith('/') || normalized.includes('//')) {
    throw new PatternCompileError('A glob pattern must be a relative path pattern without empty segments.')
  }
  const variants: (readonly GlobSegment[])[] = []
  for (const rawVariant of expandGlobBraces(normalized)) {
    const anchored = rawVariant.includes('/') ? rawVariant : `**/${rawVariant}`
    const segments = anchored.split('/')
    if (segments.length > MAX_GLOB_SEGMENTS) {
      throw new PatternCompileError(`A glob pattern may not exceed ${MAX_GLOB_SEGMENTS} path segments.`)
    }
    const compiled: GlobSegment[] = []
    for (const segment of segments) {
      if (segment === '..' || segment === '.') {
        throw new PatternCompileError('A glob pattern may not contain "." or ".." segments.')
      }
      const parsed = parseGlobSegment(segment)
      // Consecutive globstar segments collapse to one.
      if (parsed.type === 'globstar' && compiled[compiled.length - 1]?.type === 'globstar') continue
      compiled.push(parsed)
    }
    variants.push(compiled)
  }
  return new GlobPattern(variants)
}

/**
 * Directory names skipped by recursive search and glob traversal so bounded
 * file budgets are spent on source instead of dependencies and build output.
 * Rooting a search inside one of these directories still works: the skip only
 * applies while descending into children.
 */
export const DEFAULT_IGNORED_TRAVERSAL_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  'node_modules',
  'bower_components',
  'vendor',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'out',
  'build',
  'coverage',
  'electron_publish',
  '.venv',
  'venv',
  '__pycache__',
  'target',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.gradle'
])
