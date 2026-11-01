/**
 * Smoke test for the pure parts of dsh-share-import: link parsing, payload
 * reading (both sources), conversation slicing and event building. No DSH
 * instance needed and, unless a link is supplied, no network either.
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
import {
  DOUBAO_FALLBACK_TITLE,
  DOUBAO_MEDIA_NOTE,
  doubaoSnapshotRequest,
  readDoubaoHtml,
  readDoubaoPage,
  readDoubaoSnapshot,
} from '../lib/doubao.js'
import { formatProfile } from '../lib/formats.js'
import {
  ShareError,
  parseShareLink,
  previewSummary,
  readShareDocument,
} from '../lib/share.js'

/* The live-fetch part needs a real share link: pass it as argv[2] or set
   DSH_SHARE_LINK. It may be a DeepSeek or a Doubao link. Nothing in this file
   should pin someone's private share. */
const LINK = String(process.argv[2] || process.env.DSH_SHARE_LINK || '').trim()
const SAMPLE_ID = 'abc123def456'

let failures = 0
function check(name, condition, detail) {
  if (condition) {
    console.log('  ok   ' + name)
  } else {
    failures += 1
    console.log('  FAIL ' + name + (detail === undefined ? '' : ' — ' + detail))
  }
}

/**
 * Encode one JSON value the way Doubao writes a `data-fn-args` attribute:
 * `&` first, then the quote/angle characters, so nothing is double-decoded.
 * @param {unknown} value - JSON-serializable value.
 * @returns {string} the attribute body.
 */
