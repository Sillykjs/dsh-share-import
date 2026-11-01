/**
 * Public share links: link parsing, content fetch and payload reading.
 *
 * Two sources are readable without any credential, and they publish
 * differently:
 *
 * - `chat.deepseek.com` — `GET /api/v0/share/content?share_id=<id>` answers
 *   anonymously with the whole conversation as JSON.
 * - `www.doubao.com` — some ids answer a JSON snapshot route
 *   (`/im/message/share/get` for `x`-prefixed mobile shares,
 *   `/alice/message/share/get` for the rest), and the share page itself is
 *   server-rendered, so one `GET /thread/<id>` also carries the conversation in
 *   its HTML (see `./doubao.js`). The JSON route is tried first because the
 *   page routes `x` ids through a lazy shell that holds no messages.
 *
 * This module owns every detail of both exchanges so the rest of the plugin
 * only sees messages: `readShareDocument` returns the message list whichever
 * source the link named.
 *
 * @module dsh-share-import/share
 */
import {
  DOUBAO_HOSTS,
  doubaoShareUrl,
  doubaoSnapshotRequest,
  readDoubaoPage,
  readDoubaoSnapshot,
} from './doubao.js'
import { ShareError } from './errors.js'

export { ShareError }

/** The DeepSeek host a share link may point at. */
export const SHARE_HOST = 'chat.deepseek.com'

/** Share ids are URL-safe tokens; the exact length has varied by release. */
const SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{6,64}$/

/** Upper bound on the document this plugin is willing to read, in bytes. */
const MAX_CONTENT_BYTES = 8 * 1024 * 1024

/** Timeout for one fetch, in milliseconds. */
const DEFAULT_TIMEOUT_MS = 20000

/** Server-rendered Doubao pages embed their data in one of these markers. */
const DOUBAO_MARKUP = /data-fn-args|data-fn-name|needLazyLoadThreadMsg/u

/**
 * Whether a body already is the JSON document the DeepSeek share API returns.
 * A rendering fetch provider turns JSON into prose, and that prose must not be
 * mistaken for the API answer.
 * @param {string} text - a fetched body.
 * @returns {boolean} true when the body parses as JSON.
 */
