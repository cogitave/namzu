#!/usr/bin/env node
'use strict'

// Adapt the reviewed NPGameDev 1.0.3 bridge without authoring project/game code.
// The editor is a separate process: an MCP error does not prove it stopped.
const { AsyncLocalStorage } = require('node:async_hooks')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const { createRequire, registerHooks } = require('node:module')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const PIN = require('./pal-godot-mcp-pin.json')
const SEAL = '.namzu-build-integrity.json'
const OUTCOME = 'namzu/outcome'
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')

class GodotOutcomeGuard {
  constructor() {
    this.storage = new AsyncLocalStorage()
    this.requests = new Map()
    this.unknown = false
  }

  async run(handler) {
    const scope = { pending: new Set(), issued: false, unknown: false, ended: false }
    if (this.unknown) return this.annotate({}, 'unknown')
    return this.storage.run(scope, async () => {
      let result
      try {
        result = await handler()
      } catch (error) {
        result = { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] }
      }
      scope.ended = true
      if (scope.pending.size || scope.unknown) this.unknown = true
      return this.annotate(result, this.unknown ? 'unknown' : scope.issued ? 'settled' : 'not_dispatched')
    })
  }

  annotate(result, outcome) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      this.unknown = true
      result = {}
      outcome = 'unknown'
    }
    const value = { ...result, _meta: { ...(result._meta || {}), [OUTCOME]: outcome } }
    if (outcome === 'unknown') {
      value.isError = true
      value.content = [
        ...(Array.isArray(result.content) ? result.content : []),
        { type: 'text', text: 'Godot did not confirm command completion. Do not retry or take over; stop and restart this computer before further work.' },
      ]
    }
    return value
  }

  beforeSend(socket, data) {
    if (typeof data !== 'string') return undefined
    let rpc
    try { rpc = JSON.parse(data) } catch { return undefined }
    if (!rpc || rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string' || rpc.id === undefined) return undefined
    // Runtime heartbeat is observational; it intentionally outlives a tool call.
    if (rpc.method === 'ping') return undefined
    const scope = this.storage.getStore()
    if (this.unknown) throw new Error('The Godot command outcome is unknown; restart this computer before further work.')
    if (!scope || scope.ended) throw new Error('Godot editor commands require an active owned MCP request.')
    let requests = this.requests.get(socket)
    if (!requests) this.requests.set(socket, requests = new Map())
    if (requests.has(rpc.id)) throw new Error('A Godot editor request ID is already active.')
    const record = { socket, id: rpc.id, scope }
    scope.issued = true
    scope.pending.add(record)
    requests.set(rpc.id, record)
    return record
  }

  ambiguous(record) {
    if (!record) return
    record.scope.unknown = true
    this.unknown = true
    this.forget(record)
  }

  forget(record) {
    record.scope.pending.delete(record)
    const requests = this.requests.get(record.socket)
    requests?.delete(record.id)
    if (requests?.size === 0) this.requests.delete(record.socket)
  }

  receive(socket, data) {
    const requests = this.requests.get(socket)
    if (!requests?.size) return
    let rpc
    try { rpc = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data)) } catch { return }
    if (!rpc || rpc.jsonrpc !== '2.0' || rpc.method !== undefined || rpc.id === undefined || own(rpc, 'result') === own(rpc, 'error')) return
    const record = requests.get(rpc.id)
    if (!record) return
    // The toolkit watchdog sends a JSON-RPC error while its cancelled coroutine
    // may still run. Only an application result proves the handler returned.
    if (own(rpc, 'error')) this.ambiguous(record)
    else this.forget(record)
  }

  disconnected(socket) {
    for (const record of [...(this.requests.get(socket)?.values() || [])]) this.ambiguous(record)
  }

  installWebSocket(WebSocket) {
    const guard = this
    const send = WebSocket.prototype.send
    const emit = WebSocket.prototype.emit
    WebSocket.prototype.send = function (...args) {
      const record = guard.beforeSend(this, args[0])
      const callbackIndex = typeof args[args.length - 1] === 'function' ? args.length - 1 : -1
      if (record && callbackIndex >= 0) {
        const callback = args[callbackIndex]
        args[callbackIndex] = function (error, ...rest) {
          if (error) guard.ambiguous(record)
          return callback.call(this, error, ...rest)
        }
      }
      try { return send.apply(this, args) } catch (error) { guard.ambiguous(record); throw error }
    }
    WebSocket.prototype.emit = function (event, ...args) {
      if (event === 'message') guard.receive(this, args[0])
      else if (event === 'close' || event === 'error') guard.disconnected(this)
      return emit.call(this, event, ...args)
    }
    return () => { WebSocket.prototype.send = send; WebSocket.prototype.emit = emit }
  }

  installServer(Server) {
    const guard = this
    const setRequestHandler = Server.prototype.setRequestHandler
    Server.prototype.setRequestHandler = function (schema, handler) {
      return setRequestHandler.call(this, schema, (request, extra) => guard.run(() => handler(request, extra)))
    }
    return () => { Server.prototype.setRequestHandler = setRequestHandler }
  }
}

