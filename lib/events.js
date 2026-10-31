/**
 * DeepSeek share content → DSH session events (static import).
 *
 * Based on `deepseek-web-import` v0.2.1 (MIT, Copyright (c) 2026 wpc0323,
 * see LICENSE), adapted for public share links and for a *static* import:
 *
 * - Only conversational turns are imported (`REQUEST` → user text, `RESPONSE` →
 *   assistant text, `THINK` → reasoning block). Search steps, opened pages and
 *   their `[reference:N]` markers are dropped.
 * - The log ends at the last answer: a trailing question with no answer is not
 *   imported, so the restored session has no open turn and no step waiting for
 *   a model reply. Opening it is inert; the next real prompt continues from the
 *   imported history.
 * - Nothing is appended after `session/end-seed`, and no `session.prompt` is
 *   sent: the import produces history, not a generation.
 *
 * @module dsh-share-import/events
 */
import { assistantMessageData, SURFACE_APPEND } from './formats.js'

/** Fragment types carrying text, grouped by the role that owns them. */
const USER_TEXT_FRAGMENTS = new Set(['REQUEST'])
const ASSISTANT_ANSWER_FRAGMENTS = new Set(['RESPONSE'])
const ASSISTANT_THINKING_FRAGMENTS = new Set(['THINK'])

/** Appended when a generation produced no text at all, so no turn looks empty. */
export const EMPTY_ANSWER_NOTE = '（这条回复在 DeepSeek 网页端没有正文）'

/** Appended when a human turn carried no text (e.g. an attachment-only message). */
export const EMPTY_PROMPT_NOTE = '（这条消息在 DeepSeek 网页端只有附件，没有文字）'

/** Names used for an imported conversation that carries no usable question. */
export const FALLBACK_TITLE = 'DeepSeek 分享导入'

/** The two roles a DeepSeek conversation carries and DSH can represent. */
export const IMPORTABLE_ROLES = Object.freeze(['user', 'assistant'])

/**
 * UTF-8 byte budget for the stored title, matching the session-title service's
 * default and this deployment's configured `maxTitleBytes`.
 */
export const MAX_TITLE_BYTES = 80

/* Title cleaning parity with `dsh-session-title`'s `normalizeSessionTitle`:
   terminal escapes, invisible controls and line breaks must not survive into a
   one-line title, and the result must fit a byte budget. */
