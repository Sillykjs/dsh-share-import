/**
 * Doubao (doubao.com) share pages: link shape, server-rendered payload and
 * conversation mapping.
 *
 * A Doubao share page is server-rendered: the whole conversation travels in the
 * page's `data-fn-args` attributes, as JSON that has been escaped twice (HTML
 * entities in the attribute, then a JSON string inside the parsed array). Two
 * shapes are known and both are accepted:
 *
 *   1. `data-fn-name="mergeLoaderData"` —
 *      `["thread_(token)/page",[{key:"shareInfo",routerDataFnName:"p",
 *        routerDataFnArgs:["<json string>"]}]]`
 *   2. `data-fn-name="r"` (single-quoted attribute) —
 *      `["thread_(token)/page","shareInfo",{isMobileShareId:…,
 *        needLazyLoadThreadMsg:…,data:{share_info,message_snapshot}}]`
 *
 * The payload itself is:
 *   `share_info`       — title, author, bot name, `share_id`, `message_index_end`
 *   `message_snapshot.message_list[]` — `{index, user_type, content_block[]}`
 *     where `user_type` 1 is a human and 2 is the bot, and every block is
 *     `{block_id, block_type, content}` with `content` another JSON string.
 *     `block_type` 10000 is text; 2074 (images) and 10050 (rich media / video)
 *     carry no text this plugin can render, so they are dropped.
 *
 * `x`-prefixed share ids are lazy-loaded by the web app (`need_lazy_load`), so
 * their HTML holds no messages. Those ids have a public JSON snapshot route
 * instead (`/im/message/share/get`, no credential), and other ids have
 * `/alice/message/share/get`; `doubaoSnapshotRequest` picks the route and
 * `readDoubaoSnapshot` reads its answer. A page that studies nothing remains
 * `SHARE_LAZY`.
 *
 * @module dsh-share-import/doubao
 */
import { ShareError } from './errors.js'

/** Hosts a Doubao share link may point at. */
export const DOUBAO_HOSTS = Object.freeze(['www.doubao.com', 'doubao.com'])

/** Share page path: `/thread/<token>`. */
const SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{6,64}$/

/** Upper bound on one embedded JSON string this module is willing to parse. */
const MAX_EMBEDDED_BYTES = 16 * 1024 * 1024

/** Depth bound for walking unknown payload shapes. */
const MAX_WALK_DEPTH = 12

/** Block type carrying plain text. */
const TEXT_BLOCK_TYPE = 10000

/** Title used when a Doubao share carries no usable question or name. */
export const DOUBAO_FALLBACK_TITLE = '豆包分享导入'

/** Substituted for a message whose only blocks are images or video. */
export const DOUBAO_MEDIA_NOTE = '（这条消息在豆包网页端只有图片或视频，没有文字）'

/**
 * The page URL of one Doubao share.
 * @param {string} shareId - the thread token from the link.
 * @returns {string} the absolute URL.
 */
export function doubaoShareUrl(shareId) {
  return 'https://www.doubao.com/thread/' + encodeURIComponent(shareId)
}

/**
 * Decode the HTML entities Doubao writes into attribute values. `&amp;` must be
 * decoded last, or an escaped entity (`&amp;quot;`) would be decoded twice.
 * @param {string} text - one attribute value.
 * @returns {string} the entity-decoded text.
 */