function adaptModule(relative, source) {
  const replaceOnce = (before, after) => {
    if (source.split(before).length !== 2) throw new Error(`The pinned Godot adaptation no longer matches ${relative}`)
    source = source.replace(before, after)
  }
  if (relative === 'dist/transport/channel.js') {
    replaceOnce('const noReconnect = opts?.noReconnect ?? false;', 'const noReconnect = true;')
    replaceOnce('if (!hasConnectedOnce)\n            return connect();', 'if (!hasConnectedOnce)\n            return connect();\n        if (noReconnect) return Promise.reject(new BridgeError("DISCONNECTED", "Owned Godot bridge cannot reconnect"));')
  }
  if (relative === 'dist/index.js') {
    // Startup extension discovery sends editor RPCs before the MCP admission.
    // Builtin tools remain available; extensions are not part of this install.
    replaceOnce('const { timedOut } = await extensions.discoverEagerly();', 'const timedOut = false;')
    // First editor authentication can trigger a detached startup reconcile.
    // Its extension refresh would otherwise share a finished tool's context.
    replaceOnce('discover: extensions.discoverExtensions', 'discover: async () => {}')
  }
  return source
}

function checkSource(root) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  if (pkg.name !== '@npgamedev/godot-mcp-server' || pkg.version !== '1.0.3') throw new Error('Godot bridge package must match reviewed 1.0.3')
  for (const [relative, expected] of Object.entries(PIN.files)) {
    if (digest(fs.readFileSync(path.join(root, relative))) !== expected) throw new Error(`Godot bridge source differs from reviewed pin: ${relative}`)
  }
}

function sealBuild(root) {
  root = fs.realpathSync(root)
  checkSource(root)
  const files = {}
  const walk = (directory) => {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, item.name)
      if (item.isSymbolicLink()) throw new Error('Godot bridge build cannot contain symlinks')
      if (item.isDirectory()) walk(filename)
      else if (item.isFile()) files[path.relative(root, filename).split(path.sep).join('/')] = digest(fs.readFileSync(filename))
    }
  }
  walk(path.join(root, 'dist'))
  if (!files['dist/index.js'] || !files['dist/transport/channel.js']) throw new Error('Build the pinned Godot bridge before sealing it')
  adaptModule('dist/index.js', fs.readFileSync(path.join(root, 'dist/index.js'), 'utf8'))
  adaptModule('dist/transport/channel.js', fs.readFileSync(path.join(root, 'dist/transport/channel.js'), 'utf8'))
  fs.writeFileSync(path.join(root, SEAL), `${JSON.stringify({ commit: PIN.commit, files }, null, 2)}\n`, { mode: 0o600 })
}

async function main(root) {
  root = fs.realpathSync(root)
  if (typeof registerHooks !== 'function') throw new Error('Owned Godot bridge requires Node 22.15+ with synchronous module hooks')
  checkSource(root)
  const seal = JSON.parse(fs.readFileSync(path.join(root, SEAL), 'utf8'))
  if (seal.commit !== PIN.commit || !seal.files || typeof seal.files !== 'object') throw new Error('Godot bridge build integrity is missing')
  const project = process.env.GODOT_MCP_PROJECT_PATH
  if (!project || !path.isAbsolute(project) || path.resolve(project) !== path.resolve(process.cwd())) throw new Error('Pin the Godot project with its exact guest cwd and GODOT_MCP_PROJECT_PATH')
  if (!/^[0-9]+$/.test(process.env.GODOT_MCP_EDITOR_PORT || '')) throw new Error('Pin GODOT_MCP_EDITOR_PORT to disable registry rediscovery/retry')
  const rootUrl = pathToFileURL(`${root}${path.sep}`).href
  registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context)
      if (!url.startsWith(rootUrl) || !url.slice(rootUrl.length).startsWith('dist/')) return loaded
      const relative = decodeURIComponent(url.slice(rootUrl.length))
      const expected = seal.files[relative]
      if (!expected || digest(fs.readFileSync(path.join(root, relative))) !== expected) throw new Error(`Godot bridge built module changed: ${relative}`)
      if (relative === 'dist/index.js' || relative === 'dist/transport/channel.js') {
        if (loaded.source == null) throw new Error(`Godot bridge module source is unavailable: ${relative}`)
        const source = typeof loaded.source === 'string' ? loaded.source : Buffer.from(loaded.source).toString('utf8')
        return { ...loaded, source: adaptModule(relative, source) }
      }
      return loaded
    },
  })
  const requireServer = createRequire(path.join(root, 'package.json'))
  const sdkCjs = requireServer.resolve('@modelcontextprotocol/sdk/server/index.js')
  const sdkEsm = sdkCjs.replace(`${path.sep}dist${path.sep}cjs${path.sep}`, `${path.sep}dist${path.sep}esm${path.sep}`)
  if (sdkEsm === sdkCjs) throw new Error('The installed MCP SDK does not match the reviewed dual-module layout')
  const { Server } = await import(pathToFileURL(sdkEsm).href)
  const guard = new GodotOutcomeGuard()
  guard.installWebSocket(requireServer('ws').WebSocket)
  guard.installServer(Server)
  // The upstream CLI receives no wrapper/root arguments.
  process.argv = [process.argv[0], path.join(root, 'dist/index.js')]
  await import(pathToFileURL(path.join(root, 'dist/index.js')).href)
}

module.exports = { GodotOutcomeGuard, adaptModule, checkSource, sealBuild }
if (require.main === module) {
  const preparing = process.argv[2] === '--seal'
  const root = process.argv[preparing ? 3 : 2]
  if (!root || !path.isAbsolute(root) || process.argv.length !== (preparing ? 4 : 3)) {
    process.stderr.write('Usage: node pal-godot-mcp.cjs [--seal] /absolute/guest/server-root\n')
    process.exitCode = 1
  } else if (preparing) {
    try { sealBuild(root) } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
  } else main(root).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
}
