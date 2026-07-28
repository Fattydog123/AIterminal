import { lookup } from 'node:dns/promises'
import https from 'node:https'
import { isIP } from 'node:net'
import { session } from 'electron'
import { z } from 'zod'
import { isGptImage2Model, isGptImageModel, usesImageArrayFormField } from '../../studio/core/imageModels.js'
import type {
  ImageEditRequest,
  ImageGenerationRequest,
  OpenAiProviderDescriptor,
  StudioImageCapabilityProof,
} from '../../studio/shared/types.js'
import {
  buildImagesEditRequestUrl,
  buildImagesGenerationRequestUrl,
} from '../services/images-client.js'
import { StudioError } from './errors.js'
import { actionableImageGenerationError } from './image-generation-errors.js'

const imageResponseSchema = z.object({
  data: z.array(z.object({
    url: z.string().url().optional(),
    b64_json: z.string().optional(),
    revised_prompt: z.string().max(256_000).optional(),
  }).passthrough()).min(1).max(100),
}).passthrough()

const imageStreamEventSchema = z.object({
  type: z.string().min(1).max(160),
  b64_json: z.string().optional(),
  revised_prompt: z.string().max(256_000).optional(),
}).passthrough()

export interface ProviderImage {
  readonly bytes: Uint8Array
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  readonly revisedPrompt?: string
}

export interface ProviderRequestContext {
  readonly descriptor: OpenAiProviderDescriptor
  readonly apiKey: string
  /** Confirms the final URL immediately before any remote request is dispatched. */
  readonly ensureEndpointConsent: (endpoint: string) => Promise<void>
  readonly signal?: AbortSignal
  readonly onPhase?: (phase: 'download' | 'decode', state: 'start' | 'finish') => void
  /** Called after transport setup and immediately before a side-effecting fetch crosses the dispatch seam. */
  readonly onDispatch?: () => void | Promise<void>
}

const endpointUrl = (baseUrl: string, endpoint: '/models'): string => {
  const url = new URL(baseUrl)
  let basePath = url.pathname.replace(/\/+$/, '')
  if (!/(?:^|\/)v1$/i.test(basePath)) basePath = `${basePath}/v1`
  url.pathname = `${basePath}${endpoint}`.replace(/\/{2,}/g, '/')
  url.search = ''
  url.hash = ''
  return url.toString()
}

export const buildStudioModelsRequestUrl = (baseUrl: string): string => endpointUrl(baseUrl, '/models')

const responseBytes = async (response: Response, maximumBytes: number): Promise<Uint8Array> => {
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new StudioError('response-too-large', `接口响应超过大小限制（${maximumBytes} 字节）`, 'sent')
  }
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maximumBytes) {
        await reader.cancel()
        throw new StudioError('response-too-large', `接口响应超过大小限制（${maximumBytes} 字节）`, 'sent')
      }
      chunks.push(value)
    }
  } catch (error) {
    if (error instanceof StudioError) throw error
    throw new StudioError('response-read-failed', '读取接口响应时连接中断', 'sent', error)
  }
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

const responseJson = async (response: Response, maximumBytes: number): Promise<unknown> => {
  const bytes = await responseBytes(response, maximumBytes)
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch (error) {
    throw new StudioError('provider-invalid-json', '接口返回的不是有效 JSON', 'sent', error)
  }
}

const errorMessage = async (response: Response): Promise<string> => {
  try {
    const value = await responseJson(response, 1_048_576)
    if (typeof value === 'object' && value !== null) {
      const error = (value as Record<string, unknown>).error
      if (typeof error === 'object' && error !== null && typeof (error as Record<string, unknown>).message === 'string') {
        return String((error as Record<string, unknown>).message).slice(0, 1_000)
      }
      if (typeof (value as Record<string, unknown>).message === 'string') {
        return String((value as Record<string, unknown>).message).slice(0, 1_000)
      }
    }
  } catch {
    // Use status text below; never include arbitrary HTML in IPC errors.
  }
  return `${response.status} ${response.statusText}`.trim()
}

const fetchSession = async (provider: OpenAiProviderDescriptor): Promise<Electron.Session> => {
  if (provider.proxyMode === 'system') return session.defaultSession
  const directSession = session.fromPartition(`provider-direct-${provider.id}`, { cache: false })
  await directSession.setProxy({ mode: 'direct' })
  return directSession
}

interface ProviderFetchOptions {
  /**
   * A protocol negotiation fallback may issue a second HTTP request after the
   * first request was explicitly rejected before processing. Keep the run
   * journal's dispatch callback one-shot while preserving billing-unknown
   * semantics if the fallback transport itself is interrupted.
   */
  readonly dispatchAlreadyRecorded?: boolean
}

/** Sends exactly one request. It deliberately contains no retry loop. */
const providerFetch = async (
  context: ProviderRequestContext,
  url: string,
  init: RequestInit,
  sideEffecting: boolean,
  options: ProviderFetchOptions = {},
): Promise<Response> => {
  const timeout = AbortSignal.timeout(context.descriptor.timeoutMs)
  const signal = context.signal ? AbortSignal.any([timeout, context.signal]) : timeout
  let dispatched = false
  try {
    try {
      await context.ensureEndpointConsent(url)
    } catch (error) {
      throw new StudioError(
        'studio-endpoint-consent-denied',
        '实际远程接口未获本次会话批准，已阻止请求；请重新运行并确认最新地址',
        'not_sent',
        error,
      )
    }
    const providerSession = await fetchSession(context.descriptor)
    if (sideEffecting && !options.dispatchAlreadyRecorded) {
      try { await context.onDispatch?.() } catch (error) {
        if (error instanceof StudioError) throw error
        throw new StudioError('dispatch-journal-failed', '无法写入派发日志，已阻止远程请求', 'not_sent', error)
      }
    }
    dispatched = true
    return await providerSession.fetch(url, { ...init, signal })
  } catch (error) {
    if (error instanceof StudioError) throw error
    throw new StudioError(
      context.signal?.aborted ? 'provider-cancelled' : 'provider-network-error',
      sideEffecting
        ? (context.signal?.aborted ? '请求已取消；远端是否已开始计费无法确认' : '接口连接中断；远端是否已收到请求或计费无法确认')
        : (context.signal?.aborted ? '接口探测已取消' : '接口连接失败'),
      sideEffecting && dispatched ? 'billing_unknown' : 'not_sent',
      error,
    )
  }
}

