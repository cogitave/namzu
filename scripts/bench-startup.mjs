#!/usr/bin/env node
// Startup benchmark for the Namzu CLI. Reproducible by anyone with a built checkout:
//
//   pnpm -r build && node scripts/bench-startup.mjs [--runs 7] [--build <bin.js>] [--out result.json]
//
// It measures, against a local fake model server (no real or paid model call is made):
//   version / help      spawn to exit of `namzu --version` / `namzu --help`
//   tui first byte      spawn to the first byte on the pseudo-terminal
//   tui first frame     spawn to the composer box ("MESSAGE")
//   tui ready           spawn to a usable composer ("Type a message"), in a trusted folder
//   exec request        `namzu exec hello`, spawn to the request arriving at the fake server,
//                       with stdin a terminal, an open pipe nobody writes to, and /dev/null
//   modules             ES modules loaded at `--version` and at the TUI's first frame
//   rss                 peak resident set size (Linux only, from /proc VmHWM)
//
// Every run gets a fresh HOME and NAMZU_HOME under --work (default: a temp directory),
// WSL_DISTRO_NAME / WSL_INTEROP / CI unset and, with --strip-mnt (default on), every /mnt/*
// entry removed from PATH. Nothing here touches an installed Namzu.

import { spawn, spawnSync } from 'node:child_process'
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
	const opts = {
		runs: 7,
		build: join(root, 'packages/cli/dist/bin.js'),
		out: null,
		work: null,
		only: null,
		stripMnt: true,
		sharedCache: true,
	}
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]
		if (a === '--runs') opts.runs = Number(argv[++i])
		else if (a === '--build') opts.build = resolve(argv[++i])
		else if (a === '--out') opts.out = resolve(argv[++i])
		else if (a === '--work') opts.work = resolve(argv[++i])
		else if (a === '--only') opts.only = new Set(argv[++i].split(','))
		else if (a === '--no-strip-mnt') opts.stripMnt = false
		else if (a === '--cold-cache') opts.sharedCache = false
		else if (a === '--help' || a === '-h') {
			process.stdout.write(
				'Usage: node scripts/bench-startup.mjs [--runs N] [--build <bin.js>] [--out <file.json>]\n' +
					'       [--work <dir>] [--only version,help,tui,exec] [--no-strip-mnt] [--cold-cache]\n',
			)
			process.exit(0)
		} else throw new Error(`unknown option ${a}`)
	}
	if (!Number.isInteger(opts.runs) || opts.runs < 1) throw new Error('--runs must be a positive integer')
	if (!existsSync(opts.build)) throw new Error(`${opts.build} does not exist; run pnpm -r build first`)
	return opts
}

const opts = parseArgs(process.argv.slice(2))
const work = opts.work ?? mkdtempSync(join(tmpdir(), 'namzu-bench-'))
mkdirSync(work, { recursive: true })
const want = (name) => opts.only === null || opts.only.has(name)

const requireFromCli = createRequire(join(root, 'packages/cli/package.json'))
const redirect = join(root, 'packages/desktop/e2e/redirect-fetch.cjs')

// ---- the fake model server -------------------------------------------------------------