function isJsonText(text) {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/**
 * Whether a body is the server-rendered Doubao share page rather than a text
 * rendering of it. Deliberately loose: a page that lacks the markers is still
 * handed to the Doubao reader, which decides between "deleted", "lazy-loaded"
 * and "malformed".
 * @param {string} text - a fetched body.
 * @returns {boolean} true when the body looks like the rendered page.
 */
function isDoubaoMarkup(text) {
  return DOUBAO_MARKUP.test(text)
}

/**
 * Pull the share target out of user input.
 *
 * Accepts a bare DeepSeek share id (historical behaviour, ids are opaque),
 * `https://chat.deepseek.com/share/<id>`, a DeepSeek URL carrying
 * `?share_id=<id>`, or `https://www.doubao.com/thread/<id>`.
 *
 * @param {unknown} input - whatever the user pasted.
 * @returns {{source: 'deepseek'|'doubao', id: string}} the target.
 * @throws {ShareError} `SHARE_LINK_INVALID` when nothing usable is found.
 */
export function parseShareLink(input) {
  const text = typeof input === 'string' ? input.trim() : ''
  if (text.length === 0) throw new ShareError('SHARE_LINK_INVALID', '请粘贴分享链接')
  /* A bare token is a DeepSeek share id: it predates Doubao support and Doubao
     links always carry a host, so there is nothing ambiguous to resolve. */
  if (SHARE_ID_PATTERN.test(text)) return { source: 'deepseek', id: text }

  let url
  try {
    url = new URL(text)
  } catch {
    throw new ShareError('SHARE_LINK_INVALID', '这不是一个有效的链接')
  }
  if (url.protocol !== 'https:') {
    throw new ShareError('SHARE_LINK_INVALID', '只支持 https 链接')
  }
  const host = url.hostname.toLowerCase()
  if (host === SHARE_HOST) {
    const fromQuery = url.searchParams.get('share_id')
    if (fromQuery !== null && SHARE_ID_PATTERN.test(fromQuery)) return { source: 'deepseek', id: fromQuery }
    const match = /^\/share\/([A-Za-z0-9_-]{6,64})\/?$/u.exec(url.pathname)
    if (match !== null) return { source: 'deepseek', id: match[1] }
    throw new ShareError('SHARE_LINK_INVALID', 'DeepSeek 链接里没有找到分享 ID')
  }
  if (DOUBAO_HOSTS.includes(host)) {
    const match = /^\/thread\/([A-Za-z0-9_-]{6,64})\/?$/u.exec(url.pathname)
    if (match !== null) return { source: 'doubao', id: match[1] }
    throw new ShareError('SHARE_LINK_INVALID', '豆包链接里没有找到分享 ID（只支持 /thread/<id>）')
  }
  throw new ShareError('SHARE_LINK_INVALID', '只支持 chat.deepseek.com 或 doubao.com 的分享链接')
}

/**
 * The JSON endpoint that serves one DeepSeek share's content.
 * @param {string} shareId - the share id.
 * @returns {string} the absolute URL.
 */
export function shareContentUrl(shareId) {
  return 'https://' + SHARE_HOST + '/api/v0/share/content?share_id=' + encodeURIComponent(shareId)
}

/**
 * Transfer one text document out of a share page.
 *
 * Prefers the Web runtime's own fetch seam (`ctx.web.fetch`): that seam is the
 * deployment's outbound policy (public targets only, same-origin redirects,
 * bounded body). Some compositions point it at a provider that renders the page
 * for a model instead of returning the raw response body — good for reading
 * prose, but it drops the server-embedded JSON a share page carries. Callers
 * therefore pass `options.isUsable`, and when the seam's text fails that check
 * (or the seam is absent, or it errors) this reads the raw body itself with the
 * platform `fetch`, still only for a URL this module built from a validated
 * share id. A raw body that simply fails the shape check is still returned, so
 * the source readers keep their own distinction between "deleted", "lazy" and
 * "malformed" shares.
 *
 * @param {object} ctx - the plugin context.
 * @param {string} url - the absolute URL to GET.
 * @param {string} accept - the Accept header the raw fetch asks for.
 * @param {{timeoutMs?: number, isUsable?: (text: string) => boolean}} [options]
 *   timeouts and the shape check this caller needs.
 * @returns {Promise<string>} the response body as text.
 * @throws {ShareError} on network, HTTP or size failures.
 */
async function fetchShareText(ctx, url, accept, options = {}) {
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS
  const isUsable = typeof options.isUsable === 'function' ? options.isUsable : null
  const usable = (text) => text !== '' && text.length <= MAX_CONTENT_BYTES
    && (isUsable === null || isUsable(text))
  const signal = AbortSignal.timeout(timeoutMs)

  const web = typeof ctx?.get === 'function' ? ctx.get('web') : undefined
  let seamText = ''
  let seamError = null
  if (web !== undefined && typeof web.fetch === 'function') {
    try {
      const result = await web.fetch({ url }, signal)
      if (result.statusCode < 200 || result.statusCode >= 300) {
        seamError = new ShareError('SHARE_FETCH_FAILED', '分享接口返回 HTTP ' + result.statusCode)
      } else {
        seamText = String(result.body && result.body.content !== undefined ? result.body.content : '')
      }
    } catch (error) {
      seamError = error instanceof ShareError
        ? error
        : new ShareError('SHARE_FETCH_FAILED', '无法获取分享内容：' + String((error && error.message) || error))
    }
  }
  if (usable(seamText)) return seamText

  let directError = null
  try {
    const response = await fetch(url, {
      signal,
      headers: { Accept: accept, 'User-Agent': 'dsh-share-import' },
      redirect: 'error',
    })
    if (!response.ok) throw new ShareError('SHARE_FETCH_FAILED', '分享接口返回 HTTP ' + response.status)
    const text = await response.text()
    if (text.length > MAX_CONTENT_BYTES) throw new ShareError('SHARE_FETCH_FAILED', '分享内容过大，已放弃')
    return text
  } catch (error) {
    directError = error instanceof ShareError
      ? error
      : new ShareError('SHARE_FETCH_FAILED', '无法获取分享内容：' + String((error && error.message) || error))
  }

  if (directError !== null) throw directError
  if (seamError !== null) throw seamError
  throw new ShareError('SHARE_FETCH_FAILED', '无法获取分享内容：分享页响应为空')
}

/**
 * Fetch one DeepSeek share's JSON document.
 * @param {object} ctx - the plugin context.
 * @param {string} shareId - the share id.
 * @param {{timeoutMs?: number}} [options] - timeouts.
 * @returns {Promise<object>} the parsed JSON document.
 * @throws {ShareError} on network, HTTP, size or JSON failures.
 */
/**
 * POST a JSON body and read the JSON answer.
 *
 * The web fetch seam is a GET-only contract (`WebFetchRequest` is `{url}`), and
 * a GET cannot ask Doubao's share API for a snapshot, so this one exchange uses
 * the platform `fetch`. The URL is still one this module built from a validated
 * share id, and redirects stay refused.
 *
 * @param {object} ctx - the plugin context (unused today, kept for symmetry).
 * @param {string} url - the absolute URL to POST to.
 * @param {object} payload - the JSON body.
 * @param {{timeoutMs?: number}} [options] - timeouts.
 * @returns {Promise<object>} the decoded JSON answer.
 * @throws {ShareError} on network, HTTP, size or JSON failures.
 */
async function fetchShareJson(ctx, url, payload, options = {}) {
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS
  const signal = AbortSignal.timeout(timeoutMs)
  let text
  try {
    const response = await fetch(url, {
      method: 'POST',
      signal,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'dsh-share-import',
      },
      body: JSON.stringify(payload),
      redirect: 'error',
    })
    if (!response.ok) throw new ShareError('SHARE_FETCH_FAILED', '分享接口返回 HTTP ' + response.status)
    text = await response.text()
  } catch (error) {
    if (error instanceof ShareError) throw error
    throw new ShareError('SHARE_FETCH_FAILED', '无法获取分享内容：' + String((error && error.message) || error))
  }
  if (text.length > MAX_CONTENT_BYTES) throw new ShareError('SHARE_FETCH_FAILED', '分享内容过大，已放弃')
  try {
    return JSON.parse(text)
  } catch {
    throw new ShareError('SHARE_MALFORMED', '分享接口没有返回 JSON（分享可能已过期）')
  }
}

