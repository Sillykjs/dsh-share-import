/**
 * dsh-share-import — host half.
 *
 * Turns one public DeepSeek share link into a durable DSH session inside a
 * workspace the user picks. The browser half (`./client.js`) posts to the
 * same-origin routes below; they never touch anything outside this machine's
 * own session store.
 *
 * The import is *static*: the log carries the conversation's finished turns and
 * a closing `session/end-seed`, and nothing else. No prompt is sent, no turn is
 * left open, so opening the imported session shows a finished conversation and
 * the next prompt the user sends continues from that history.
 *
 * Routes (all POST, JSON):
 *   /__dsh-share-import/workspaces  {}
 *   /__dsh-share-import/preview     { link }
 *   /__dsh-share-import/import      { link, workspaceId, force? }
 *
 * Failures answer `{ok:false, code, message}` with a stable `code`; the browser
 * half localizes it. `code` is `INTERNAL` only for an unexpected throw.
 *
 * @module dsh-share-import
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

import {
  buildStaticSessionEvents,
  completeConversation,
  conversationTitle,
  countRounds,
  importableMessages,
} from './events.js'
import { writeVerifiedSession } from './persistence.js'
import {
  fetchShareContent,
  parseShareLink,
  previewSummary,
  readSharePayload,
  ShareError,
} from './share.js'

/** Stable Cordis plugin name (must match the cordis.patch.yml `id`). */
export const name = 'dsh-share-import'

/** These routes need the HTTP carrier; every other service is read via ctx.get. */
export const inject = ['webServer']

/** Route prefix owned by this plugin. */
const ROUTE_PREFIX = '/__dsh-share-import/'

/** Marks routes this plugin registered, so only its own are ever reclaimed. */
const ROUTE_OWNER = 'dsh-share-import'

/** Request bodies larger than this are refused (sanity bound). */
const MAX_BODY_BYTES = 1024 * 1024

/**
 * Route generations, keyed by path: the last instance that claimed a path owns
 * it. A disposer compares this against its own generation instead of trusting
 * `webServer.exact` (an internal field), so a disposer can never delete a newer
 * instance's route.
 */
const routeGenerations = new Map()
let nextRouteGeneration = 0

/**
 * Journal of imported shares, so the same link is not silently duplicated.
 * Kept in `$DSH_HOME/share-import/index.json`; every failure to read or write it
 * is non-fatal (the file is a convenience, not a source of truth).
 * @param {object} ctx - the plugin context.
 * @returns {string} the index file path.
 */
function indexFile(ctx) {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim().length > 0
    ? process.env.DSH_HOME.trim()
    : path.join(homedir(), '.dsh')
  return path.join(home, 'share-import', 'index.json')
}

/**
 * Read the dedupe journal.
 * @param {object} ctx - the plugin context.
 * @returns {Promise<object>} `shareId → {sessionId, title, importedAt}`.
 */
