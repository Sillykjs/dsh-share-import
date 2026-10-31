/**
 * Public DeepSeek share links: link parsing, content fetch, payload reading.
 *
 * A share is readable without any credential: the web app calls
 * `GET https://chat.deepseek.com/api/v0/share/content?share_id=<id>` anonymously
 * and gets the whole conversation back as JSON. This module owns every detail of
 * that exchange so the rest of the plugin only sees messages.
 *
 * @module dsh-share-import/share
 */

/** The only host a share link may point at. */
export const SHARE_HOST = 'chat.deepseek.com'

/** Share ids are URL-safe tokens; the exact length has varied by release. */
const SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{6,64}$/

/** Upper bound on the JSON document this plugin is willing to read, in bytes. */
const MAX_CONTENT_BYTES = 8 * 1024 * 1024

/** A failure with a stable `code` the client can localize. */
export class ShareError extends Error {
  /**
   * @param {string} code - stable code, upper case.
   * @param {string} message - diagnostic message (may be shown).
   */
  constructor(code, message) {
    super(message)
    this.name = 'ShareError'
    this.code = code
  }
}

/**
 * Pull the share id out of user input: a full share URL, a URL carrying
 * `?share_id=`, or a bare id.
 * @param {unknown} input - whatever the user pasted.
 * @returns {string} the share id.
 * @throws {ShareError} `SHARE_LINK_INVALID` when nothing usable is found.
 */
export function parseShareLink(input) {
  const text = typeof input === 'string' ? input.trim() : ''
  if (text.length === 0) throw new ShareError('SHARE_LINK_INVALID', '请粘贴 DeepSeek 分享链接')
  if (SHARE_ID_PATTERN.test(text)) return text
  let url
  try {
    url = new URL(text)
  } catch {
    throw new ShareError('SHARE_LINK_INVALID', '这不是一个有效的链接')
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== SHARE_HOST) {
    throw new ShareError('SHARE_LINK_INVALID', '只支持 https://' + SHARE_HOST + '/share/... 链接')
  }
  const fromQuery = url.searchParams.get('share_id')
  if (fromQuery !== null && SHARE_ID_PATTERN.test(fromQuery)) return fromQuery
  const match = /^\/share\/([A-Za-z0-9_-]{6,64})\/?$/u.exec(url.pathname)
  if (match !== null) return match[1]
  throw new ShareError('SHARE_LINK_INVALID', '链接里没有找到分享 ID')
}

/**
 * The endpoint that serves one share's content.
 * @param {string} shareId - the share id.
 * @returns {string} the absolute URL.
 */
export function shareContentUrl(shareId) {
  return 'https://' + SHARE_HOST + '/api/v0/share/content?share_id=' + encodeURIComponent(shareId)
}

/**
 * Fetch one share's JSON document.
 *
 * Uses the Web runtime's own fetch seam (`ctx.web.fetch`) when the composition
 * provides it — that seam is the deployment's outbound policy (public targets
 * only, same-origin redirects, bounded body) and it accepts `application/json`.
 * A build without that service falls back to the platform `fetch`, still only
 * for a validated DeepSeek URL.
 *
 * @param {object} ctx - the plugin context.
 * @param {string} shareId - the share id.
 * @param {{timeoutMs?: number}} [options] - timeouts.
 * @returns {Promise<object>} the parsed JSON document.
 * @throws {ShareError} on network, HTTP, size or JSON failures.
 */