function decodeHtmlEntities(text) {
  return text
    .replace(/&quot;/gu, '"')
    .replace(/&#x27;/gu, "'")
    .replace(/&#39;/gu, "'")
    .replace(/&#x2F;/gu, '/')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&amp;/gu, '&')
}

/**
 * Parse text that may hold an embedded JSON document. Only objects, arrays and
 * quoted strings are attempted, and only within a size bound: the walker calls
 * this on every string it meets, including ordinary prose.
 * @param {string} text - candidate text.
 * @returns {unknown} the parsed value, or `undefined` when it is not JSON.
 */
function parseEmbeddedJson(text) {
  const trimmed = String(text === undefined || text === null ? '' : text).trim()
  if (trimmed.length === 0 || trimmed.length > MAX_EMBEDDED_BYTES) return undefined
  const first = trimmed[0]
  if (first !== '{' && first !== '[' && first !== '"') return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

/**
 * Whether a node is the payload's own level (`share_info` + `message_snapshot`).
 * @param {unknown} node - candidate node.
 * @returns {boolean} true when it looks like the share document.
 */
function looksLikeShare(node) {
  return node !== null
    && typeof node === 'object'
    && node.share_info !== null
    && typeof node.share_info === 'object'
    && node.message_snapshot !== null
    && typeof node.message_snapshot === 'object'
}

/**
 * Whether a node asks the web app to lazy-load the messages.
 * @param {object} node - candidate node.
 * @returns {boolean} true when either flag spelling is set.
 */
function wantsLazyLoad(node) {
  return node.needLazyLoadThreadMsg === true || node.need_lazy_load_thread_msg === true
}

/**
 * Walk an unknown payload for the share document. Strings are re-parsed when
 * they hold JSON, because both known shapes nest the payload as a JSON string.
 * @param {unknown} value - node to inspect.
 * @param {number} depth - current depth.
 * @returns {{shareInfo: object, snapshot: object, lazy: boolean}|null} the hit.
 */
function findShareNode(value, depth) {
  if (depth > MAX_WALK_DEPTH || value === null || value === undefined) return null
  if (typeof value === 'string') {
    const parsed = parseEmbeddedJson(value)
    return parsed === undefined ? null : findShareNode(parsed, depth + 1)
  }
  if (typeof value !== 'object') return null
  if (looksLikeShare(value)) {
    return { shareInfo: value.share_info, snapshot: value.message_snapshot, lazy: wantsLazyLoad(value) }
  }
  /* Shape 2 wraps the payload in `data` and keeps the lazy flag on the wrapper. */
  if (looksLikeShare(value.data)) {
    return {
      shareInfo: value.data.share_info,
      snapshot: value.data.message_snapshot,
      lazy: wantsLazyLoad(value) || wantsLazyLoad(value.data),
    }
  }
  const children = Array.isArray(value) ? value : Object.values(value)
  for (const child of children) {
    const hit = findShareNode(child, depth + 1)
    if (hit !== null) return hit
  }
  return null
}

/**
 * Flatten one text block's `content` (itself a JSON string) into text.
 * @param {unknown} content - the block content.
 * @returns {string} the text, empty when the block carries none.
 */
function textBlockContent(content) {
  if (typeof content === 'string') {
    const parsed = parseEmbeddedJson(content)
    return parsed === undefined ? content : textBlockContent(parsed)
  }
  if (content === null || typeof content !== 'object') return ''
  if (typeof content.text === 'string') return content.text
  const v2 = content.content_v2
  if (v2 !== null && typeof v2 === 'object') {
    const textBlock = v2.text_block
    if (textBlock !== null && typeof textBlock === 'object' && typeof textBlock.text === 'string') {
      return textBlock.text
    }
  }
  if (typeof content.content === 'string') return content.content
  return ''
}

/**
 * Read one message's text and whether it carried any block at all.
 * @param {object} rawMessage - one snapshot message.
 * @returns {{text: string, hadBlocks: boolean}} the reading.
 */
function messageText(rawMessage) {
  const blocks = messageBlocks(rawMessage)
  const parts = []
  let hadBlocks = false
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue
    hadBlocks = true
    if (Number(block.block_type) !== TEXT_BLOCK_TYPE) continue
    const text = textBlockContent(block.content).trim()
    if (text.length > 0) parts.push(text)
  }
  return { text: parts.join('\n\n').trim(), hadBlocks }
}

/**
 * Read one message's wall-clock time as seconds, the shape `inserted_at` uses.
 * @param {object} rawMessage - one snapshot message.
 * @returns {number|undefined} epoch seconds, when the payload reported one.
 */
function stampSeconds(rawMessage) {
  const ext = rawMessage.ext !== null && typeof rawMessage.ext === 'object' ? rawMessage.ext : {}
  const candidates = [
    ext.create_time_ms,
    ext.msg_update_time_ms,
    rawMessage.create_time_ms,
    rawMessage.create_time,
    rawMessage.update_time,
  ]
  for (const candidate of candidates) {
    const value = Number(candidate)
    if (!Number.isFinite(value) || value <= 0 || Math.round(value) > Number.MAX_SAFE_INTEGER) continue
    /* Millisecond fields are huge; second fields (the JSON route reports
       `create_time` as seconds) are already the shape `inserted_at` wants. */
    return value < 1e12 ? Math.round(value) : Math.round(value) / 1000
  }
  return undefined
}

/**
 * Read the index a message reports, whichever spelling the payload uses.
 * @param {object} rawMessage - one snapshot message.
 * @returns {number|null} the index, or `null` when it reports none.
 */
function messageIndex(rawMessage) {
  for (const candidate of [rawMessage.index_in_conv, rawMessage.index]) {
    if (candidate === undefined || candidate === null || candidate === '') continue
    const value = Number(candidate)
    if (Number.isSafeInteger(value)) return value
  }
  return null
}

/**
 * Collect one message's content blocks.
 *
 * Server-rendered pages carry `content_block[]`, but the JSON snapshot route
 * puts the same blocks inside `content` (a JSON string holding an array). A
 * plain object with `text` is the other snapshot spelling.
 * @param {object} rawMessage - one snapshot message.
 * @returns {object[]} the blocks, empty when the message carries none.
 */
function messageBlocks(rawMessage) {
  if (Array.isArray(rawMessage.content_block) && rawMessage.content_block.length > 0) {
    return rawMessage.content_block
  }
  const content = rawMessage.content
  if (Array.isArray(content)) return content
  if (typeof content === 'string') {
    const parsed = parseEmbeddedJson(content)
    if (Array.isArray(parsed)) return parsed
    if (parsed !== undefined && parsed !== null && typeof parsed === 'object') return [asContentBlock(parsed)]
  }
  if (content !== null && typeof content === 'object') return [asContentBlock(content)]
  return []
}

/* The JSON share route sometimes stores a message's payload directly under
   `content` (`{text, search_references}`) instead of as a block list, so a
   value without its own `block_type` is a plain text payload, not a block. */
function asContentBlock(content) {
  return Number.isSafeInteger(Number(content.block_type))
    ? content
    : { block_type: TEXT_BLOCK_TYPE, content }
}

/**
 * The endpoint that serves one share's JSON snapshot, when the id has one.
 *
 * `x`-prefixed (mobile) shares are the lazy kind: their page loads messages
 * through this route. Other ids are served by the Alice share API. Collection
 * (`c`) and bookmark (`d`) shares answer different shapes and keep going through
 * the rendered page.
 * @param {string} shareId - the share token from the link.
 * @returns {{url: string, payload: object}|null} the request, or `null` when the
 *   id is not served by a JSON route this module knows.
 */
export function doubaoSnapshotRequest(shareId) {
  const id = typeof shareId === 'string' ? shareId : ''
  if (id.length === 0) return null
  if (id.startsWith('x')) {
    return {
      url: 'https://www.doubao.com/im/message/share/get',
      payload: {
        share_id: id,
        need_bot_info: true,
        need_lazy_load_big_message: true,
        need_lazy_load_thread_msg: true,
      },
    }
  }
  if (id.startsWith('c') || id.startsWith('d')) return null
  return { url: 'https://www.doubao.com/alice/message/share/get', payload: { share_id: id } }
}

/**
 * Whether a snapshot answer is the API's own error envelope.
 * @param {unknown} payload - the decoded answer.
 * @returns {boolean} true when the answer reports a failure code.
 */
function isApiFailure(payload) {
  return payload !== null && typeof payload === 'object' && payload.code !== undefined && Number(payload.code) !== 0
}

/**
 * Read one JSON snapshot answer into messages.
 * @param {unknown} payload - the decoded `/message/share/get` answer.
 * @returns {{shareId: string, title: string, author: string, messages: object[]}} the reading.
 * @throws {ShareError} `SHARE_NOT_FOUND` / `SHARE_MALFORMED`.
 */
export function readDoubaoSnapshot(payload) {
  if (payload === null || typeof payload !== 'object') {
    throw new ShareError('SHARE_MALFORMED', '分享接口没有返回可解析的内容')
  }
  if (isApiFailure(payload)) {
    throw new ShareError('SHARE_NOT_FOUND', '分享不存在或已失效（豆包接口：' + String(payload.msg || payload.message || payload.code) + '）')
  }
  const node = findShareNode(payload, 0)
  if (node === null) throw new ShareError('SHARE_NOT_FOUND', '分享接口里没有找到对话内容（链接可能已失效或不是公开分享）')

  const shareInfo = node.shareInfo
  const list = Array.isArray(node.snapshot.message_list) ? node.snapshot.message_list.slice() : []
  const indexed = list.every((item) => item !== null && typeof item === 'object' && messageIndex(item) !== null)
  if (indexed) list.sort((left, right) => messageIndex(left) - messageIndex(right))

  const messages = []
  for (const raw of list) {
    const message = toShareMessage(raw)
    if (message !== null) messages.push(message)
  }
  return {
    lazy: false,
    shareId: typeof shareInfo.share_id === 'string' ? shareInfo.share_id : String(shareInfo.share_id || ''),
    title: typeof shareInfo.share_name === 'string' ? shareInfo.share_name : '',
    author: shareInfo.user !== null && typeof shareInfo.user === 'object' && typeof shareInfo.user.nick_name === 'string'
      ? shareInfo.user.nick_name
      : '',
    messages,
  }
}

/**
 * Read one Doubao share page into messages, rejecting a lazy shell page.
 * @param {string} html - the server-rendered page.
 * @returns {{shareId: string, title: string, author: string, messages: object[]}} the reading.
 * @throws {ShareError} `SHARE_NOT_FOUND` / `SHARE_MALFORMED` / `SHARE_LAZY`.
 */
export function readDoubaoHtml(html) {
  const page = readDoubaoPage(html)
  if (page.lazy) throw new ShareError('SHARE_LAZY', '这个豆包分享需要登录才能加载完整内容，暂不支持导入')
  return page
}

/**
 * Map one snapshot message into the plugin's message model
 * (`{role, fragments:[{type, content}], inserted_at}`), the same model the
 * DeepSeek payload is read into.
 * @param {unknown} rawMessage - one snapshot message.
 * @returns {object|null} the mapped message, or `null` when it is not importable.
 */
function toShareMessage(rawMessage) {
  if (rawMessage === null || typeof rawMessage !== 'object') return null
  /* Tolerate a `{message: {...}}` wrapper; the samples carry the fields directly. */
  const body = rawMessage.message !== null && typeof rawMessage.message === 'object' ? rawMessage.message : rawMessage
  const userType = Number(body.user_type)
  if (userType !== 1 && userType !== 2) return null
  const role = userType === 1 ? 'user' : 'assistant'
  const { text, hadBlocks } = messageText(body)
  const content = text.length > 0 ? text : (hadBlocks ? DOUBAO_MEDIA_NOTE : '')
  if (content.length === 0) return null
  const message = {
    role,
    fragments: [{ type: role === 'user' ? 'REQUEST' : 'RESPONSE', content }],
  }
  const insertedAt = stampSeconds(body)
  if (insertedAt !== undefined) message.inserted_at = insertedAt
  return message
}

/**
 * Read one Doubao share page into messages, keeping the lazy-load signal.
 * @param {string} html - the server-rendered page.
 * @returns {{lazy: boolean, shareId: string, title: string, author: string, messages: object[]}} the reading.
 * @throws {ShareError} `SHARE_NOT_FOUND` / `SHARE_MALFORMED`.
 */
export function readDoubaoPage(html) {
  const text = typeof html === 'string' ? html : String(html === undefined || html === null ? '' : html)
  if (text.length === 0) throw new ShareError('SHARE_MALFORMED', '分享页是空的')

  const attribute = /data-fn-args=(?:"([^"]*)"|'([^']*)')/gu
  let found = null
  let match
  while ((match = attribute.exec(text)) !== null) {
    const raw = match[1] !== undefined ? match[1] : match[2]
    const args = parseEmbeddedJson(decodeHtmlEntities(raw))
    if (args === undefined) continue
    found = findShareNode(args, 0)
    if (found !== null) break
  }

  if (found === null) {
    /* No share document at all. An x-prefixed share renders a shell page that
       lazy-loads its messages, so a payload-free page is that case, not a
       deleted share — report it as lazy so the caller can use the JSON route. */
    const lazyPage = /needLazyLoadThreadMsg"?\s*:\s*(?:!0|true)/u.test(text) || /need_lazy_load_thread_msg/u.test(text)
    if (lazyPage) return { lazy: true, shareId: '', title: '', author: '', messages: [] }
    throw new ShareError('SHARE_NOT_FOUND', '分享页里没有找到对话内容（链接可能已失效或不是公开分享）')
  }
  if (found.lazy) return { lazy: true, shareId: '', title: '', author: '', messages: [] }

  const shareInfo = found.shareInfo
  const list = Array.isArray(found.snapshot.message_list) ? found.snapshot.message_list.slice() : []
  const indexed = list.every((item) => item !== null && typeof item === 'object' && Number.isSafeInteger(Number(item.index)))
  if (indexed) list.sort((left, right) => Number(left.index) - Number(right.index))

  const messages = []
  for (const raw of list) {
    const message = toShareMessage(raw)
    if (message !== null) messages.push(message)
  }
  return {
    lazy: false,
    shareId: typeof shareInfo.share_id === 'string' ? shareInfo.share_id : String(shareInfo.share_id || ''),
    title: typeof shareInfo.share_name === 'string' ? shareInfo.share_name : '',
    author: shareInfo.user !== null && typeof shareInfo.user === 'object' && typeof shareInfo.user.nick_name === 'string'
      ? shareInfo.user.nick_name
      : '',
    messages,
  }
}