/**
 * Reads a bounded, cloned error body without consuming the response that may
 * still be used by the caller. This is intentionally narrower than generic
 * error handling: it only supports deciding whether an Images request's
 * stream negotiation was rejected by an older compatible server.
 */
const responseErrorText = async (response: Response): Promise<string> => {
  try {
    const value = await responseJson(response.clone(), 1_048_576)
    const strings: string[] = []
    const collect = (entry: unknown, depth = 0): void => {
      if (depth > 3 || strings.length >= 24) return
      if (typeof entry === 'string') {
        strings.push(entry.slice(0, 1_000))
        return
      }
      if (typeof entry !== 'object' || entry === null) return
      for (const value of Object.values(entry as Record<string, unknown>)) collect(value, depth + 1)
    }
    collect(value)
    return strings.join(' ')
  } catch {
    return ''
  }
}

const streamFieldMarker = /(?:\bstream(?:ing)?\b|\bpartial[ _-]?images?\b|\bpartial[ _-]?image\b)/iu
const unsupportedStreamMarker = /(?:unsupported|not[ _-]?supported|not[ _-]?allowed|unrecognized|unknown|unexpected|disallowed|must[ _-]?not|does[ _-]?not[ _-]?accept|不支持|不识别|未知|非法|未定义)/iu
const invalidStreamParameterMarker = /(?:\bstream(?:ing)?\b|\bpartial[ _-]?images?\b|\bpartial[ _-]?image\b).{0,64}(?:invalid|无效)|(?:invalid|非法|无效).{0,64}(?:field|parameter|argument|property|字段|参数).{0,64}(?:\bstream(?:ing)?\b|\bpartial[ _-]?images?\b|\bpartial[ _-]?image\b)/iu

/**
 * Returns true only for a deterministic 400/422 rejection that names one of
 * the streaming negotiation fields. A generic validation error never causes
 * a second billable request.
 */
const explicitlyRejectsImageStreaming = async (response: Response): Promise<boolean> => {
  if (response.status !== 400 && response.status !== 422) return false
  const text = await responseErrorText(response)
  if (!streamFieldMarker.test(text)) return false
  return unsupportedStreamMarker.test(text) || invalidStreamParameterMarker.test(text)
}

const authorizedHeaders = (apiKey: string, extra?: RequestInit['headers']): Headers => {
  const headers = new Headers(extra)
  headers.set('Authorization', `Bearer ${apiKey}`)
  if (!headers.has('Accept')) headers.set('Accept', 'application/json')
  return headers
}

const detectImage = (bytes: Uint8Array): ProviderImage['mediaType'] => {
  const text = (start: number, end: number): string => new TextDecoder().decode(bytes.slice(start, end))
  if (bytes.length >= 20 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
      bytes[bytes.length - 12] === 0 && bytes[bytes.length - 11] === 0 && bytes[bytes.length - 10] === 0 && bytes[bytes.length - 9] === 0 &&
      text(bytes.length - 8, bytes.length - 4) === 'IEND') return 'image/png'
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff &&
      bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9) return 'image/jpeg'
  if (bytes.length >= 12 && text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP' &&
      new DataView(bytes.buffer, bytes.byteOffset + 4, 4).getUint32(0, true) + 8 === bytes.length) return 'image/webp'
  if (bytes.length >= 7 && /^GIF8[79]a$/.test(text(0, 6)) && bytes[bytes.length - 1] === 0x3b) return 'image/gif'
  throw new StudioError('invalid-image', '接口返回的数据不是支持的完整图片', 'sent')
}

export const imageDimensions = (bytes: Uint8Array, mediaType: ProviderImage['mediaType']): { readonly width: number; readonly height: number } | undefined => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (mediaType === 'image/png' && bytes.length >= 24) {
    const width = view.getUint32(16)
    const height = view.getUint32(20)
    return width > 0 && height > 0 ? { width, height } : undefined
  }
  if (mediaType === 'image/gif' && bytes.length >= 10) {
    const width = view.getUint16(6, true)
    const height = view.getUint16(8, true)
    return width > 0 && height > 0 ? { width, height } : undefined
  }
  if (mediaType === 'image/jpeg') {
    const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])
    let offset = 2
    while (offset + 8 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue }
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1
      const marker = bytes[offset]
      offset += 1
      if (marker === undefined || marker === 0xd9 || marker === 0xda) break
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
      if (offset + 2 > bytes.length) break
      const length = view.getUint16(offset)
      if (length < 2 || offset + length > bytes.length) break
      if (sof.has(marker) && length >= 7) {
        const height = view.getUint16(offset + 3)
        const width = view.getUint16(offset + 5)
        return width > 0 && height > 0 ? { width, height } : undefined
      }
      offset += length
    }
  }
  if (mediaType === 'image/webp' && bytes.length >= 30) {
    const chunk = new TextDecoder().decode(bytes.slice(12, 16))
    if (chunk === 'VP8X') {
      const width = 1 + (bytes[24] ?? 0) + ((bytes[25] ?? 0) << 8) + ((bytes[26] ?? 0) << 16)
      const height = 1 + (bytes[27] ?? 0) + ((bytes[28] ?? 0) << 8) + ((bytes[29] ?? 0) << 16)
      return { width, height }
    }
    if (chunk === 'VP8L' && bytes[20] === 0x2f) {
      const width = 1 + (bytes[21] ?? 0) + (((bytes[22] ?? 0) & 0x3f) << 8)
      const height = 1 + (((bytes[22] ?? 0) & 0xc0) >> 6) + ((bytes[23] ?? 0) << 2) + (((bytes[24] ?? 0) & 0x0f) << 10)
      return { width, height }
    }
    if (chunk === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      const width = view.getUint16(26, true) & 0x3fff
      const height = view.getUint16(28, true) & 0x3fff
      return width > 0 && height > 0 ? { width, height } : undefined
    }
  }
  return undefined
}