/** Read one Doubao share through the JSON route first, the page second. */
async function readDoubaoTarget(ctx, shareId, options = {}) {
  const request = doubaoSnapshotRequest(shareId)
  let jsonError = null
  if (request !== null) {
    try {
      const snapshot = readDoubaoSnapshot(await fetchShareJson(ctx, request.url, request.payload, options))
      if (snapshot.messages.length > 0) return snapshot
      jsonError = new ShareError('SHARE_MALFORMED', '分享快照里没有对话内容')
    } catch (error) {
      jsonError = error instanceof ShareError
        ? error
        : new ShareError('SHARE_FETCH_FAILED', '无法获取分享内容：' + String((error && error.message) || error))
    }
  }

  let page
  try {
    page = readDoubaoPage(await fetchDoubaoHtml(ctx, shareId, options))
  } catch (error) {
    /* The page reader's own diagnosis (deleted / malformed) is the fallback
       answer; a JSON route that already explained itself wins over it. */
    if (!(error instanceof ShareError)) throw error
    throw jsonError !== null ? jsonError : error
  }
  if (page.lazy) {
    throw jsonError !== null
      ? jsonError
      : new ShareError('SHARE_LAZY', '这个豆包分享需要登录才能加载完整内容，暂不支持导入')
  }
  return page
}

export async function fetchShareContent(ctx, shareId, options = {}) {
  const text = await fetchShareText(ctx, shareContentUrl(shareId), 'application/json', {
    ...options,
    isUsable: isJsonText,
  })
  try {
    return JSON.parse(text)
  } catch {
    throw new ShareError('SHARE_MALFORMED', '分享接口没有返回 JSON（分享可能已过期）')
  }
}

/**
 * Fetch one Doubao share page's server-rendered HTML.
 * @param {object} ctx - the plugin context.
 * @param {string} shareId - the thread token from the link.
 * @param {{timeoutMs?: number}} [options] - timeouts.
 * @returns {Promise<string>} the HTML.
 * @throws {ShareError} on network, HTTP or size failures.
 */
export async function fetchDoubaoHtml(ctx, shareId, options = {}) {
  return fetchShareText(ctx, doubaoShareUrl(shareId), 'text/html,application/xhtml+xml', {
    ...options,
    isUsable: isDoubaoMarkup,
  })
}

/**
 * Read one share link's document into messages, whichever source it names.
 * @param {object} ctx - the plugin context.
 * @param {{source: string, id: string}|string} target - a parsed target (a bare
 *   id is still accepted and read as a DeepSeek share).
 * @param {{timeoutMs?: number}} [options] - timeouts.
 * @returns {Promise<{source: 'deepseek'|'doubao', shareId: string, title: string, author: string, messages: object[]}>} the reading.
 * @throws {ShareError} on every failure a source reader can report.
 */
export async function readShareDocument(ctx, target, options = {}) {
  if (target === null || typeof target !== 'object' || typeof target.id !== 'string' || target.id.length === 0) {
    throw new ShareError('SHARE_LINK_INVALID', '分享链接无效')
  }
  /* The link's own token is the canonical id: it is what the user pastes again,
     so it is also what the dedupe journal must key on. */
  if (target.source === 'doubao') {
    const reading = await readDoubaoTarget(ctx, target.id, options)
    return {
      source: 'doubao',
      shareId: target.id,
      title: reading.title,
      author: reading.author,
      messages: reading.messages,
    }
  }
  const payload = await fetchShareContent(ctx, target.id, options)
  const { messages, rawTitle } = readSharePayload(payload)
  return { source: 'deepseek', shareId: target.id, title: rawTitle, author: '', messages }
}

/**
 * Read the messages out of a DeepSeek share content document. The document
 * nests them as `data.biz_data.messages`; a couple of wrapper shapes are
 * tolerated because the public endpoint has changed shape before.
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