const OSC_SEQUENCE = /\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)?/gu
const CSI_SEQUENCE = /(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/gu
const ESC_SEQUENCE = /\u001B[@-_]/gu
const CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu
const DIRECTIONAL_CONTROL = /[\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/gu

/**
 * Normalize one untrusted conversation title into a terminal-safe one-liner.
 * @param {unknown} input - the text that should become the title.
 * @param {number} [maxBytes] - UTF-8 byte budget.
 * @returns {string} the normalized title, possibly empty.
 */
export function normalizeTitle(input, maxBytes = MAX_TITLE_BYTES) {
  const text = String(input === undefined || input === null ? '' : input)
    .replace(OSC_SEQUENCE, '')
    .replace(CSI_SEQUENCE, '')
    .replace(ESC_SEQUENCE, '')
    .replace(CONTROL_CHARACTER, '')
    .replace(DIRECTIONAL_CONTROL, '')
    .replace(/\s+/gu, ' ')
    .trim()
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  let used = 0
  let output = ''
  for (const character of text) {
    const bytes = Buffer.byteLength(character, 'utf8')
    if (used + bytes > maxBytes) break
    output += character
    used += bytes
  }
  return output.trimEnd()
}

/**
 * Remove the `[reference:N]` markers a share answer carries: they point at the
 * search results this import deliberately drops, so they would dangle.
 * @param {string} text - one response fragment's text.
 * @returns {string} the text without reference markers.
 */
export function stripReferenceMarkers(text) {
  return text.replace(/\[reference:\s*\d+\]/gu, '').replace(/[ \t]+(\n)/gu, '$1').trim()
}

/**
 * Concatenate the `content` of one message's fragments of the wanted types.
 * @param {object} message - one share message.
 * @param {Set<string>} wanted - fragment type names to keep, upper case.
 * @returns {string} the joined text, empty when nothing matches.
 */
export function fragmentText(message, wanted) {
  const fragments = message && Array.isArray(message.fragments) ? message.fragments : null
  if (fragments === null) return ''
  return fragments
    .filter((f) => f && f.content !== undefined && f.content !== null && wanted.has(String(f.type || '').toUpperCase()))
    .map((f) => (typeof f.content === 'string' ? f.content : legacyText(f.content)).trim())
    .filter((text) => text.length > 0)
    .join('\n\n')
}

/**
 * Flatten a legacy `content` field, accepted as a fallback for payloads that
 * carry text outside `fragments`.
 * @param {unknown} content - raw `content` value of one message.
 * @returns {string} the flattened text.
 */
export function legacyText(content) {
  if (content === null || content === undefined) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((block) => {
      if (typeof block === 'string') return block
      if (block && typeof block.text === 'string') return block.text
      if (block && typeof block.content === 'string') return block.content
      return ''
    }).join('\n')
  }
  if (typeof content === 'object') {
    if (typeof content.text === 'string') return content.text
    if (typeof content.content === 'string') return content.content
  }
  return String(content)
}

/** Earliest stamp accepted: 2001-09-09, well before any DeepSeek conversation. */
const MIN_STAMP_MS = 1000000000000

/** Latest stamp accepted: one day ahead, to tolerate clock skew. */
const MAX_STAMP_AHEAD_MS = 86400000

/**
 * One message's wall-clock time in epoch milliseconds, when the API reported a
 * usable one. `inserted_at` is seconds since the epoch.
 * @param {object} message - one share message.
 * @param {number|undefined} fallback - value to use when the stamp is unusable.
 * @returns {number|undefined} epoch milliseconds.
 */
export function messageTime(message, fallback) {
  const seconds = message ? Number(message.inserted_at) : NaN
  if (!Number.isFinite(seconds) || seconds <= 0) return fallback
  const millis = Math.round(seconds * 1000)
  if (!Number.isSafeInteger(millis)) return fallback
  if (millis < MIN_STAMP_MS || millis > Date.now() + MAX_STAMP_AHEAD_MS) return fallback
  return millis
}

/**
 * Read one share message into DSH content blocks.
 * @param {object} message - one share message.
 * @param {string} role - lower-cased role.
 * @returns {object[]} DSH content blocks (`text`, and `reasoning` for answers).
 */
export function messageBlocks(message, role) {
  if (role === 'user') {
    const text = fragmentText(message, USER_TEXT_FRAGMENTS) || legacyText(message.content)
    /* An attachment-only prompt has no text; an empty user turn would reach the
       model as an empty message, so it keeps an explicit note instead. */
    return [{ type: 'text', text: text.trim().length > 0 ? text : EMPTY_PROMPT_NOTE }]
  }
  const reasoning = fragmentText(message, ASSISTANT_THINKING_FRAGMENTS)
  const answer = stripReferenceMarkers(fragmentText(message, ASSISTANT_ANSWER_FRAGMENTS) || legacyText(message.content))
  const blocks = []
  if (reasoning.length > 0) blocks.push({ type: 'reasoning', text: reasoning })
  if (answer.length > 0) blocks.push({ type: 'text', text: answer })
  /* A block count of zero is not the only empty case: an answer cut off while
     still thinking carries reasoning and no text, and a message with no text
     block renders as an empty turn. */
  if (!blocks.some((block) => block.type === 'text')) blocks.push({ type: 'text', text: EMPTY_ANSWER_NOTE })
  return blocks
}

/**
 * Whether one share message is a turn DSH can represent.
 * @param {object} message - one share message.
 * @returns {boolean} true for the two conversation roles.
 */
export function isImportableMessage(message) {
  const role = String((message && message.role) || '').toLowerCase()
  return IMPORTABLE_ROLES.includes(role)
}

/**
 * Keep only the messages the import can represent. Anything else (a system
 * note, a tool row, a malformed entry) is dropped rather than fabricated into
 * an assistant turn.
 * @param {unknown} messages - raw share messages.
 * @returns {object[]} the importable messages, order preserved.
 */
export function importableMessages(messages) {
  return (Array.isArray(messages) ? messages : []).filter(isImportableMessage)
}

/**
 * Cut a conversation at its last answer, dropping a trailing question the
 * remote side never answered. A static import must not leave an open turn:
 * an open turn is what the UI renders as "still generating".
 * @param {object[]} messages - importable messages, oldest first.
 * @returns {{messages: object[], droppedTail: number}} the round-aligned slice.
 */
export function completeConversation(messages) {
  const list = Array.isArray(messages) ? messages : []
  let lastAnswer = -1
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (String((list[index] && list[index].role) || '').toLowerCase() === 'assistant') {
      lastAnswer = index
      break
    }
  }
  if (lastAnswer < 0) return { messages: [], droppedTail: list.length }
  return { messages: list.slice(0, lastAnswer + 1), droppedTail: list.length - lastAnswer - 1 }
}