const decodeBase64Image = (value: string, maximumBytes: number): ProviderImage => {
  const dataUri = /^data:(image\/(?:png|jpeg|webp|gif));base64,([a-zA-Z0-9+/]*={0,2})$/i.exec(value)
  const encoded = dataUri?.[2] ?? value
  if (encoded.length > Math.ceil(maximumBytes / 3) * 4 + 8) {
    throw new StudioError('image-too-large', `图片超过大小限制（${maximumBytes} 字节）`, 'sent')
  }
  if (!/^[a-zA-Z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    throw new StudioError('invalid-base64', '接口返回了无效的 base64 图片', 'sent')
  }
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.byteLength > maximumBytes) throw new StudioError('image-too-large', '图片超过大小限制', 'sent')
  const mediaType = detectImage(bytes)
  if (dataUri?.[1] && dataUri[1].toLowerCase() !== mediaType) {
    throw new StudioError('image-data-uri-mismatch', '接口返回的 data URI 类型与图片内容不一致', 'sent')
  }
  return { bytes, mediaType }
}

const ipv4Integer = (value: string): number | undefined => {
  const octets = value.split('.').map(Number)
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined
  return (((octets[0] ?? 0) << 24) | ((octets[1] ?? 0) << 16) | ((octets[2] ?? 0) << 8) | (octets[3] ?? 0)) >>> 0
}

const ipv4CidrContains = (address: number, network: string, prefix: number): boolean => {
  const base = ipv4Integer(network)
  if (base === undefined) return true
  const mask = prefix === 0 ? 0 : (0xffff_ffff << (32 - prefix)) >>> 0
  return (address & mask) === (base & mask)
}

const unsafeIpv4Cidrs = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const

const isPrivateIpv4 = (value: string): boolean => {
  const address = ipv4Integer(value)
  return address === undefined || unsafeIpv4Cidrs.some(([network, prefix]) => ipv4CidrContains(address, network, prefix))
}

const normalizedNetworkHost = (hostname: string): string => {
  const withoutBrackets = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  return withoutBrackets.endsWith('.') ? withoutBrackets.slice(0, -1).toLowerCase() : withoutBrackets.toLowerCase()
}