function startFakeModel() {
	const log = []
	const server = createServer((req, res) => {
		const arrived = Date.now()
		const chunks = []
		req.on('data', (c) => chunks.push(c))
		req.on('end', () => {
			const path = new URL(req.url, 'http://x').pathname
			if (path.endsWith('/models')) {
				res.setHeader('content-type', 'application/json')
				res.end(
					JSON.stringify({
						object: 'list',
						data: [{ id: 'claude-sonnet-5-5', object: 'model', created: 1, owned_by: 'bench' }],
					}),
				)
				return
			}
			let parsed = {}
			try {
				parsed = JSON.parse(Buffer.concat(chunks).toString())
			} catch {}
			log.push({ at: arrived, path })
			const id = 'chatcmpl-bench'
			const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
			const frame = (delta, finish) =>
				`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
			if (!parsed.stream) {
				res.setHeader('content-type', 'application/json')
				res.end(
					JSON.stringify({
						id,
						object: 'chat.completion',
						created: 1,
						model: parsed.model,
						choices: [{ index: 0, message: { role: 'assistant', content: 'PONG' }, finish_reason: 'stop' }],
						usage,
					}),
				)
				return
			}
			res.writeHead(200, { 'content-type': 'text/event-stream' })
			res.write(frame({ role: 'assistant', content: 'PONG' }, null))
			res.write(frame({}, 'stop'))
			res.end('data: [DONE]\n\n')
		})
	})
	return new Promise((ok) =>
		server.listen(0, '127.0.0.1', () =>
			ok({ url: `http://127.0.0.1:${server.address().port}`, log, close: () => server.close() }),
		),
	)
}

// ---- environment -----------------------------------------------------------------------

let homeCounter = 0
function freshHome(label) {
	const home = join(work, `${label}-${++homeCounter}`)
	rmSync(home, { recursive: true, force: true })
	mkdirSync(join(home, '.namzu'), { recursive: true })
	const project = join(home, 'proj')
	mkdirSync(join(project, 'src'), { recursive: true })
	writeFileSync(join(project, 'README.md'), '# proj\n')
	writeFileSync(join(project, 'src', 'a.ts'), 'export const a = 1\n')
	spawnSync('git', ['init', '-q', '.'], { cwd: project })
	if (opts.sharedCache) {
		// A person's V8 compile cache outlives a launch because it lives in their
		// Namzu home. Every run here gets a fresh home, so the cache directory is
		// a link to one shared folder; --cold-cache measures a first run instead.
		const shared = join(work, 'shared-cache')
		mkdirSync(shared, { recursive: true })
		symlinkSync(shared, join(home, '.namzu', 'cache'), 'dir')
	}
	writeFileSync(
		join(home, '.namzu', 'preferences.json'),
		JSON.stringify({ version: 3, providers: [{ id: 'openai', model: 'claude-sonnet-5-5' }], subagents: { active: [] } }),
	)
	writeFileSync(join(home, '.namzu', 'trust.json'), JSON.stringify({ version: 1, trusted: [project] }))
	return { home, project }
}

const SECRET_VARS = [
	'ANTHROPIC_API_KEY',
	'ANTHROPIC_TOKEN',
	'CLAUDE_CODE_OAUTH_TOKEN',
	'OPENAI_API_KEY',
	'GEMINI_API_KEY',
	'GOOGLE_API_KEY',
	'DEEPSEEK_API_KEY',
	'OPENROUTER_API_KEY',
	'OPENCODE_API_KEY',
	'OPENCODE_ZEN_API_KEY',
]

function benchEnv(home, { modelUrl, loadLog } = {}) {
	const env = { ...process.env }
	for (const k of ['WSL_DISTRO_NAME', 'WSL_INTEROP', 'CI', 'NODE_OPTIONS', 'GITHUB_ACTIONS', ...SECRET_VARS]) delete env[k]
	env.HOME = home
	env.USERPROFILE = home
	env.NAMZU_HOME = join(home, '.namzu')
	env.TERM = 'xterm-256color'
	if (opts.stripMnt && process.platform !== 'win32') {
		env.PATH = (env.PATH ?? '').split(':').filter((p) => !p.startsWith('/mnt')).join(':')
	}
	const nodeOptions = []
	if (modelUrl) {
		env.NAMZU_E2E_MODEL_URL = modelUrl
		env.OPENAI_API_KEY = 'bench-not-a-secret'
		nodeOptions.push(`--require=${redirect}`)
	}
	if (loadLog) {
		env.NAMZU_BENCH_LOADLOG = loadLog
		nodeOptions.push(`--import=${loaderHookUrl}`)
	}
	if (nodeOptions.length > 0) env.NODE_OPTIONS = nodeOptions.join(' ')
	return env
}

// A loader hook, registered from a data: URL so this stays one file, that appends every module
// it loads to NAMZU_BENCH_LOADLOG. Its own cost is why module counts come from separate runs.
const hookSource = `
import { appendFileSync } from 'node:fs'
export async function load(url, context, nextLoad) {
  const out = process.env.NAMZU_BENCH_LOADLOG
  if (out && !url.startsWith('node:')) { try { appendFileSync(out, url + '\\n') } catch {} }
  return nextLoad(url, context)
}
`
const loaderHookUrl = `data:text/javascript,${encodeURIComponent(
	`import { register } from 'node:module'; register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(hookSource)}`)})`,
)}`

function countLines(file) {
	try {
		const t = readFileSync(file, 'utf8')
		return t === '' ? 0 : t.trimEnd().split('\n').length
	} catch {
		return 0
	}
}

// ---- measuring helpers -----------------------------------------------------------------

function peakRssKb(pid) {
	if (process.platform !== 'linux') return null
	try {
		const m = /VmHWM:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))
		return m ? Number(m[1]) : null
	} catch {
		return null
	}
}

/** Sample the process' peak RSS until it exits; resolves to the last reading. */
function trackRss(pid) {
	const state = { kb: null }
	const timer = setInterval(() => {
		const kb = peakRssKb(pid)
		if (kb !== null) state.kb = kb
	}, 40)
	return { state, stop: () => clearInterval(timer) }
}

function runToExit(args, env, cwd, stdin) {
	return new Promise((ok) => {
		const t0 = performance.now()
		const child = spawn(process.execPath, [opts.build, ...args], { cwd, env, stdio: [stdin, 'ignore', 'ignore'] })
		const rss = trackRss(child.pid)
		child.on('exit', (code) => {
			rss.stop()
			ok({ ms: performance.now() - t0, code, rssKb: rss.state.kb })
		})
	})
}

function ptySpawn(args, env, cwd) {
	const pty = requireFromCli('node-pty')
	return pty.spawn(process.execPath, [opts.build, ...args], {
		name: 'xterm-256color',
		cols: 120,
		rows: 42,
		cwd,
		env,
	})
}

function until(predicate, label, ms = 60000) {
	return new Promise((ok, fail) => {
		const t0 = Date.now()
		const tick = () => {
			if (predicate()) return ok()
			if (Date.now() - t0 > ms) return fail(new Error(`timed out waiting for ${label}`))
			setTimeout(tick, 2)
		}
		tick()
	})
}

async function tuiRun({ loadLog }) {
	const model = await startFakeModel()
	const { home, project } = freshHome('tui')
	const env = benchEnv(home, { modelUrl: model.url, loadLog })
	const t0 = performance.now()
	const term = ptySpawn([], env, project)
	const rss = trackRss(term.pid)
	let buf = ''
	const seen = {}
	const modulesAt = {}
	term.onData((d) => {
		const now = performance.now() - t0
		buf += d
		if (seen.firstByte === undefined) seen.firstByte = now
		if (seen.firstFrame === undefined && buf.includes('MESSAGE')) {
			seen.firstFrame = now
			if (loadLog) modulesAt.firstFrame = countLines(loadLog)
		}
		if (seen.ready === undefined && buf.includes('Type a message')) seen.ready = now
	})
	try {
		await until(() => seen.ready !== undefined, 'composer ready')
		await new Promise((r) => setTimeout(r, 200))
	} finally {
		rss.stop()
		const kb = peakRssKb(term.pid) ?? rss.state.kb
		term.kill()
		model.close()
		seen.rssKb = kb
	}
	return { ...seen, modules: modulesAt.firstFrame }
}

async function execRun(stdinMode) {
	const model = await startFakeModel()
	const { home, project } = freshHome(`exec-${stdinMode}`)
	const env = benchEnv(home, { modelUrl: model.url })
	const t0 = Date.now()
	let child
	let kill
	let exited
	if (stdinMode === 'tty') {
		const term = ptySpawn(['exec', 'hello'], env, project)
		term.onData(() => {})
		exited = new Promise((ok) => term.onExit(ok))
		child = { pid: term.pid }
		kill = () => term.kill()
	} else {
		const proc = spawn(process.execPath, [opts.build, 'exec', 'hello'], {
			cwd: project,
			env,
			stdio: [stdinMode === 'null' ? 'ignore' : 'pipe', 'ignore', 'ignore'],
		})
		exited = new Promise((ok) => proc.on('exit', ok))
		child = proc
		kill = () => proc.kill()
	}
	const rss = trackRss(child.pid)
	await until(() => model.log.length > 0, 'the request')
	const requestMs = model.log[0].at - t0
	await exited
	rss.stop()
	kill()
	model.close()
	return { requestMs, rssKb: rss.state.kb }
}

function summarize(xs) {
	const v = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b)
	if (v.length === 0) return null
	const mid = v.length >> 1
	const median = v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2
	return { n: v.length, median: Math.round(median * 10) / 10, min: Math.round(v[0] * 10) / 10, max: Math.round(v[v.length - 1] * 10) / 10 }
}

// ---- the run ---------------------------------------------------------------------------

const results = {}
const record = (name, samples) => {
	results[name] = summarize(samples)
	const r = results[name]
	process.stderr.write(r ? `${name.padEnd(34)} ${String(r.median).padStart(8)}  (${r.min} - ${r.max}, n=${r.n})\n` : `${name}: no samples\n`)
}

process.stderr.write(`build ${opts.build}\nnode ${process.version} on ${process.platform}-${process.arch}, ${opts.runs} runs per metric\n`)

for (const flag of ['version', 'help']) {
	if (!want(flag)) continue
	const { home, project } = freshHome(flag)
	const env = benchEnv(home)
	await runToExit([`--${flag}`], env, project, 'ignore') // the first run fills the OS file cache
	const ms = []
	const rss = []
	for (let i = 0; i < opts.runs; i++) {
		const r = await runToExit([`--${flag}`], env, project, 'ignore')
		ms.push(r.ms)
		rss.push(r.rssKb)
	}
	record(`${flag} ms`, ms)
	record(`${flag} peak rss kB`, rss)
}

if (want('version')) {
	const { home, project } = freshHome('modules')
	const loadLog = join(work, 'modules-version.log')
	rmSync(loadLog, { force: true })
	await runToExit(['--version'], benchEnv(home, { loadLog }), project, 'ignore')
	results['modules at --version'] = countLines(loadLog)
	process.stderr.write(`${'modules at --version'.padEnd(34)} ${results['modules at --version']}\n`)
}

if (want('tui')) {
	const samples = { firstByte: [], firstFrame: [], ready: [], rssKb: [], modules: [] }
	await tuiRun({}) // warm the file cache
	for (let i = 0; i < opts.runs; i++) {
		const r = await tuiRun({})
		for (const k of ['firstByte', 'firstFrame', 'ready', 'rssKb']) samples[k].push(r[k])
	}
	record('tui first byte ms', samples.firstByte)
	record('tui first frame ms', samples.firstFrame)
	record('tui ready ms', samples.ready)
	record('tui peak rss kB', samples.rssKb)
	const loadLog = join(work, 'modules-tui.log')
	rmSync(loadLog, { force: true })
	const counted = await tuiRun({ loadLog })
	results['modules at tui first frame'] = counted.modules ?? null
	process.stderr.write(`${'modules at tui first frame'.padEnd(34)} ${counted.modules}\n`)
}

if (want('exec')) {
	for (const mode of ['tty', 'pipe', 'null']) {
		const ms = []
		const rss = []
		await execRun(mode)
		for (let i = 0; i < opts.runs; i++) {
			const r = await execRun(mode)
			ms.push(r.requestMs)
			rss.push(r.rssKb)
		}
		record(`exec request ms (stdin ${mode})`, ms)
		record(`exec peak rss kB (stdin ${mode})`, rss)
	}
}

results.meta = { node: process.version, platform: `${process.platform}-${process.arch}`, runs: opts.runs, build: opts.build }
if (opts.out) writeFileSync(opts.out, `${JSON.stringify(results, null, 2)}\n`)
process.stdout.write(`${JSON.stringify(results, null, 2)}\n`)
if (!opts.work) rmSync(work, { recursive: true, force: true })
