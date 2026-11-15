// Recording proxy for the benchmark: 127.0.0.1 -> an upstream chat-completions endpoint (OpenRouter by default).
//
// It is the only process that reads the API key. The key comes from a file named by
// BENCH_KEY_FILE (or --key-file) and is read once at start; it is never printed,
// never written to a record (every record passes through `redact`), and never
// forwarded to the model's client. A cumulative spend cap stops the run set.
//
//   BENCH_KEY_FILE   path of the file holding the key            (required)
//   BENCH_REC_FILE   JSON-lines record of every request          (default ./rec/requests.jsonl)
//   BENCH_PORT_FILE  where the chosen port is written            (default ./proxy.port)
//   BENCH_LABEL_FILE file whose first line labels the current run (default ./current-run)
//   BENCH_CAP_USD    cumulative spend cap, counted from the record (default 1)
//   BENCH_UPSTREAM   default https://openrouter.ai/api/v1
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const argValue = (name) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const KEY_FILE = argValue('--key-file') ?? process.env.BENCH_KEY_FILE
if (!KEY_FILE) {
  console.error('proxy: name the key file with BENCH_KEY_FILE or --key-file')
  process.exit(2)
}
const UPSTREAM = process.env.BENCH_UPSTREAM ?? 'https://openrouter.ai/api/v1'
const CAP_USD = Number(process.env.BENCH_CAP_USD ?? '1')
const REC = path.resolve(process.env.BENCH_REC_FILE ?? 'rec/requests.jsonl')
const PORT_FILE = path.resolve(process.env.BENCH_PORT_FILE ?? 'proxy.port')
const LABEL_FILE = path.resolve(process.env.BENCH_LABEL_FILE ?? 'current-run')
fs.mkdirSync(path.dirname(REC), { recursive: true })
const KEY = fs.readFileSync(KEY_FILE, 'utf8').trim()
if (KEY.length < 8) {
  console.error('proxy: the key file is empty or too short')
  process.exit(2)
}

let seq = 0
let spent = 0
try {
  for (const line of fs.readFileSync(REC, 'utf8').split('\n')) {
    if (!line) continue
    const r = JSON.parse(line)
    seq = Math.max(seq, r.seq ?? 0)
    if (typeof r.usage?.cost === 'number') spent += r.usage.cost
  }
} catch {}

const redact = (s) => (typeof s === 'string' ? s.split(KEY).join('[redacted]') : s)
function append(rec) {
  fs.appendFileSync(REC, redact(JSON.stringify(rec)) + '\n')
}
function runLabel(req) {
  const h = req.headers['x-trial-run']
  if (h) return String(h)
  try { return fs.readFileSync(LABEL_FILE, 'utf8').trim() } catch { return null }
}

function newAcc() {
  return { content: '', reasoning: '', tools: {}, usage: null, finish: null, model: null, id: null, raw: '' }
}
function eat(acc, obj) {
  if (obj.error) acc.error = obj.error
  if (obj.model) acc.model = obj.model
  if (obj.id) acc.id = obj.id
  if (obj.usage) acc.usage = obj.usage
  for (const ch of obj.choices ?? []) {
    if (ch.finish_reason) acc.finish = ch.finish_reason
    const d = ch.delta ?? ch.message ?? {}
    if (typeof d.content === 'string') acc.content += d.content
    if (typeof d.reasoning === 'string') acc.reasoning += d.reasoning
    else if (Array.isArray(d.reasoning_details) && typeof d.reasoning !== 'string') {
      for (const x of d.reasoning_details) if (typeof x.text === 'string') acc.reasoning += x.text
    }
    for (const tc of d.tool_calls ?? []) {
      const i = tc.index ?? 0
      const t = (acc.tools[i] ??= { id: null, name: '', arguments: '' })
      if (tc.id) t.id = tc.id
      if (tc.function?.name) t.name += tc.function.name
      if (tc.function?.arguments) t.arguments += tc.function.arguments
    }
  }
}