const mappedIpv4 = (address: string): string | undefined => {
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)?.[1]
  if (dotted) return dotted
  const hexadecimal = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address)
  if (!hexadecimal) return undefined
  const high = Number.parseInt(hexadecimal[1] ?? '', 16)
  const low = Number.parseInt(hexadecimal[2] ?? '', 16)
  return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`
}

const ipv6Integer = (value: string): bigint | undefined => {
  if (value.includes('%') || value.includes('.')) return undefined
  const halves = value.toLowerCase().split('::')
  if (halves.length > 2) return undefined
  const parseHalf = (half: string): number[] | undefined => {
    if (!half) return []
    const tokens = half.split(':')
    if (tokens.some((token) => !/^[0-9a-f]{1,4}$/.test(token))) return undefined
    return tokens.map((token) => Number.parseInt(token, 16))
  }
  const left = parseHalf(halves[0] ?? '')
  const right = parseHalf(halves[1] ?? '')
  if (!left || !right) return undefined
  const compressed = halves.length === 2
  const missing = 8 - left.length - right.length
  if ((!compressed && missing !== 0) || (compressed && missing < 1)) return undefined
  const groups = [...left, ...Array.from({ length: missing }, () => 0), ...right]
  if (groups.length !== 8) return undefined
  return groups.reduce((result, group) => (result << 16n) | BigInt(group), 0n)
}

const ipv6CidrContains = (address: bigint, network: string, prefix: number): boolean => {
  const base = ipv6Integer(network)
  if (base === undefined || prefix < 0 || prefix > 128) return false
  if (prefix === 0) return true
  const shift = 128n - BigInt(prefix)
  return (address >> shift) === (base >> shift)
}

const unsafeIpv6Cidrs = [
  ['::', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2001:2::', 48],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const

const isPrivateAddress = (rawAddress: string): boolean => {
  const address = normalizedNetworkHost(rawAddress)
  if (isIP(address) === 4) return isPrivateIpv4(address)
  if (isIP(address) !== 6) return true
  const mapped = mappedIpv4(address)
  if (mapped) return isPrivateIpv4(mapped)
  const numeric = ipv6Integer(address)
  return numeric === undefined || unsafeIpv6Cidrs.some(([network, prefix]) => ipv6CidrContains(numeric, network, prefix))
}

const abortable = async <T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> => {
  if (!signal) return promise
  if (signal.aborted) throw new StudioError('download-cancelled', '图片下载已取消', 'sent')
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(new StudioError('download-cancelled', '图片下载已取消', 'sent'))
    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      (value) => { signal.removeEventListener('abort', abort); resolve(value) },
      (error: unknown) => { signal.removeEventListener('abort', abort); reject(error) },
    )
  })
}

const publicAddresses = async (hostname: string, signal?: AbortSignal): Promise<readonly { address: string; family: 4 | 6 }[]> => {
  const normalizedHostname = normalizedNetworkHost(hostname)
  if (/^(?:localhost|.+\.(?:localhost|local|internal))$/i.test(normalizedHostname)) {
    throw new StudioError('download-ssrf-blocked', '图片下载地址指向本机或内部网络', 'sent')
  }
  const literalFamily = isIP(normalizedHostname)
  let addresses: { address: string; family: 4 | 6 }[]
  try {
    addresses = literalFamily
      ? [{ address: normalizedHostname, family: literalFamily as 4 | 6 }]
      : await abortable(lookup(normalizedHostname, { all: true, verbatim: true }), signal) as { address: string; family: 4 | 6 }[]
  } catch (error) {
    if (error instanceof StudioError) throw error
    throw new StudioError('download-dns', '图片下载地址无法安全解析', 'sent', error)
  }
  if (addresses.length === 0 || addresses.some((item) => isPrivateAddress(item.address))) {
    throw new StudioError('download-ssrf-blocked', '图片下载地址解析到了私有、保留或不安全网络', 'sent')
  }
  return addresses
}

const resolvedRedirect = (location: string, base: URL): string => {
  try {
    return new URL(location, base).toString()
  } catch (error) {
    throw new StudioError('download-redirect-invalid', '图片下载地址返回了无效重定向', 'sent', error)
  }
}

const safeDownloadOnce = async (url: URL, maximumBytes: number, signal?: AbortSignal): Promise<{ bytes: Uint8Array; redirect?: string }> => {
  if (url.protocol !== 'https:') throw new StudioError('download-protocol', '远程图片只允许通过 HTTPS 下载', 'sent')
  if (url.username || url.password) throw new StudioError('download-credentials', '图片 URL 不能包含凭据', 'sent')
  const addresses = await publicAddresses(url.hostname, signal)
  const selected = addresses[0]
  if (!selected) throw new StudioError('download-dns', '图片下载地址无法解析', 'sent')
  return new Promise((resolve, reject) => {
    let settled = false
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      reject(error instanceof StudioError ? error : new StudioError('download-failed', '安全图片下载失败', 'sent', error))
    }
    const request = https.request(url, {
      method: 'GET',
      headers: { Accept: 'image/png,image/jpeg,image/webp,image/gif' },
      lookup: (_hostname, _options, callback) => callback(null, selected.address, selected.family),
    }, (response) => {
      const status = response.statusCode ?? 0
      const location = response.headers.location
      if (status >= 300 && status < 400 && location) {
        response.resume()
        let redirect: string
        try {
          redirect = resolvedRedirect(location, url)
        } catch (error) {
          fail(error)
          return
        }
        settled = true
        resolve({ bytes: new Uint8Array(), redirect })
        return
      }
      if (status < 200 || status >= 300) {
        response.resume()
        fail(new StudioError('download-http-error', `图片下载失败（HTTP ${status}）`, 'sent'))
        return
      }
      const contentType = String(response.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase()
      if (!['', 'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/octet-stream', 'binary/octet-stream'].includes(contentType ?? '')) {
        response.resume()
        fail(new StudioError('download-content-type', '图片 URL 返回了非图片内容', 'sent'))
        return
      }
      const declared = Number(response.headers['content-length'] ?? 0)
      if (declared > maximumBytes) {
        response.destroy()
        fail(new StudioError('image-too-large', '远程图片超过大小限制', 'sent'))
        return
      }
      const chunks: Buffer[] = []
      let total = 0
      response.on('data', (chunk: Buffer) => {
        total += chunk.byteLength
        if (total > maximumBytes) {
          response.destroy(new StudioError('image-too-large', '远程图片超过大小限制', 'sent'))
          return
        }
        chunks.push(chunk)
      })
      response.on('error', fail)
      response.on('end', () => {
        if (settled) return
        const bytes = Buffer.concat(chunks)
        detectImage(bytes)
        settled = true
        resolve({ bytes })
      })
    })
    request.once('error', fail)
    const abort = (): void => {
      request.destroy(new StudioError('download-cancelled', '图片下载已取消', 'sent'))
    }
    signal?.addEventListener('abort', abort, { once: true })
    request.once('close', () => signal?.removeEventListener('abort', abort))
    request.end()
  })
}

export const safeDownloadImage = async (input: string, maximumBytes: number, signal?: AbortSignal): Promise<ProviderImage> => {
  let url: URL
  try {
    url = new URL(input)
  } catch (error) {
    throw new StudioError('download-url-invalid', '接口返回了无效的图片 URL', 'sent', error)
  }
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const result = await safeDownloadOnce(url, maximumBytes, signal)
    if (!result.redirect) return { bytes: result.bytes, mediaType: detectImage(result.bytes) }
    url = new URL(result.redirect)
  }
  throw new StudioError('download-redirect-limit', '图片下载重定向次数过多', 'sent')
}

const parseImageResponse = async (
  response: Response,
  context: ProviderRequestContext,
  expectedCount: number,
): Promise<readonly ProviderImage[]> => {
  if (!response.ok) {
    throw new StudioError('provider-http-error', `接口请求失败：${await errorMessage(response)}`, 'sent')
  }
  const maximumJsonBytes = Math.min(600_000_000, context.descriptor.maxImageBytes * Math.max(1, expectedCount) * 2 + 2_000_000)
  let parsed: z.infer<typeof imageResponseSchema>
  try {
    parsed = imageResponseSchema.parse(await responseJson(response, maximumJsonBytes))
  } catch (error) {
    if (error instanceof StudioError) throw error
    throw new StudioError('provider-response-schema', '接口图片响应结构不兼容', 'sent', error)
  }
  if (parsed.data.length > expectedCount) {
    throw new StudioError('provider-image-count', '接口返回的图片数量超过请求数量，已拒绝保存', 'sent')
  }
  const images: ProviderImage[] = []
  for (const item of parsed.data) {
    const revisedPrompt = item.revised_prompt?.trim()
    if (item.b64_json) {
      context.onPhase?.('decode', 'start')
      try {
        images.push({
          ...decodeBase64Image(item.b64_json, context.descriptor.maxImageBytes),
          ...(revisedPrompt ? { revisedPrompt } : {}),
        })
      } finally {
        context.onPhase?.('decode', 'finish')
      }
    } else if (item.url?.startsWith('data:')) {
      context.onPhase?.('decode', 'start')
      try {
        images.push({
          ...decodeBase64Image(item.url, context.descriptor.maxImageBytes),
          ...(revisedPrompt ? { revisedPrompt } : {}),
        })
      } finally {
        context.onPhase?.('decode', 'finish')
      }
    } else if (item.url) {
      context.onPhase?.('download', 'start')
      try {
        images.push({
          ...(await safeDownloadImage(item.url, context.descriptor.maxImageBytes, context.signal)),
          ...(revisedPrompt ? { revisedPrompt } : {}),
        })
      } finally {
        context.onPhase?.('download', 'finish')
      }
    }
    else throw new StudioError('provider-missing-image', '接口响应没有 b64_json 或 url 图片', 'sent')
  }
  return images
}

const maximumImageResponseBytes = (
  context: ProviderRequestContext,
  expectedCount: number,
  streamed: boolean,
): number => Math.min(
  600_000_000,
  context.descriptor.maxImageBytes * Math.max(1, expectedCount) * (streamed ? 4 : 2) + 2_000_000,
)

const decodeCompletedStreamImage = (
  event: z.infer<typeof imageStreamEventSchema>,
  context: ProviderRequestContext,
): ProviderImage => {
  if (!event.b64_json) {
    throw new StudioError(
      'provider-stream-completed-invalid',
      '图片流的完成事件没有包含完整图片',
      'sent',
    )
  }
  const revisedPrompt = event.revised_prompt?.trim()
  context.onPhase?.('decode', 'start')
  try {
    return {
      ...decodeBase64Image(event.b64_json, context.descriptor.maxImageBytes),
      ...(revisedPrompt ? { revisedPrompt } : {}),
    }
  } finally {
    context.onPhase?.('decode', 'finish')
  }
}

const parseImageStreamFrame = (
  frame: string,
  context: ProviderRequestContext,
): ProviderImage | undefined => {
  const dataLines: string[] = []
  let declaredEvent = ''
  for (const line of frame.split('\n')) {
    if (!line || line.startsWith(':')) continue
    const separator = line.indexOf(':')
    const field = separator < 0 ? line : line.slice(0, separator)
    let value = separator < 0 ? '' : line.slice(separator + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') declaredEvent = value
    else if (field === 'data') dataLines.push(value)
  }
  if (dataLines.length === 0) return undefined
  const data = dataLines.join('\n')
  if (data.trim() === '[DONE]') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(data) as unknown
  } catch (error) {
    throw new StudioError('provider-stream-invalid', '图片流包含无效事件数据', 'sent', error)
  }
  let event: z.infer<typeof imageStreamEventSchema>
  try {
    event = imageStreamEventSchema.parse(parsed)
  } catch (error) {
    throw new StudioError('provider-stream-invalid', '图片流事件结构不兼容', 'sent', error)
  }
  if (declaredEvent && declaredEvent !== event.type) {
    throw new StudioError('provider-stream-invalid', '图片流事件类型不一致', 'sent')
  }
  if (event.type === 'image_generation.partial_image') return undefined
  if (event.type === 'image_generation.completed') return decodeCompletedStreamImage(event, context)
  if (event.type === 'error' || event.type.endsWith('.failed')) {
    throw new StudioError('provider-stream-failed', '图片生成流报告失败', 'sent')
  }
  return undefined
}

const parseImageStreamResponse = async (
  response: Response,
  context: ProviderRequestContext,
  expectedCount: number,
): Promise<readonly ProviderImage[]> => {
  if (!response.ok) {
    throw new StudioError('provider-http-error', `接口请求失败：${await errorMessage(response)}`, 'sent')
  }
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'text/event-stream') {
    return parseImageResponse(response, context, expectedCount)
  }

  const maximumBytes = maximumImageResponseBytes(context, expectedCount, true)
  const declaredBytes = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(declaredBytes) && declaredBytes > maximumBytes) {
    throw new StudioError('response-too-large', `接口响应超过大小限制（${maximumBytes} 字节）`, 'sent')
  }
  if (!response.body) {
    throw new StudioError('provider-stream-incomplete', '图片生成流未返回完成事件', 'sent')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const images: ProviderImage[] = []
  const maximumEvents = Math.min(512, Math.max(64, expectedCount * 8))
  const maximumEventCharacters = Math.min(maximumBytes, context.descriptor.maxImageBytes * 2 + 1_000_000)
  let totalBytes = 0
  let eventCount = 0
  let pending = ''
  let trailingCarriageReturn = false

  const appendDecoded = (decoded: string, final = false): void => {
    let input = `${trailingCarriageReturn ? '\r' : ''}${decoded}`
    trailingCarriageReturn = false
    if (!final && input.endsWith('\r')) {
      trailingCarriageReturn = true
      input = input.slice(0, -1)
    }
    pending += input.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
  }

  const consumeFrames = (flush = false): void => {
    let boundary = pending.indexOf('\n\n')
    while (boundary >= 0) {
      const frame = pending.slice(0, boundary)
      pending = pending.slice(boundary + 2)
      if (frame.trim()) {
        if (frame.length > maximumEventCharacters) {
          throw new StudioError('response-too-large', `接口响应超过大小限制（${maximumBytes} 字节）`, 'sent')
        }
        eventCount += 1
        if (eventCount > maximumEvents) {
          throw new StudioError('provider-stream-limit', '图片流事件数量超过限制', 'sent')
        }
        const image = parseImageStreamFrame(frame, context)
        if (image) {
          images.push(image)
          if (images.length > expectedCount) {
            throw new StudioError('provider-image-count', '接口返回的图片数量超过请求数量，已拒绝保存', 'sent')
          }
        }
      }
      boundary = pending.indexOf('\n\n')
    }
    if (flush && pending.trim()) {
      if (pending.length > maximumEventCharacters) {
        throw new StudioError('response-too-large', `接口响应超过大小限制（${maximumBytes} 字节）`, 'sent')
      }
      eventCount += 1
      if (eventCount > maximumEvents) {
        throw new StudioError('provider-stream-limit', '图片流事件数量超过限制', 'sent')
      }
      const image = parseImageStreamFrame(pending, context)
      if (image) {
        images.push(image)
        if (images.length > expectedCount) {
          throw new StudioError('provider-image-count', '接口返回的图片数量超过请求数量，已拒绝保存', 'sent')
        }
      }
      pending = ''
    }
    if (pending.length > maximumEventCharacters) {
      throw new StudioError('response-too-large', `接口响应超过大小限制（${maximumBytes} 字节）`, 'sent')
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > maximumBytes) {
        await reader.cancel().catch(() => undefined)
        throw new StudioError('response-too-large', `接口响应超过大小限制（${maximumBytes} 字节）`, 'sent')
      }
      appendDecoded(decoder.decode(value, { stream: true }))
      consumeFrames()
    }
    appendDecoded(decoder.decode(), true)
    consumeFrames(true)
  } catch (error) {
    if (error instanceof StudioError) throw error
    throw new StudioError('response-read-failed', '读取图片生成流时连接中断', 'sent', error)
  }

  if (images.length === 0) {
    throw new StudioError('provider-stream-incomplete', '图片生成流未返回完成事件', 'sent')
  }
  return images
}

const validateCommonImageRequest = (request: ImageGenerationRequest): void => {
  if (!request.model.trim() || request.model !== request.model.trim() || request.model.length > 256 || /[\u0000-\u001f]/.test(request.model)) {
    throw new StudioError('image-model-invalid', '模型 ID 不能为空、带首尾空白或控制字符，且不能超过 256 个字符')
  }
  if (!request.prompt.trim() || request.prompt.length > 256_000) {
    throw new StudioError('image-prompt-invalid', '提示词必须为 1–256000 个字符')
  }
  if (!Number.isSafeInteger(request.count) || request.count < 1 || request.count > 10) {
    throw new StudioError('image-count-invalid', '单次图片数量必须为 1–10')
  }
  if (request.size !== undefined && (!request.size.trim() || request.size.length > 64 || /[\u0000-\u001f]/.test(request.size))) {
    throw new StudioError('image-size-invalid', '图片尺寸参数为空、过长或包含控制字符')
  }
  if (request.quality !== undefined && (!request.quality.trim() || request.quality.length > 64 || /[\u0000-\u001f]/.test(request.quality))) {
    throw new StudioError('image-quality-invalid', '图片质量参数为空、过长或包含控制字符')
  }
  if (request.responseFormat !== undefined && !['url', 'b64_json'].includes(request.responseFormat)) {
    throw new StudioError('image-response-format-invalid', '响应格式只能是 url 或 b64_json')
  }
  if (request.outputFormat !== undefined && !['png', 'jpeg', 'webp'].includes(request.outputFormat)) {
    throw new StudioError('image-output-format-invalid', '输出格式只能是 png、jpeg 或 webp')
  }
  if (request.outputCompression !== undefined
    && (!Number.isInteger(request.outputCompression) || request.outputCompression < 0 || request.outputCompression > 100)) {
    throw new StudioError('image-compression-invalid', '输出压缩质量必须是 0–100 的整数')
  }
  if (request.background !== undefined && !['transparent', 'opaque', 'auto'].includes(request.background)) {
    throw new StudioError('image-background-invalid', '背景模式只能是 transparent、opaque 或 auto')
  }
  if (request.moderation !== undefined && !['low', 'auto'].includes(request.moderation)) {
    throw new StudioError('image-moderation-invalid', '内容审核级别只能是 low 或 auto')
  }
}

const validateGptImage2Request = (request: ImageGenerationRequest): void => {
  if (!request.prompt.trim() || request.prompt.length > 32_000) {
    throw new StudioError('gpt-image-2-prompt-invalid', 'GPT Image 2 提示词必须为 1–32000 个字符')
  }
  if (!Number.isSafeInteger(request.count) || request.count < 1 || request.count > 10) {
    throw new StudioError('gpt-image-2-count-invalid', 'GPT Image 2 单次图片数量必须为 1–10')
  }
  if (request.quality && !['auto', 'low', 'medium', 'high'].includes(request.quality)) {
    throw new StudioError('gpt-image-2-quality-invalid', 'GPT Image 2 质量只能是 auto、low、medium 或 high')
  }
  if (request.background === 'transparent') {
    throw new StudioError('gpt-image-2-transparent-unsupported', 'GPT Image 2 当前不支持透明背景；请改为 auto 或 opaque')
  }
  if (request.outputCompression !== undefined
    && (!Number.isInteger(request.outputCompression) || request.outputCompression < 0 || request.outputCompression > 100)) {
    throw new StudioError('gpt-image-2-compression-invalid', '输出压缩质量必须是 0–100 的整数')
  }
}

export const generateImages = async (
  context: ProviderRequestContext,
  request: ImageGenerationRequest,
): Promise<readonly ProviderImage[]> => {
  const deadline = AbortSignal.timeout(context.descriptor.timeoutMs)
  const effectiveContext: ProviderRequestContext = {
    ...context,
    signal: context.signal ? AbortSignal.any([context.signal, deadline]) : deadline,
  }
  validateCommonImageRequest(request)
  const gptImage2 = isGptImage2Model(request.model)
  const gptImage = isGptImageModel(request.model)
  if (gptImage2) validateGptImage2Request(request)
  const reserved = /^(?:model|prompt|n|size|quality|response_format|output_format|output_compression|background|moderation|stream|partial_images)$/i
  const extra: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(request.extra ?? {})) {
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(key) || reserved.test(key) || /(?:key|secret|token|authorization|password)/i.test(key)) {
      throw new StudioError('json-field-denied', `不安全或保留的请求扩展字段：${key}`)
    }
    if (typeof value === 'string' || typeof value === 'boolean') extra[key] = value
    else if (typeof value === 'number' && Number.isFinite(value)) extra[key] = value
    else throw new StudioError('json-field-type', `请求扩展字段只能是有限数字、字符串或布尔值：${key}`)
  }
  if (gptImage && Object.keys(extra).some((key) => key.toLowerCase() === 'seed')) {
    throw new StudioError('gpt-image-seed-unsupported', 'GPT Image 系列不支持 seed')
  }
  try {
    const url = buildImagesGenerationRequestUrl(
      context.descriptor.baseUrl,
      context.descriptor.imageGenerationPath,
    )
    const body = (streamed: boolean): Record<string, unknown> => gptImage
      ? {
          ...extra,
          model: request.model,
          prompt: request.prompt,
          size: request.size,
          quality: request.quality || undefined,
          n: request.count,
          output_format: request.outputFormat,
          output_compression: request.outputFormat === 'jpeg' || request.outputFormat === 'webp'
            ? request.outputCompression
            : undefined,
          background: request.background,
          moderation: request.moderation,
          ...(streamed ? { stream: true, partial_images: 1 } : {}),
        }
      : {
          ...extra,
          model: request.model,
          prompt: request.prompt,
          size: request.size,
          quality: request.quality || undefined,
          n: request.count,
          response_format: request.responseFormat,
        }
    const send = async (streamed: boolean, dispatchAlreadyRecorded = false): Promise<Response> => providerFetch(
      effectiveContext,
      url,
      {
        method: 'POST',
        headers: authorizedHeaders(context.apiKey, {
          'Content-Type': 'application/json',
          ...(streamed ? { Accept: 'text/event-stream' } : {}),
        }),
        body: JSON.stringify(body(streamed)),
      },
      true,
      { dispatchAlreadyRecorded },
    )

    let streamed = gptImage
    let response = await send(streamed)
    if (streamed && !response.ok && await explicitlyRejectsImageStreaming(response)) {
      response = await send(false, true)
      streamed = false
    }
    return await (streamed
      ? parseImageStreamResponse(response, effectiveContext, request.count)
      : parseImageResponse(response, effectiveContext, request.count))
  } catch (error) {
    throw actionableImageGenerationError(
      error,
      request.model,
      context.descriptor.availableModels ?? [],
    )
  }
}

/**
 * Performs one explicit, billable Images request. A capability is confirmed
 * only after the response has produced a complete supported image.
 */
export const verifyImageGenerationCapability = async (
  context: ProviderRequestContext,
  modelId: string,
): Promise<StudioImageCapabilityProof> => {
  const images = await generateImages(context, {
    model: modelId,
    prompt: 'A simple black square centered on a plain white background.',
    count: 1,
  })
  const image = images[0]
  if (!image || image.bytes.byteLength < 1) {
    throw new StudioError(
      'provider-image-capability-unconfirmed',
      '图片接口没有返回可验证的完整图片，未记录该模型能力',
      'sent',
    )
  }
  return Object.freeze({
    mediaType: image.mediaType,
    byteLength: image.bytes.byteLength,
  })
}

const safeMultipartExtra = (extra: ImageGenerationRequest['extra']): readonly [string, string][] => {
  if (!extra) return []
  const reserved = /^(?:model|prompt|n|size|quality|output_format|output_compression|background|moderation|input_fidelity|image|images|mask|stream|partial_images)$/i
  return Object.entries(extra).map(([key, value]) => {
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(key) || reserved.test(key) || /(?:key|secret|token|authorization|password|cookie)/i.test(key)) {
      throw new StudioError('multipart-field-denied', `不安全的 multipart 扩展字段：${key}`)
    }
    if (!['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) {
      throw new StudioError('multipart-field-type', `multipart 扩展字段类型不安全：${key}`)
    }
    return [key, String(value)] as const
  })
}

export const editImages = async (
  context: ProviderRequestContext,
  request: ImageEditRequest,
  sourceInput: ProviderImage | readonly ProviderImage[],
  mask?: ProviderImage,
): Promise<readonly ProviderImage[]> => {
  const sources = Array.isArray(sourceInput) ? sourceInput : [sourceInput]
  const source = sources[0]
  if (!source) throw new StudioError('source-image-required', '请连接至少一张源图片')
  if (sources.length > 16) {
    throw new StudioError('reference-image-count-invalid', '一次最多可使用 16 张参考图')
  }
  validateCommonImageRequest(request)
  if (context.descriptor.imageGenerationPath !== undefined && context.descriptor.imageEditPath === undefined) {
    throw new StudioError(
      'account-provider-edit-endpoint-unavailable',
      '登录账户声明的 image-generation 路径无法安全派生图片编辑地址',
      'not_sent',
    )
  }
  if (!['edit', 'inpaint', 'outpaint'].includes(request.operation)) {
    throw new StudioError('image-edit-operation-invalid', '图片编辑操作只能是 edit、inpaint 或 outpaint')
  }
  if (request.inputFidelity !== undefined && !['low', 'high'].includes(request.inputFidelity)) {
    throw new StudioError('image-input-fidelity-invalid', '输入保真度只能是 low 或 high')
  }
  const gptImage2 = isGptImage2Model(request.model)
  if (gptImage2) validateGptImage2Request(request)
  if (request.operation === 'inpaint' && (!mask || mask.mediaType !== 'image/png')) {
    throw new StudioError('inpaint-mask-required', '局部重绘必须提供完整的 PNG 蒙版')
  }
  if (request.operation === 'inpaint' && mask && ![4, 6].includes(mask.bytes[25] ?? -1)) {
    throw new StudioError('inpaint-mask-alpha-required', '局部重绘 PNG 蒙版必须包含 Alpha 通道')
  }
  if (mask) {
    if (gptImage2 && source.mediaType !== mask.mediaType) {
      throw new StudioError('gpt-image-2-mask-format-mismatch', 'GPT Image 2 的源图与蒙版必须使用相同格式；局部重绘请使用 PNG 源图')
    }
    const sourceDimensions = imageDimensions(source.bytes, source.mediaType)
    const maskDimensions = imageDimensions(mask.bytes, mask.mediaType)
    if (sourceDimensions && maskDimensions
      && (sourceDimensions.width !== maskDimensions.width || sourceDimensions.height !== maskDimensions.height)) {
      throw new StudioError(
        'edit-mask-dimensions-mismatch',
        `蒙版尺寸 ${maskDimensions.width}×${maskDimensions.height} 与源图 ${sourceDimensions.width}×${sourceDimensions.height} 不一致`,
      )
    }
  }
  const gptImage2MaximumInputBytes = 50 * 1024 * 1024
  if (gptImage2 && (sources.some((item) => item.bytes.byteLength >= gptImage2MaximumInputBytes) || (mask?.bytes.byteLength ?? 0) >= gptImage2MaximumInputBytes)) {
    throw new StudioError('gpt-image-2-input-too-large', 'GPT Image 2 的每张参考图和蒙版必须分别小于 50 MiB')
  }
  const deadline = AbortSignal.timeout(context.descriptor.timeoutMs)
  const effectiveContext: ProviderRequestContext = {
    ...context,
    signal: context.signal ? AbortSignal.any([context.signal, deadline]) : deadline,
  }
  const form = new FormData()
  for (const [key, value] of safeMultipartExtra(request.extra)) form.set(key, value)
  form.set('model', request.model)
  form.set('prompt', request.prompt)
  form.set('n', String(request.count))
  if (request.size) form.set('size', request.size)
  if (request.quality) form.set('quality', request.quality)
  if (request.outputFormat) form.set('output_format', request.outputFormat)
  if ((request.outputFormat === 'jpeg' || request.outputFormat === 'webp') && request.outputCompression !== undefined) {
    form.set('output_compression', String(request.outputCompression))
  }
  if (request.background) form.set('background', request.background)
  if (request.moderation) form.set('moderation', request.moderation)
  if (request.inputFidelity && !gptImage2) form.set('input_fidelity', request.inputFidelity)
  const imageField = usesImageArrayFormField(request.model) ? 'image[]' : 'image'
  const uploadedSources = usesImageArrayFormField(request.model) ? sources : sources.slice(0, 1)
  uploadedSources.forEach((item, index) => {
    const sourceCopy = Uint8Array.from(item.bytes)
    form.append(imageField, new Blob([sourceCopy.buffer], { type: item.mediaType }), `source-${index + 1}.${item.mediaType.split('/')[1]}`)
  })
  if (mask) {
    const maskCopy = Uint8Array.from(mask.bytes)
    form.set('mask', new Blob([maskCopy.buffer], { type: mask.mediaType }), `mask.${mask.mediaType.split('/')[1]}`)
  }
  const response = await providerFetch(effectiveContext, buildImagesEditRequestUrl(
    context.descriptor.baseUrl,
    context.descriptor.imageEditPath,
  ), {
    method: 'POST',
    headers: authorizedHeaders(context.apiKey),
    body: form,
  }, true)
  return parseImageResponse(response, effectiveContext, request.count)
}

export const probeProvider = async (context: ProviderRequestContext): Promise<readonly string[]> => {
  const response = await providerFetch(context, buildStudioModelsRequestUrl(context.descriptor.baseUrl), {
    method: 'GET',
    headers: authorizedHeaders(context.apiKey),
  }, false)
  if (!response.ok) throw new StudioError('provider-probe-failed', `接口探测失败：${await errorMessage(response)}`, 'sent')
  const parsed = z.object({ data: z.array(z.object({ id: z.string() }).passthrough()).default([]) }).passthrough()
    .parse(await responseJson(response, 4_194_304))
  return parsed.data.map((model) => model.id)
}

export const loadLocalImage = async (filePath: string, maximumBytes: number): Promise<ProviderImage> => {
  const { readFile, stat } = await import('node:fs/promises')
  const details = await stat(filePath)
  if (!details.isFile() || details.size > maximumBytes) throw new StudioError('invalid-source-image', '源图片不存在或超过大小限制')
  const bytes = await readFile(filePath)
  return { bytes, mediaType: detectImage(bytes) }
}

export {
  endpointUrl as buildProviderEndpoint,
  detectImage,
  isPrivateAddress as isUnsafeDownloadAddress,
  resolvedRedirect as resolveDownloadRedirect,
  responseBytes as readBoundedResponse,
}
