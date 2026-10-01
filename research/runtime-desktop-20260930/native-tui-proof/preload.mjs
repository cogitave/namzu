import { createServer } from 'node:http'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Test instrumentation only: the production binary, Ink, Node console and Pal
// computer composition are unchanged. No request may leave loopback.
const root = process.env.NAMZU_NATIVE_TUI_PROOF_ROOT
if (!root) throw new Error('NAMZU_NATIVE_TUI_PROOF_ROOT is required')
mkdirSync(root, { recursive: true })
const run = process.env.NAMZU_NATIVE_TUI_PROOF_RUN ?? 'startup'
const receipt = {
  pid: process.pid, platform: process.platform, node: process.version,
  stdinTTY: process.stdin.isTTY === true, stdoutTTY: process.stdout.isTTY === true,
  stderrTTY: process.stderr.isTTY === true,
  argv: process.argv.slice(1), requests: [], blockedRequests: [], input: [],
}
const append = (name, text) => appendFileSync(join(root, `${run}-${name}.txt`), text)
const originalOut = process.stdout.write.bind(process.stdout)
const originalErr = process.stderr.write.bind(process.stderr)
process.stdout.write = (value, ...args) => { append('stdout', String(value)); return originalOut(value, ...args) }
process.stderr.write = (value, ...args) => { append('stderr', String(value)); return originalErr(value, ...args) }
process.stdin.on('data', (bytes) => { receipt.input.push(Buffer.from(bytes).toString('utf8')); save() })
function save() { writeFileSync(join(root, `${run}-receipt.json`), JSON.stringify(receipt, null, 2)) }
process.on('exit', (code) => { receipt.exitCode = code; save() })
process.on('uncaughtExceptionMonitor', (error) => { receipt.uncaught = error.stack; save() })
const server = createServer((req, res) => {
  void (async () => {
  let raw = ''
  for await (const chunk of req) raw += chunk
  const body = raw ? JSON.parse(raw) : null
  receipt.requests.push({ method: req.method, path: req.url, body })
  save()
  if (req.url === '/api/tags') {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ models: [{ name: 'native-fixture', model: 'native-fixture', size: 1, details: {} }] }))
  } else if (req.url === '/api/chat') {
    const environment = await import(pathToFileURL(join(dirname(process.argv[1]), 'pals', 'environment.js')).href)
    const runtime = await environment.getCliPalRuntime()
    const lease = runtime.computer(process.argv[4])
    if (!lease) throw new Error('Actual CLI Pal computer lease is absent')
    const screen = await lease.computerUseHost.execute({ type: 'screenshot' })
    receipt.computer = {
      palId: lease.palId, environmentId: lease.environmentId, generation: String(lease.generation),
      busyDuringProvider: runtime.busy(lease.palId), sandboxStatus: lease.sandbox.status,
      rootDir: lease.sandbox.rootDir,
      screenshotType: screen.type,
      screenshotPng: screen.type === 'screenshot' && Buffer.isBuffer(screen.result.data) && screen.result.data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
      screenshotBytes: screen.type === 'screenshot' ? screen.result.data.length : null,
    }
    save()
    res.setHeader('content-type', 'application/x-ndjson')
    res.end(JSON.stringify({ model: 'native-fixture', created_at: new Date().toISOString(), message: { role: 'assistant', content: 'NATIVE_TUI_LOCAL_REPLY_OK' }, done: false }) + '\n' + JSON.stringify({ model: 'native-fixture', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 8, eval_count: 4 }) + '\n')
  } else {
    res.statusCode = 404
    res.end('{}')
  }
  })().catch((error) => {
    receipt.fixtureError = error instanceof Error ? error.message : String(error)
    save()
    res.statusCode = 500
    res.end('{}')
  })
})
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
const port = server.address().port
const realFetch = globalThis.fetch
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  if (url.protocol === 'data:') return realFetch(input, init)
  if (url.hostname === 'localhost' && url.port === '11434') {
    const target = new URL(url.pathname + url.search, `http://127.0.0.1:${port}`)
    return realFetch(target, init)
  }
  // Actual Pal worker HTTP is published on an owned loopback port by Podman.
  if (url.hostname === '127.0.0.1' || url.hostname === '[::1]') return realFetch(input, init)
  receipt.blockedRequests.push({ origin: url.origin, pathname: url.pathname.slice(0, 256) })
  save()
  return Promise.reject(new Error('Native TUI fixture blocks non-fixture network requests'))
}
save()
writeFileSync(join(root, `${run}-console-ready.json`), JSON.stringify({ pid: process.pid, port, stdinTTY: receipt.stdinTTY, stdoutTTY: receipt.stdoutTTY }))