async function readIndex(ctx) {
  try {
    const parsed = JSON.parse(await readFile(indexFile(ctx), 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Remember one successful import.
 * @param {object} ctx - the plugin context.
 * @param {string} shareId - the share id.
 * @param {{sessionId: string, title: string}} entry - what was written.
 * @returns {Promise<void>} resolves even when the journal cannot be written.
 */
async function recordImport(ctx, shareId, entry) {
  try {
    const file = indexFile(ctx)
    const index = await readIndex(ctx)
    index[shareId] = { ...entry, importedAt: Date.now() }
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify(index, null, 2), 'utf8')
  } catch (error) {
    log('share-import index not written: ' + String((error && error.message) || error))
  }
}

/**
 * Refresh the durable session-projection checkpoint for a session this plugin
 * wrote straight to persistence.
 *
 * A live session writes its own checkpoints; an imported one never had a live
 * session, so the cache holds no title row and the sidebar can only fall back to
 * a placeholder until the user opens the conversation once. `coldSnapshot` is
 * the fold face for exactly that case: a header identity plus the complete log
 * rebuilds the row. Failing here is harmless (the next open refolds), so the
 * whole step is fail-soft.
 * @param {object} ctx - the plugin context.
 * @param {{version: number, id: string, createdAt: number, cwd: string}} written - the stored identity.
 * @param {object[]} events - the complete log that was written.
 * @returns {boolean} whether the checkpoint was refreshed.
 */
function warmProjectionCache(ctx, written, events) {
  const cache = ctx.get('sessionProjectionCache')
  if (cache === undefined || cache === null || typeof cache.coldSnapshot !== 'function') return false
  const header = {
    type: 'session',
    version: written.version,
    id: written.id,
    createdAt: written.createdAt,
    cwd: written.cwd,
    isSeeded: false,
  }
  if (written.version >= 4) header.delegationDepth = 0
  try {
    cache.coldSnapshot(header, 0, events)
    return true
  } catch (error) {
    log('projection checkpoint not refreshed: ' + String((error && error.message) || error))
    return false
  }
}

/** Report plugin-level problems without disturbing the request. */
function log(message) {
  try {
    console.warn('[dsh-share-import] ' + message)
  } catch { /* logging must never fail a request */ }
}

/**
 * Generate one session id in the shape the session services expect.
 * @returns {string} a `session-…` id.
 */
function newSessionId() {
  return 'session-' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6)
}

/**
 * Mount the plugin.
 * @param {object} ctx - the plugin context.
 */
export function apply(ctx) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined || webServer === null) {
    log('webServer unavailable: routes are not mounted')
    return
  }

  // ---- domain actions ----

  /**
   * Read one share link into its importable message list.
   * @param {string} link - user input.
   * @returns {Promise<{shareId: string, title: string, messages: object[], droppedTail: number}>} the reading.
   */
  async function readShare(link) {
    const shareId = parseShareLink(link)
    const payload = await fetchShareContent(ctx, shareId)
    const { messages } = readSharePayload(payload)
    const importable = importableMessages(messages)
    const complete = completeConversation(importable)
    if (complete.messages.length === 0) {
      throw new ShareError('SHARE_EMPTY', '这个分享里没有可导入的问答内容')
    }
    return {
      shareId,
      title: conversationTitle(complete.messages),
      messages: complete.messages,
      droppedTail: complete.droppedTail,
    }
  }

  /**
   * List the workspaces a session can be created in.
   * @returns {{ok: true, workspaces: object[]} | {ok: false, code: string, message: string}} the listing.
   */
  function listWorkspaces() {
    const registry = ctx.get('workspaceRegistry')
    if (registry === undefined || registry === null || typeof registry.list !== 'function') {
      return { ok: false, code: 'WORKSPACES_UNAVAILABLE', message: '当前实例没有可用的工作区注册表' }
    }
    let workspaces
    try {
      workspaces = registry.list()
    } catch (error) {
      return { ok: false, code: 'WORKSPACES_UNAVAILABLE', message: String((error && error.message) || error) }
    }
    return {
      ok: true,
      workspaces: (Array.isArray(workspaces) ? workspaces : []).map((workspace) => ({
        id: String(workspace.id),
        title: String(workspace.title || workspace.path || workspace.id),
        path: String(workspace.path || ''),
      })),
    }
  }

  /**
   * Resolve the workspace a new session should belong to.
   * @param {string} workspaceId - id chosen in the browser half.
   * @returns {{ok: true, workspace: object} | {ok: false, code: string, message: string}} the resolution.
   */
  function findWorkspace(workspaceId) {
    const listed = listWorkspaces()
    if (!listed.ok) return listed
    if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
      return { ok: false, code: 'WORKSPACE_REQUIRED', message: '请选择要导入到哪个工作区' }
    }
    const registry = ctx.get('workspaceRegistry')
    const workspace = registry.list().find((candidate) => String(candidate.id) === workspaceId)
    if (workspace === undefined) {
      return { ok: false, code: 'WORKSPACE_UNKNOWN', message: '所选工作区不存在了，请刷新后重试' }
    }
    return { ok: true, workspace }
  }

  /**
   * Preview what one link would import, without writing anything.
   * @param {{link?: unknown}} body - request body.
   * @returns {Promise<object>} the preview result.
   */
  async function preview(body) {
    let reading
    try {
      reading = await readShare(body.link)
    } catch (error) {
      return failure(error)
    }
    const summary = previewSummary(reading.messages)
    const index = await readIndex(ctx)
    const previous = index[reading.shareId]
    return {
      ok: true,
      shareId: reading.shareId,
      title: reading.title,
      rounds: countRounds(reading.messages),
      questions: summary.questions,
      droppedTail: reading.droppedTail,
      firstQuestion: summary.firstQuestion,
      lastQuestion: summary.lastQuestion,
      alreadyImported: previous !== undefined,
      existingSessionId: previous && previous.sessionId ? String(previous.sessionId) : null,
    }
  }

  /**
   * Import one link into one workspace.
   * @param {{link?: unknown, workspaceId?: unknown, force?: unknown}} body - request body.
   * @returns {Promise<object>} the import result.
   */
  async function importShare(body) {
    let reading
    try {
      reading = await readShare(body.link)
    } catch (error) {
      return failure(error)
    }
    const resolved = findWorkspace(body.workspaceId)
    if (!resolved.ok) return resolved
    const workspace = resolved.workspace

    const index = await readIndex(ctx)
    const previous = index[reading.shareId]
    if (previous !== undefined && previous.sessionId !== undefined && body.force !== true) {
      return {
        ok: false,
        code: 'ALREADY_IMPORTED',
        message: '这个分享以前导入过；再次导入会新建一个会话',
        existingSessionId: String(previous.sessionId),
      }
    }

    const persistence = ctx.get('sessionPersistence')
    if (persistence === undefined || persistence === null || typeof persistence.create !== 'function') {
      return { ok: false, code: 'PERSISTENCE_UNAVAILABLE', message: '当前实例没有可用的会话持久化服务' }
    }

    const workspacePath = String(workspace.path || '')
    if (workspacePath.length === 0) {
      return { ok: false, code: 'WORKSPACE_INVALID', message: '所选工作区没有本地路径，无法写入会话' }
    }

    const sessionId = newSessionId()
    const createdAt = Date.now()
    let written
    let events = []
    try {
      written = await writeVerifiedSession(
        persistence,
        { id: sessionId, createdAt, cwd: workspacePath },
        (profile) => {
          events = buildStaticSessionEvents(reading.messages, reading.title, profile)
          return events
        },
      )
    } catch (error) {
      const code = error && error.code === 'verify' ? 'VERIFY_FAILED' : 'WRITE_FAILED'
      log('import failed: ' + String((error && error.message) || error))
      return { ok: false, code, message: '写入会话失败：' + String((error && error.message) || error) }
    }
    warmProjectionCache(ctx, { version: written.version, id: sessionId, createdAt, cwd: workspacePath }, events)

    let attached = false
    let attachError = null
    if (typeof workspace.attachSession === 'function') {
      for (let attempt = 0; attempt < 2 && !attached; attempt += 1) {
        try {
          await workspace.attachSession(sessionId)
          attached = true
        } catch (error) {
          attachError = String((error && error.message) || error)
        }
      }
    }
    if (!attached && attachError !== null) log('attach failed: ' + attachError)
    if (attached) await recordImport(ctx, reading.shareId, { sessionId, title: reading.title })

    return {
      ok: true,
      sessionId,
      title: reading.title,
      rounds: countRounds(reading.messages),
      eventCount: written.eventCount,
      version: written.version,
      attached,
      attachError,
    }
  }

  /**
   * Turn one thrown error into the route failure shape.
   * @param {unknown} error - what was thrown.
   * @returns {{ok: false, code: string, message: string}} the failure.
   */
  function failure(error) {
    if (error instanceof ShareError) return { ok: false, code: error.code, message: error.message }
    log('unexpected: ' + String((error && error.message) || error))
    return { ok: false, code: 'INTERNAL', message: '内部错误' }
  }

  const actions = {
    workspaces: async () => listWorkspaces(),
    preview,
    import: importShare,
  }

  // ---- HTTP plumbing ----

  /**
   * Read one JSON request body. An overflow resolves immediately and then drains
   * the rest: destroying the request would take the socket with it, so the 413
   * could never reach the caller.
   * @param {import('node:http').IncomingMessage} req - the request.
   * @returns {Promise<object>} the parsed body, or a marker object.
   */
  function readBody(req) {
    return new Promise((resolve) => {
      const chunks = []
      let total = 0
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        resolve(value)
      }
      req.on('data', (chunk) => {
        if (settled) return
        total += chunk.length
        if (total > MAX_BODY_BYTES) {
          finish({ __tooLarge: true })
          req.resume()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        if (settled) return
        const text = Buffer.concat(chunks).toString('utf8')
        if (text.trim() === '') return finish({})
        let body
        try {
          body = JSON.parse(text)
        } catch {
          return finish({ __malformed: true })
        }
        finish(body !== null && typeof body === 'object' && !Array.isArray(body) ? body : {})
      })
    })
  }

  /**
   * Write one JSON response with the headers this plugin always uses.
   * @param {import('node:http').ServerResponse} res - the response.
   * @param {object} data - JSON-serializable body.
   * @param {number} [status] - HTTP status.
   */
  function sendJson(res, data, status = 200) {
    const text = JSON.stringify(data)
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Content-Length', Buffer.byteLength(text))
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.end(text)
  }

  /**
   * Claim one exact route for this instance, evicting only a previous instance
   * of this plugin. Eviction is reversible so a mount that fails halfway cannot
   * leave a path served by nobody.
   * @param {object} route - the route to register.
   * @returns {{route: object, restore: () => void, dispose: () => void}} the claim.
   */
  function claimRoute(route) {
    const owned = { ...route, owner: ROUTE_OWNER }
    const register = () => webServer.register(owned)
    const generation = ++nextRouteGeneration
    let dispose
    let evicted = null
    try {
      dispose = register()
    } catch (error) {
      const table = webServer.exact
      const previous = table instanceof Map ? table.get(owned.path) : undefined
      if (previous === undefined || (previous.owner !== undefined && previous.owner !== ROUTE_OWNER)) throw error
      table.delete(owned.path)
      evicted = previous
      dispose = register()
    }
    routeGenerations.set(owned.path, generation)
    return {
      route: owned,
      restore: () => {
        const previous = evicted
        if (previous === null) return
        evicted = null
        try { webServer.register(previous) } catch { /* the path is taken again */ }
      },
      dispose: () => {
        if (routeGenerations.get(owned.path) !== generation) return
        routeGenerations.delete(owned.path)
        dispose()
      },
    }
  }

  /**
   * Build the handler for one action.
   * @param {string} action - action name.
   * @returns {Function} the request handler.
   */
  function handlerFor(action) {
    return (req, res) => {
      req.on('error', () => {})
      res.on('error', () => {})
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST')
        sendJson(res, { ok: false, code: 'METHOD_NOT_ALLOWED', message: 'method not allowed' }, 405)
        return
      }
      return readBody(req).then((body) => {
        if (body.__tooLarge) {
          res.setHeader('Connection', 'close')
          sendJson(res, { ok: false, code: 'BODY_TOO_LARGE', message: 'request body too large' }, 413)
          return
        }
        if (body.__malformed) {
          sendJson(res, { ok: false, code: 'BODY_MALFORMED', message: 'invalid JSON body' }, 400)
          return
        }
        return Promise.resolve(actions[action](body)).then((result) => {
          sendJson(res, result)
        }, (error) => {
          log('action ' + action + ' failed: ' + String((error && error.message) || error))
          sendJson(res, { ok: false, code: 'INTERNAL', message: 'internal error' }, 500)
        })
      })
    }
  }

  const claims = []
  for (const action of Object.keys(actions)) {
    try {
      claims.push(claimRoute({ kind: 'exact', path: ROUTE_PREFIX + action, handler: handlerFor(action) }))
    } catch (error) {
      for (const claim of claims.splice(0)) {
        claim.dispose()
        claim.restore()
      }
      throw error
    }
  }
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => { for (const claim of claims.splice(0)) claim.dispose() }, 'dsh-share-import: routes')
  }
}