export async function fetchShareContent(ctx, shareId, options = {}) {
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 20000
  const url = shareContentUrl(shareId)
  const signal = AbortSignal.timeout(timeoutMs)
  let text = ''
  try {
    const web = typeof ctx?.get === 'function' ? ctx.get('web') : undefined
    if (web !== undefined && typeof web.fetch === 'function') {
      const result = await web.fetch({ url }, signal)
      if (result.statusCode < 200 || result.statusCode >= 300) {
        throw new ShareError('SHARE_FETCH_FAILED', '分享接口返回 HTTP ' + result.statusCode)
      }
      text = String(result.body && result.body.content !== undefined ? result.body.content : '')
    } else {
      const response = await fetch(url, {
        signal,
        headers: { Accept: 'application/json' },
        redirect: 'error',
      })
      if (!response.ok) throw new ShareError('SHARE_FETCH_FAILED', '分享接口返回 HTTP ' + response.status)
      text = await response.text()
    }
  } catch (error) {
    if (error instanceof ShareError) throw error
    const reason = String((error && error.message) || error)
    throw new ShareError('SHARE_FETCH_FAILED', '无法获取分享内容：' + reason)
  }
  if (text.length > MAX_CONTENT_BYTES) throw new ShareError('SHARE_FETCH_FAILED', '分享内容过大，已放弃')
  try {
    return JSON.parse(text)
  } catch {
    throw new ShareError('SHARE_MALFORMED', '分享接口没有返回 JSON（分享可能已过期）')
  }
}

/**
 * Read the messages out of a share content document. The document nests them as
 * `data.biz_data.messages`; a couple of wrapper shapes are tolerated because
 * the public endpoint has changed shape before.
 * @param {unknown} payload - the parsed JSON document.
 * @returns {{messages: object[], rawTitle: string}} the messages and remote title.
 * @throws {ShareError} `SHARE_NOT_FOUND` / `SHARE_MALFORMED` when unusable.
 */
export function readSharePayload(payload) {
  if (payload === null || typeof payload !== 'object') throw new ShareError('SHARE_MALFORMED', '分享内容格式不正确')
  const data = payload.data !== null && typeof payload.data === 'object' ? payload.data : payload
  if (data.biz_code !== undefined && Number(data.biz_code) !== 0) {
    throw new ShareError('SHARE_NOT_FOUND', '分享不存在或已被删除（biz_code ' + Number(data.biz_code) + '）')
  }
  if (payload.code !== undefined && Number(payload.code) !== 0) {
    throw new ShareError('SHARE_NOT_FOUND', '分享不存在或已被删除')
  }
  const biz = data.biz_data !== null && typeof data.biz_data === 'object' ? data.biz_data : data
  const messages = Array.isArray(biz.messages) ? biz.messages : null
  if (messages === null) throw new ShareError('SHARE_MALFORMED', '分享内容里没有消息列表')
  return { messages, rawTitle: typeof biz.title === 'string' ? biz.title : '' }
}

/**
 * A short, human-readable preview of what an import would contain.
 * @param {object[]} messages - importable messages, oldest first.
 * @returns {{rounds: number, questions: number, firstQuestion: string, lastQuestion: string}} the preview.
 */
export function previewSummary(messages) {
  const list = Array.isArray(messages) ? messages : []
  const texts = (role) => list
    .filter((message) => String((message && message.role) || '').toLowerCase() === role)
    .map((message) => firstText(message))
    .filter((text) => text.length > 0)
  const questions = texts('user')
  const answers = texts('assistant')
  const clip = (text) => (text.length > 120 ? text.slice(0, 120) + '…' : text)
  return {
    rounds: answers.length,
    questions: questions.length,
    firstQuestion: clip(questions[0] || ''),
    lastQuestion: clip(questions[questions.length - 1] || ''),
  }
}

/**
 * The first non-empty text of one message, for previews only.
 * @param {object} message - one share message.
 * @returns {string} the text, empty when there is none.
 */
function firstText(message) {
  const fragments = message && Array.isArray(message.fragments) ? message.fragments : []
  for (const fragment of fragments) {
    if (!fragment || typeof fragment.content !== 'string') continue
    const type = String(fragment.type || '').toUpperCase()
    if (type !== 'REQUEST' && type !== 'RESPONSE') continue
    const text = fragment.content.replace(/\s+/gu, ' ').trim()
    if (text.length > 0) return text
  }
  return ''
}