const server = http.createServer(async (req, res) => {
  const mySeq = ++seq
  const t0 = Date.now()
  const label = runLabel(req)
  const chunks = []
  for await (const c of req) chunks.push(c)
  const bodyBuf = Buffer.concat(chunks)
  const urlPath = req.url.replace(/^\/api\/v1(?=\/|$)/, '') || '/'
  const isChat = urlPath.startsWith('/chat/completions')
  let bodyJson = null
  let outBody = bodyBuf
  if (isChat && bodyBuf.length) {
    try {
      bodyJson = JSON.parse(bodyBuf.toString('utf8'))
    } catch {}
  }
  const rec = { seq: mySeq, time: new Date(t0).toISOString(), run: label, method: req.method, path: urlPath, request: bodyJson ?? (bodyBuf.length ? bodyBuf.toString('utf8').slice(0, 2000) : null) }

  if (isChat && spent >= CAP_USD) {
    rec.status = 402
    rec.capped = true
    rec.spent_total = spent
    rec.error = { message: `recording proxy: spend cap USD ${CAP_USD} reached (${spent.toFixed(4)})` }
    append(rec)
    res.writeHead(402, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { code: 402, message: rec.error.message } }))
    return
  }
  if (bodyJson) {
    if (!bodyJson.usage) bodyJson.usage = { include: true }
    else if (bodyJson.usage.include !== true) bodyJson.usage.include = true
    outBody = Buffer.from(JSON.stringify(bodyJson))
  }

  const headers = {}
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase()
    if (['authorization', 'host', 'connection', 'content-length', 'x-trial-run', 'accept-encoding', 'transfer-encoding'].includes(lk)) continue
    headers[k] = v
  }
  headers.authorization = `Bearer ${KEY}`
  headers['accept-encoding'] = 'identity'
  if (outBody.length) headers['content-length'] = String(outBody.length)

  let up
  try {
    up = await fetch(UPSTREAM + urlPath, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : outBody })
  } catch (e) {
    rec.status = 502
    rec.error = { message: redact(String(e?.message ?? e)) }
    append(rec)
    res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { code: 502, message: rec.error.message } }))
    return
  }
  const rh = {}
  up.headers.forEach((v, k) => {
    if (['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(k)) return
    rh[k] = v
  })
  res.writeHead(up.status, rh)
  const acc = newAcc()
  let buf = ''
  let whole = ''
  const dec = new TextDecoder()
  const sse = (up.headers.get('content-type') ?? '').includes('text/event-stream')
  try {
    for await (const chunk of up.body) {
      res.write(chunk)
      const s = dec.decode(chunk, { stream: true })
      if (isChat && sse) {
        buf += s
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, '')
          buf = buf.slice(i + 1)
          if (line.startsWith('data:')) {
            const d = line.slice(5).trim()
            if (d && d !== '[DONE]') { try { eat(acc, JSON.parse(d)) } catch {} }
          }
        }
      } else if (whole.length < 4_000_000) whole += s
    }
  } catch (e) {
    rec.stream_error = redact(String(e?.message ?? e))
  }
  res.end()
  rec.status = up.status
  rec.ms = Date.now() - t0
  if (isChat) {
    if (!sse) { try { eat(acc, JSON.parse(whole)) } catch { rec.response_text = whole.slice(0, 4000) } }
    if (up.status >= 400) { rec.error = (() => { try { return JSON.parse(whole) } catch { return whole.slice(0, 4000) } })() }
    const u = acc.usage
    rec.usage = u ? {
      prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens,
      cached_tokens: u.prompt_tokens_details?.cached_tokens,
      reasoning_tokens: u.completion_tokens_details?.reasoning_tokens,
      cost: u.cost, raw: u,
    } : null
    if (typeof u?.cost === 'number') spent += u.cost
    rec.spent_total = spent
    rec.finish_reason = acc.finish
    rec.response_model = acc.model
    rec.response = { content: acc.content, reasoning: acc.reasoning, tool_calls: Object.keys(acc.tools).sort((a, b) => a - b).map((k) => acc.tools[k]) }
  } else {
    rec.response_text = whole.slice(0, 2000)
  }
  append(rec)
})

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port
  fs.writeFileSync(PORT_FILE, String(port))
  console.log(`proxy listening on 127.0.0.1:${port}, spent so far ${spent.toFixed(4)}, cap ${CAP_USD}`)
})
