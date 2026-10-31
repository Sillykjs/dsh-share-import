/**
 * Smoke test for the pure parts of dsh-share-import: link parsing, payload
 * reading, conversation slicing and event building. No DSH instance needed.
 *
 * Usage: node test/smoke.mjs [share-url]
 */
import {
  buildStaticSessionEvents,
  completeConversation,
  conversationTitle,
  countRounds,
  importableMessages,
} from '../lib/events.js'
import { formatProfile } from '../lib/formats.js'
import {
  fetchShareContent,
  parseShareLink,
  previewSummary,
  readSharePayload,
  ShareError,
} from '../lib/share.js'

const DEFAULT_LINK = 'https://chat.deepseek.com/share/abc123def456'

let failures = 0
function check(name, condition, detail) {
  if (condition) {
    console.log('  ok   ' + name)
  } else {
    failures += 1
    console.log('  FAIL ' + name + (detail === undefined ? '' : ' — ' + detail))
  }
}

console.log('# parseShareLink')
const variants = [
  ['https://chat.deepseek.com/share/abc123def456', 'abc123def456'],
  ['https://chat.deepseek.com/share/abc123def456?from=timeline', 'abc123def456'],
  ['https://chat.deepseek.com/share/abc123def456/', 'abc123def456'],
  ['https://chat.deepseek.com/api/v0/share/content?share_id=abc123def456', 'abc123def456'],
  ['  abc123def456  ', 'abc123def456'],
]
for (const [input, expected] of variants) {
  check(input, parseShareLink(input) === expected)
}
for (const bad of ['', 'not a url', 'https://example.com/share/abcdef123', 'http://chat.deepseek.com/share/abcdef123', 'https://chat.deepseek.com/api/v0/chat']) {
  let code = null
  try { parseShareLink(bad) } catch (error) { code = error instanceof ShareError ? error.code : 'other' }
  check('rejects ' + JSON.stringify(bad), code === 'SHARE_LINK_INVALID', String(code))
}

const link = process.argv[2] || DEFAULT_LINK
console.log('# fetch + read ' + link)
const shareId = parseShareLink(link)
const payload = await fetchShareContent({}, shareId)
const { messages, rawTitle } = readSharePayload(payload)
check('raw messages present', Array.isArray(messages) && messages.length > 0, 'count=' + (messages && messages.length))
console.log('  remote title: ' + JSON.stringify(rawTitle))

const importable = importableMessages(messages)
const complete = completeConversation(importable)
const title = conversationTitle(complete.messages)
const summary = previewSummary(complete.messages)
console.log('  importable=' + importable.length + ' complete=' + complete.messages.length
  + ' droppedTail=' + complete.droppedTail + ' rounds=' + countRounds(complete.messages))
console.log('  title=' + JSON.stringify(title))
console.log('  summary=' + JSON.stringify(summary))

console.log('# buildStaticSessionEvents (v4)')
const profile = formatProfile(4)
const events = buildStaticSessionEvents(complete.messages, title, profile)
check('ends with session/end-seed', events[events.length - 1].type === 'session/end-seed')
check('starts with session/title', events[0].type === 'session/title')
check('seq contiguous from 0', events.every((event, index) => event.seq === index))
check('time non-decreasing', events.every((event, index) => index === 0 || event.time >= events[index - 1].time))
/* `user/message` carries no turn/step: the step is whatever opened last, so the
   invariant is checked against the most recent `step/start`. */
let currentStep = null
let surfaceBeforeStep = 0
for (const event of events) {
  if (event.type === 'step/start') currentStep = event.data.turn + ':' + event.data.step
  if (event.surfaceOp !== undefined && currentStep === null) surfaceBeforeStep += 1
}
check('every surface event follows its step/start', surfaceBeforeStep === 0, 'violations=' + surfaceBeforeStep)
check('no open turn', (() => {
  const turns = new Set()
  for (const event of events) {
    if (event.type === 'turn/start') turns.add(event.data.turn)
    if (event.type === 'turn/end') turns.delete(event.data.turn)
  }
  return turns.size === 0
})())
check('assistant messages carry stream', events
  .filter((event) => event.type === 'assistant/message')
  .every((event) => Array.isArray(event.data.stream)))
check('no reference markers left', events
  .filter((event) => event.type === 'assistant/message')
  .every((event) => event.data.message.content.every((block) =>
    !/\[reference:\s*\d+\]/u.test(String(block.text || '')))))
check('non-empty log', events.length > 3, 'events=' + events.length)
console.log('  events=' + events.length)

console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + failures + ' CHECK(S) FAILED')
process.exit(failures === 0 ? 0 : 1)