/**
 * Derive a title from the conversation itself: the remote title is always the
 * generic "Shared Conversation", so the first question is the useful label.
 * @param {object[]} messages - importable messages, oldest first.
 * @returns {string} a normalized, non-empty title.
 */
export function conversationTitle(messages) {
  for (const message of Array.isArray(messages) ? messages : []) {
    if (String((message && message.role) || '').toLowerCase() !== 'user') continue
    const text = normalizeTitle(fragmentText(message, USER_TEXT_FRAGMENTS) || legacyText(message.content))
    if (text.length > 0) return text
  }
  return FALLBACK_TITLE
}

/**
 * Count the rounds (answer-carrying turns) a message list would import.
 * @param {object[]} messages - importable messages, oldest first.
 * @returns {number} the number of assistant messages.
 */
export function countRounds(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => String((message && message.role) || '').toLowerCase() === 'assistant').length
}

/**
 * Translate one conversation into a legal, closed DSH session log:
 * `session/title` → `turn/start → step/start → user/message → step/start →
 * assistant/message → step/end → turn/end` per round → `session/end-seed`.
 *
 * Surface events carry `surfaceOp: "append"`. Every step opens before the
 * surface event it carries: a v3+ build refuses a v0/v2 log whose first surface
 * event precedes its first `step/start`.
 *
 * @param {object[]} messages - round-aligned messages, oldest first.
 * @param {string} title - the conversation title.
 * @param {import('./formats.js').FormatProfile} profile - format being written.
 * @returns {object[]} contiguous events from seq 0.
 */
export function buildStaticSessionEvents(messages, title, profile) {
  const events = []
  const list = Array.isArray(messages) ? messages : []
  let seq = 0
  let turn = 0
  let openStep = false
  /**
   * Emitted times follow the conversation's own `inserted_at` values and stay
   * non-decreasing. `lastTime` starts at 0, never at "now": an imported
   * conversation is normally *older* than the import, and seeding the cursor
   * with the import moment would clamp its whole timeline to it.
   */
  const stamps = list
    .map((message) => messageTime(message, undefined))
    .filter((time) => Number.isSafeInteger(time) && time >= 0)
  const base = stamps.length > 0 ? stamps.reduce((earliest, time) => (time < earliest ? time : earliest)) : Date.now()
  let lastTime = 0
  const push = (type, data, surfaceOp, time) => {
    const wanted = Number.isSafeInteger(time) && time >= 0 ? time : (lastTime || base)
    const at = Math.max(wanted, lastTime)
    lastTime = at
    const event = { type, seq, time: at, data }
    if (surfaceOp !== undefined) event.surfaceOp = surfaceOp
    events.push(event)
    seq += 1
  }
  const cleanTitle = normalizeTitle(title)
  push('session/title', {
    title: cleanTitle.length > 0 ? cleanTitle : FALLBACK_TITLE,
    messageSeqs: [],
    source: { kind: 'user' },
  }, undefined, messageTime(list[0], undefined))
  list.forEach((source) => {
    const message = source && typeof source === 'object' ? source : {}
    const role = String(message.role || '').toLowerCase()
    if (!IMPORTABLE_ROLES.includes(role)) return
    const blocks = messageBlocks(message, role)
    const time = messageTime(message, undefined)
    if (role === 'user') {
      if (openStep) {
        push('step/end', { turn, step: 1 }, undefined, time)
        push('turn/end', { turn, reason: { kind: 'completed' } }, undefined, time)
        openStep = false
      }
      turn += 1
      push('turn/start', { turn }, undefined, time)
      push('step/start', { turn, step: 1 }, undefined, time)
      push('user/message', {
        id: 'msg-' + turn + '-u',
        role: 'user',
        content: blocks,
        source: { kind: 'user' },
      }, SURFACE_APPEND, time)
      openStep = true
    } else {
      if (!openStep) {
        turn += 1
        push('turn/start', { turn }, undefined, time)
        push('step/start', { turn, step: 1 }, undefined, time)
        openStep = true
      }
      push('assistant/message', assistantMessageData(profile, {
        turn,
        step: 1,
        message: {
          id: 'msg-' + turn + '-a',
          role: 'assistant',
          content: blocks,
          source: { kind: 'model', provider: 'deepseek', model: String((message && message.model) || '') || 'deepseek-chat' },
        },
      }), SURFACE_APPEND, time)
      push('step/end', { turn, step: 1 }, undefined, time)
      push('turn/end', { turn, reason: { kind: 'completed' } }, undefined, time)
      openStep = false
    }
  })
  push('session/end-seed', {})
  return events
}