function encodeFnArgs(value) {
  return JSON.stringify(value)
    .replace(/&/gu, '&amp;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#x27;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
}

/** One synthetic share document, as Doubao's `message_snapshot` carries it. */
function sampleShare() {
  return {
    share_info: {
      share_id: '11112222333344445555',
      share_name: '合成标题：测试分享',
      user: { nick_name: '合成作者' },
      bot: { name: '豆包' },
      message_index_end: 0,
    },
    message_snapshot: {
      message_list: [
        {
          index: 0,
          user_type: 1,
          ext: { create_time_ms: 1750000000000 },
          content_block: [
            { block_id: 'b1', block_type: 10000, content: JSON.stringify({ text: '第一个问题' }) },
          ],
        },
        {
          index: 1,
          user_type: 2,
          ext: { msg_update_time_ms: 1750000005000 },
          content_block: [
            {
              block_id: 'b2',
              block_type: 10000,
              content: JSON.stringify({ content_v2: { text_block: { text: '第一段回答' } } }),
            },
            { block_id: 'b3', block_type: 2074, content: '{"creations":[]}' },
          ],
        },
        {
          index: 2,
          user_type: 1,
          content_block: [
            { block_id: 'b4', block_type: 10000, content: JSON.stringify({ text: '第二个问题' }) },
          ],
        },
        {
          index: 3,
          user_type: 2,
          content_block: [
            { block_id: 'b5', block_type: 2074, content: '{"creations":[]}' },
          ],
        },
      ],
    },
  }
}

console.log('# parseShareLink')
const deepseekVariants = [
  ['https://chat.deepseek.com/share/' + SAMPLE_ID, SAMPLE_ID],
  ['https://chat.deepseek.com/share/' + SAMPLE_ID + '?from=timeline', SAMPLE_ID],
  ['https://chat.deepseek.com/share/' + SAMPLE_ID + '/', SAMPLE_ID],
  ['https://chat.deepseek.com/api/v0/share/content?share_id=' + SAMPLE_ID, SAMPLE_ID],
  ['  ' + SAMPLE_ID + '  ', SAMPLE_ID],
]
for (const [input, expected] of deepseekVariants) {
  let actual = null
  try { actual = parseShareLink(input) } catch { actual = null }
  check(input, actual !== null && actual.source === 'deepseek' && actual.id === expected, JSON.stringify(actual))
}

const DOUBAO_ID = 'q1w2e3r4t5y6'
const doubaoVariants = [
  ['https://www.doubao.com/thread/' + DOUBAO_ID, DOUBAO_ID],
  ['https://doubao.com/thread/' + DOUBAO_ID + '/', DOUBAO_ID],
  ['  https://www.doubao.com/thread/' + DOUBAO_ID + '  ', DOUBAO_ID],
]
for (const [input, expected] of doubaoVariants) {
  let actual = null
  try { actual = parseShareLink(input) } catch { actual = null }
  check(input, actual !== null && actual.source === 'doubao' && actual.id === expected, JSON.stringify(actual))
}

for (const bad of [
  '',
  'not a url',
  'https://example.com/share/abcdef123',
  'http://chat.deepseek.com/share/abcdef123',
  'https://chat.deepseek.com/api/v0/chat',
  'https://www.doubao.com/share/abcdef123',
  'https://www.doubao.com/thread/abc',
  'http://www.doubao.com/thread/abcdef123',
  'https://www.doubao.com/thread/abcdef123/extra',
]) {
  let code = null
  try { parseShareLink(bad) } catch (error) { code = error instanceof ShareError ? error.code : 'other' }
  check('rejects ' + JSON.stringify(bad), code === 'SHARE_LINK_INVALID', String(code))
}

console.log('\n# readDoubaoHtml — mergeLoaderData shape')
const payload = sampleShare()
const shapeOne = '<html><head><script data-fn-args="' + encodeFnArgs([
  'thread_(token)/page',
  [{ key: 'shareInfo', routerDataFnName: 'p', routerDataFnArgs: [JSON.stringify(payload)] }],
]) + '"></script></head><body></body></html>'
{
  const reading = readDoubaoHtml(shapeOne)
  check('title', reading.title === '合成标题：测试分享', JSON.stringify(reading.title))
  check('author', reading.author === '合成作者', JSON.stringify(reading.author))
  check('remote share id', reading.shareId === '11112222333344445555', reading.shareId)
  check('four messages', reading.messages.length === 4, 'count=' + reading.messages.length)
  check('roles user/assistant/user/assistant',
    reading.messages.map((message) => message.role).join(',') === 'user,assistant,user,assistant',
    reading.messages.map((message) => message.role).join(','))
  check('REQUEST fragment', reading.messages[0].fragments[0].type === 'REQUEST')
  check('RESPONSE fragment', reading.messages[1].fragments[0].type === 'RESPONSE')
  check('plain text block', reading.messages[0].fragments[0].content === '第一个问题')
  check('content_v2 text block', reading.messages[1].fragments[0].content === '第一段回答',
    JSON.stringify(reading.messages[1].fragments[0].content))
  check('inserted_at is seconds', reading.messages[0].inserted_at === 1750000000, String(reading.messages[0].inserted_at))
  check('msg_update_time_ms fallback', reading.messages[1].inserted_at === 1750000005,
    String(reading.messages[1].inserted_at))
  check('media-only message keeps a note', reading.messages[3].fragments[0].content === DOUBAO_MEDIA_NOTE,
    JSON.stringify(reading.messages[3].fragments[0].content))

  const complete = completeConversation(importableMessages(reading.messages))
  check('conversation completes at the last answer', complete.messages.length === 4 && complete.droppedTail === 0)
  check('two rounds', countRounds(complete.messages) === 2, String(countRounds(complete.messages)))
  check('fallback title only when nothing is usable',
    conversationTitle([], DOUBAO_FALLBACK_TITLE) === DOUBAO_FALLBACK_TITLE)
}

console.log('\n# readDoubaoHtml — wrapped `r` shape, shuffled order')
{
  const shuffled = sampleShare()
  shuffled.message_snapshot.message_list = shuffled.message_snapshot.message_list.slice().reverse()
  const shapeTwo = "<html><body><script data-fn-args='" + encodeFnArgs([
    'thread_(token)/page',
    'shareInfo',
    { isMobileShareId: true, isWebCollectionShareId: false, needLazyLoadThreadMsg: false, data: shuffled },
  ]) + "'></script></body></html>"
  const reading = readDoubaoHtml(shapeTwo)
  check('messages sorted by index', reading.messages[0].fragments[0].content === '第一个问题',
    JSON.stringify(reading.messages[0].fragments[0].content))
  check('wrapper payload read', reading.messages.length === 4, 'count=' + reading.messages.length)
  check('wrapper title', reading.title === '合成标题：测试分享', JSON.stringify(reading.title))
}

console.log('\n# readDoubaoHtml — failures')
{
  const lazy = '<html><body><script data-fn-args="' + encodeFnArgs([
    'thread_(token)/page',
    'shareInfo',
    { needLazyLoadThreadMsg: true, data: { share_info: {}, message_snapshot: { message_list: [] } } },
  ]) + '"></script></body></html>'
  let code = null
  try { readDoubaoHtml(lazy) } catch (error) { code = error instanceof ShareError ? error.code : 'other' }
  check('lazy flag reports SHARE_LAZY', code === 'SHARE_LAZY', String(code))

  const lazyShell = '<html><body><script>window.__X={needLazyLoadThreadMsg:!0}</script></body></html>'
  code = null
  try { readDoubaoHtml(lazyShell) } catch (error) { code = error instanceof ShareError ? error.code : 'other' }
  check('payload-free lazy shell reports SHARE_LAZY', code === 'SHARE_LAZY', String(code))

  code = null
  try { readDoubaoHtml('<html><body>nothing here</body></html>') } catch (error) {
    code = error instanceof ShareError ? error.code : 'other'
  }
  check('page without payload reports SHARE_NOT_FOUND', code === 'SHARE_NOT_FOUND', String(code))

  code = null
  try { readDoubaoHtml('') } catch (error) { code = error instanceof ShareError ? error.code : 'other' }
  check('empty page reports SHARE_MALFORMED', code === 'SHARE_MALFORMED', String(code))
}

console.log('\n# doubaoSnapshotRequest — share id routing')
{
  const mobile = doubaoSnapshotRequest('xabcdef123456')
  check('x id uses the im message route', mobile !== null && /\/im\/message\/share\/get$/u.test(mobile.url),
    mobile && mobile.url)
  check('x id asks for lazy big messages', mobile.payload.need_lazy_load_big_message === true,
    JSON.stringify(mobile.payload))
  check('x id payload carries the share id', mobile.payload.share_id === 'xabcdef123456',
    String(mobile.payload.share_id))

  const plain = doubaoSnapshotRequest('a1b2c3d4e5f6')
  check('plain id uses the alice message route', plain !== null && /\/alice\/message\/share\/get$/u.test(plain.url),
    plain && plain.url)
  check('plain id payload is the bare share id',
    JSON.stringify(plain.payload) === '{"share_id":"a1b2c3d4e5f6"}', JSON.stringify(plain.payload))
  check('collection id has no snapshot route', doubaoSnapshotRequest('c1a2b3d4e5') === null)
  check('desktop id has no snapshot route', doubaoSnapshotRequest('d1a2b3d4e5') === null)
  check('empty id has no snapshot route', doubaoSnapshotRequest('') === null)
}

console.log('\n# readDoubaoSnapshot — JSON share route (x-prefixed shares)')
{
  const snapshot = {
    code: 0,
    data: {
      share_info: { share_id: 'xabcdef123456', share_name: '快照标题：脚本日志', user: { nick_name: '快照作者' } },
      message_snapshot: {
        message_list: [
          {
            index_in_conv: '4',
            user_type: 2,
            content: { text: '对象形态的回答' },
            create_time: '1793350490',
          },
          {
            index_in_conv: '3',
            user_type: 2,
            content_block: null,
            content: JSON.stringify([{ block_id: 'b3', block_type: 10000, content: JSON.stringify({ text: '第三个回答' }) }]),
            create_time: '1793350480',
          },
          {
            index_in_conv: '1',
            user_type: 1,
            content_block: [{ block_id: 'b1', block_type: 10000, content: JSON.stringify({ text: '第一个问题' }) }],
            create_time: '1793350460',
          },
          {
            index_in_conv: '2',
            user_type: 2,
            content_block: [{ block_id: 'b2', block_type: 2074, content: '{}' }],
            create_time: '1793350470',
          },
        ],
      },
    },
  }
  const reading = readDoubaoSnapshot(snapshot)
  check('snapshot title', reading.title === '快照标题：脚本日志', JSON.stringify(reading.title))
  check('snapshot author', reading.author === '快照作者', JSON.stringify(reading.author))
  check('snapshot messages sorted by index_in_conv',
    reading.messages.length === 4 && reading.messages[0].fragments[0].content === '第一个问题',
    'count=' + reading.messages.length)
  check('snapshot roles',
    reading.messages.map((message) => message.role).join(',') === 'user,assistant,assistant,assistant',
    reading.messages.map((message) => message.role).join(','))
  check('snapshot media-only message gets a placeholder',
    reading.messages[1].fragments[0].content === DOUBAO_MEDIA_NOTE,
    JSON.stringify(reading.messages[1].fragments[0].content))
  check('snapshot text read from a content block', reading.messages[2].fragments[0].content === '第三个回答',
    JSON.stringify(reading.messages[2].fragments[0].content))
  check('snapshot text read from an object-shaped content', reading.messages[3].fragments[0].content === '对象形态的回答',
    JSON.stringify(reading.messages[3].fragments[0].content))
  check('snapshot fragment types',
    reading.messages[0].fragments[0].type === 'REQUEST' && reading.messages[2].fragments[0].type === 'RESPONSE',
    reading.messages.map((message) => message.fragments[0].type).join(','))
  check('second-granularity create_time stays in seconds',
    reading.messages[0].inserted_at === 1793350460, String(reading.messages[0].inserted_at))
}

console.log('\n# readDoubaoSnapshot — failures')
{
  let code = null
  try { readDoubaoSnapshot({ code: 621000004, msg: '分享不存在' }) } catch (error) {
    code = error instanceof ShareError ? error.code : 'other'
  }
  check('API failure reports SHARE_NOT_FOUND', code === 'SHARE_NOT_FOUND', String(code))

  code = null
  try { readDoubaoSnapshot({ code: 0, data: {} }) } catch (error) {
    code = error instanceof ShareError ? error.code : 'other'
  }
  check('snapshot without a share node reports SHARE_NOT_FOUND', code === 'SHARE_NOT_FOUND', String(code))

  code = null
  try { readDoubaoSnapshot(null) } catch (error) { code = error instanceof ShareError ? error.code : 'other' }
  check('missing snapshot reports SHARE_MALFORMED', code === 'SHARE_MALFORMED', String(code))
}

console.log('\n# readDoubaoPage — lazy shell is data, not an error')
{
  const lazyShell = '<html><body><script>window.__X={needLazyLoadThreadMsg:!0}</script></body></html>'
  const page = readDoubaoPage(lazyShell)
  check('lazy page reports the lazy flag', page.lazy === true, JSON.stringify(page.lazy))
  check('lazy page carries no messages', Array.isArray(page.messages) && page.messages.length === 0,
    'count=' + (page.messages && page.messages.length))

  const full = readDoubaoPage(shapeOne)
  check('rendered page is not lazy', full.lazy === false, JSON.stringify(full.lazy))
  check('rendered page keeps its messages', full.messages.length === 4, 'count=' + full.messages.length)
  check('rendered page keeps its title', full.title === '合成标题：测试分享', JSON.stringify(full.title))
}

if (LINK === '') {
  console.log('\n# live fetch skipped: pass a share URL or set DSH_SHARE_LINK')
} else {
  console.log('# fetch + read ' + LINK)
  const target = parseShareLink(LINK)
  check('link parsed to a known source', target.source === 'deepseek' || target.source === 'doubao', target.source)
  const reading = await readShareDocument({}, target)
  const messages = reading.messages
  check('raw messages present', Array.isArray(messages) && messages.length > 0, 'count=' + (messages && messages.length))
  console.log('  source=' + reading.source + ' remote title=' + JSON.stringify(reading.title)
    + ' author=' + JSON.stringify(reading.author))

  const importable = importableMessages(messages)
  const complete = completeConversation(importable)
  const named = reading.source === 'doubao' ? reading.title.trim() : ''
  const title = named.length > 0
    ? named
    : conversationTitle(complete.messages, reading.source === 'doubao' ? DOUBAO_FALLBACK_TITLE : undefined)
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
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + failures + ' CHECK(S) FAILED')
process.exit(failures === 0 ? 0 : 1)
