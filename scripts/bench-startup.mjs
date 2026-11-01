#!/usr/bin/env node
// Startup benchmark for the Namzu CLI. Reproducible by anyone with a built checkout:
//
//   pnpm -r build && node scripts/bench-startup.mjs [--runs 7] [--build <bin.js>] [--out result.json]
//
// It measures, against a local fake model server (no real or paid model call is made):
//   version / help      spawn to exit of `namzu --version` / `namzu --help`
//   tui first byte      spawn to the first byte on the pseudo-terminal
//   tui first frame     spawn to the composer box (its rule line), still loading
//   tui ready           spawn to a usable composer (its "❯" prompt glyph, never the placeholder
//                       text, which changes), in a trusted folder
//   exec request        `namzu exec hello`, spawn to the request arriving at the fake server,
//                       with stdin a terminal, an open pipe nobody writes to, and /dev/null
//   modules             ES modules loaded at `--version` and at the TUI's first frame
//   rss                 peak resident set size (Linux only, from /proc VmHWM)
//
// --check turns the same machinery into a gate (see "the budget check" at the bottom): a lean
// set of metrics, a fresh process per sample, the median of at least five, CPU time recorded
// beside wall time, each compared with a budget committed in scripts/bench-startup.budgets.json.
// It adds one metric the manual run lacks: resuming a large generated session.
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
	readdirSync,
	statSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const MIN_CHECK_SAMPLES = 5
// Committed beside this script, deliberately not a flag or an environment variable: a budget
// that a run can loosen is a measurement, not a gate.
const BUDGETS_FILE = join(dirname(fileURLToPath(import.meta.url)), 'bench-startup.budgets.json')
// The generated session the resume metric opens: 400 turns, each a question and three long
// answers, so about 2,400 log records and 2 MB.
const RESUME_TURNS = 400
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
		modelsDelay: 0,
		check: false,
	}
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]
		if (a === '--runs') opts.runs = Number(argv[++i])
		else if (a === '--build') opts.build = resolve(argv[++i])
		else if (a === '--out') opts.out = resolve(argv[++i])
		else if (a === '--work') opts.work = resolve(argv[++i])
		else if (a === '--only') opts.only = new Set(argv[++i].split(','))
		else if (a === '--models-delay') opts.modelsDelay = Number(argv[++i])
		else if (a === '--check') opts.check = true
		else if (a === '--no-strip-mnt') opts.stripMnt = false
		else if (a === '--cold-cache') opts.sharedCache = false
		else if (a === '--help' || a === '-h') {
			process.stdout.write(
				'Usage: node scripts/bench-startup.mjs [--runs N] [--build <bin.js>] [--out <file.json>]\n' +
					'       [--work <dir>] [--only version,help,tui,exec] [--no-strip-mnt] [--cold-cache] [--models-delay <ms>]\n' +
					'       node scripts/bench-startup.mjs --check [--runs N>=5] [--work <dir>] [--out <file.json>]\n',
			)
			process.exit(0)
		} else throw new Error(`unknown option ${a}`)
	}
	if (!Number.isFinite(opts.modelsDelay) || opts.modelsDelay < 0)
		throw new Error('--models-delay must be a number of milliseconds')
	if (!Number.isInteger(opts.runs) || opts.runs < 1) throw new Error('--runs must be a positive integer')
	if (opts.check) {
		if (!argv.includes('--runs')) opts.runs = MIN_CHECK_SAMPLES
		if (opts.runs < MIN_CHECK_SAMPLES) throw new Error(`--check needs --runs of at least ${MIN_CHECK_SAMPLES}: a median of fewer is noise`)
	}
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
				const body = JSON.stringify({
					object: 'list',
					data: [{ id: 'claude-sonnet-5-5', object: 'model', created: 1, owned_by: 'bench' }],
				})
				// --models-delay holds the model listing back, to show whether anything waits for it.
				setTimeout(() => {
					res.setHeader('content-type', 'application/json')
					res.end(body)
				}, opts.modelsDelay)
				return
			}
			let parsed = {}
			try {
				parsed = JSON.parse(Buffer.concat(chunks).toString())
			} catch {}
			log.push({ at: arrived, path, body: Buffer.concat(chunks).toString() })
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

/** CPU time (user + system) a live process has used so far, in ms; null off Linux. */
function cpuMsOfPid(pid) {
	if (process.platform !== 'linux') return null
	try {
		// Fields after the ")" that closes the command name start at "state" (field 3).
		const f = readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /s, '').split(' ')
		return ((Number(f[11]) + Number(f[12])) * 1000) / 100 // utime + stime in clock ticks, 100 Hz
	} catch {
		return null
	}
}

// Runs the build to exit inside a tiny wrapper process and reports its wall time and the CPU
// time of the waited-for child (cutime + cstime of the wrapper), so a process that has already
// exited can still be charged. The wrapper's own start-up is outside both numbers.
const measureSource = `
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
const [bin, ...args] = process.argv.slice(1)
const t0 = performance.now()
const r = spawnSync(process.execPath, [bin, ...args], { stdio: 'ignore' })
const wallMs = performance.now() - t0
let cpuMs = null
try {
  const f = readFileSync('/proc/self/stat', 'utf8').replace(/^.*\\) /s, '').split(' ')
  cpuMs = ((Number(f[13]) + Number(f[14])) * 1000) / 100
} catch {}
process.stdout.write(JSON.stringify({ wallMs, cpuMs, code: r.status }))
`

function runMeasured(args, env, cwd) {
	const r = spawnSync(process.execPath, ['--input-type=module', '-e', measureSource, opts.build, ...args], {
		cwd,
		env,
		encoding: 'utf8',
	})
	return JSON.parse(r.stdout)
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
		if (seen.firstFrame === undefined && buf.includes('──────')) {
			seen.firstFrame = now
			if (loadLog) modulesAt.firstFrame = countLines(loadLog)
		}
		if (seen.ready === undefined && buf.includes('❯')) {
			seen.ready = now
			seen.readyCpu = cpuMsOfPid(term.pid)
		}
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
	const cpuMs = cpuMsOfPid(child.pid)
	await exited
	rss.stop()
	kill()
	model.close()
	return { requestMs, cpuMs, rssKb: rss.state.kb }
}

function summarize(xs) {
	const v = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b)
	if (v.length === 0) return null
	const mid = v.length >> 1
	const median = v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2
	const p90 = v[Math.min(v.length - 1, Math.ceil(v.length * 0.9) - 1)]
	return { n: v.length, p90: Math.round(p90 * 10) / 10, median: Math.round(median * 10) / 10, min: Math.round(v[0] * 10) / 10, max: Math.round(v[v.length - 1] * 10) / 10 }
}

// ---- the run ---------------------------------------------------------------------------

if (opts.check) {
	await runCheck()
	process.exit(process.exitCode ?? 0)
}

const results = {}
const record = (name, samples) => {
	results[name] = summarize(samples)
	const r = results[name]
	process.stderr.write(r ? `${name.padEnd(34)} ${String(r.median).padStart(8)}  (p90 ${r.p90}, ${r.min} - ${r.max}, n=${r.n})\n` : `${name}: no samples\n`)
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

// ---- the budget check ------------------------------------------------------------------
//
// Method (the same for every metric): a fresh process per sample, a throw-away first run so the
// OS file cache and the shared V8 compile cache are warm as they are for a person's second
// launch, then the MEDIAN of --runs samples (at least five), wall time and CPU time side by
// side. The budget for a metric is reference x ciScale x headroom, all three committed in
// scripts/bench-startup.budgets.json: the reference is a median measured on a pinned two-core
// machine, ciScale is how much slower a shared CI runner is allowed to be, and headroom is the
// slack for run-to-run noise. Lower a reference when a change makes something faster; raise one
// only with the reason in the commit that raises it.

/** Build a session of RESUME_TURNS turns in the CLI's own log format, through the SDK's writer. */
async function growSession(file, sessionDir, sessionId) {
	const sdk = await import(pathToFileURL(requireFromCli.resolve('@namzu/sdk')).href)
	const log = new sdk.DiskSessionLog({ sessionId, file, sessionDir })
	const lease = await log.claim({ holder: 'bench-startup', ttlMs: 600000 })
	if (!lease) throw new Error('the bootstrap session is still leased; cannot grow it')
	const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15, cachedTokens: 0, cacheWriteTokens: 0 }
	const cost = { totalCost: 0, cacheDiscount: 0, unpricedTokens: 0 }
	try {
		for (let t = 0; t < RESUME_TURNS; t++) {
			const turnId = sdk.generateTurnId()
			const asked = sdk.generateMessageId()
			await log.beginTurn(lease, { turnId, userMessageId: asked, config: { model: 'claude-sonnet-5-5', tokenBudget: 0, timeoutMs: 0 } })
			await log.append(lease, { type: 'message', turnId, messageId: asked, role: 'user', content: { role: 'user', content: `bench question ${t}: ${'x'.repeat(400)}`, id: asked } })
			let last = asked
			for (let k = 0; k < 3; k++) {
				last = sdk.generateMessageId()
				await log.append(lease, { type: 'message', turnId, messageId: last, role: 'assistant', content: { role: 'assistant', content: `bench answer ${t}.${k}: ${'y'.repeat(1500)}`, id: last } })
			}
			await log.append(lease, {
				type: 'turn_completed',
				turnId,
				result: 'ok',
				stopReason: 'end_turn',
				settlement: { status: 'completed', iterations: 1, usage, cost, durationMs: 1, resultMessageId: last, resultSource: 'model', abandonedTaskIds: [], abandonedJobIds: [] },
			})
		}
	} finally {
		await log.release(lease)
	}
}

/** One `namzu exec --resume <id> hello`, spawn to the first model request arriving at the fake server. */
async function resumeRun(model, home, project, sessionId) {
	const env = benchEnv(home, { modelUrl: model.url })
	const before = model.log.length
	const t0 = Date.now()
	const proc = spawn(process.execPath, [opts.build, 'exec', '--resume', sessionId, 'hello again'], {
		cwd: project,
		env,
		stdio: ['ignore', 'ignore', 'ignore'],
	})
	const exited = new Promise((ok) => proc.on('exit', ok))
	await until(() => model.log.length > before, 'the resumed request')
	const entry = model.log[before]
	const cpuMs = cpuMsOfPid(proc.pid)
	await exited
	// The first request of a resumed conversation is the history-search resolver, which sees only a
	// bounded part of the history, so "carried" means: some request of this run quoted the grown
	// session. A resume that silently opened a fresh conversation would quote none of it.
	const carriedHistory = model.log.slice(before).some((e) => e.body.includes('bench question'))
	return { wallMs: entry.at - t0, cpuMs, carriedHistory }
}

function med(xs) {
	return summarize(xs)?.median ?? null
}

async function runCheck() {
	const budgets = JSON.parse(readFileSync(BUDGETS_FILE, 'utf8'))
	const limitOf = (name, key) => {
		const ref = budgets.metrics[name]?.[key]
		if (typeof ref !== 'number') throw new Error(`${BUDGETS_FILE} has no ${key} for "${name}"`)
		return Math.max(ref * budgets.ciScale * budgets.headroom, budgets.minLimitMs ?? 0)
	}
	process.stderr.write(`build ${opts.build}\nnode ${process.version} on ${process.platform}-${process.arch}, median of ${opts.runs}\n`)
	const measured = {}

	for (const flag of ['version', 'help']) {
		const { home, project } = freshHome(flag)
		const env = benchEnv(home)
		runMeasured([`--${flag}`], env, project)
		const runs = Array.from({ length: opts.runs }, () => runMeasured([`--${flag}`], env, project))
		measured[flag] = { wallMs: med(runs.map((r) => r.wallMs)), cpuMs: med(runs.map((r) => r.cpuMs)) }
	}

	for (const mode of ['pipe', 'null']) {
		await execRun(mode)
		const runs = []
		for (let i = 0; i < opts.runs; i++) runs.push(await execRun(mode))
		measured[`exec-request-stdin-${mode}`] = { wallMs: med(runs.map((r) => r.requestMs)), cpuMs: med(runs.map((r) => r.cpuMs)) }
	}

	await tuiRun({})
	const tui = []
	for (let i = 0; i < opts.runs; i++) tui.push(await tuiRun({}))
	measured['tui-ready'] = { wallMs: med(tui.map((r) => r.ready)), cpuMs: med(tui.map((r) => r.readyCpu)) }

	// Resume: bootstrap one conversation through the real CLI so the project, tenant and index
	// exist exactly as a person's would, then grow its log and open it repeatedly.
	const model = await startFakeModel()
	let resumeInfo
	try {
		const { home, project } = freshHome('resume')
		// Asynchronous on purpose: the fake model server lives in this process, and a blocking
		// spawn would leave it unable to answer the very request being waited for.
		const boot = await new Promise((ok) => {
			const proc = spawn(process.execPath, [opts.build, 'exec', 'hello'], { cwd: project, env: benchEnv(home, { modelUrl: model.url }), stdio: 'ignore' })
			proc.on('exit', (status) => ok({ status }))
		})
		const projectsDir = join(home, '.namzu', 'projects')
		const logs = readdirSync(projectsDir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.jsonl'))
		if (logs.length !== 1) throw new Error(`expected the bootstrap run to leave one session log, found ${logs.length} (exit ${boot.status})`)
		const file = join(projectsDir, logs[0])
		const sessionId = basename(file, '.jsonl')
		await growSession(file, join(dirname(file), sessionId), sessionId)
		const bytes = statSync(file).size
		await resumeRun(model, home, project, sessionId)
		const runs = []
		for (let i = 0; i < opts.runs; i++) runs.push(await resumeRun(model, home, project, sessionId))
		measured['resume-request'] = { wallMs: med(runs.map((r) => r.wallMs)), cpuMs: med(runs.map((r) => r.cpuMs)) }
		resumeInfo = { turns: RESUME_TURNS, logBytes: bytes, carriedHistory: runs.every((r) => r.carriedHistory) }
	} finally {
		model.close()
	}

	const rows = []
	let failed = false
	for (const [name, m] of Object.entries(measured)) {
		for (const key of ['wallMs', 'cpuMs']) {
			const value = m[key]
			if (value === null) {
				rows.push(`${name.padEnd(28)} ${key.padEnd(7)} not measurable on ${process.platform}; skipped`)
				continue
			}
			const limit = limitOf(name, key)
			const over = value > limit
			if (over) failed = true
			rows.push(`${name.padEnd(28)} ${key.padEnd(7)} ${value.toFixed(1).padStart(8)} ms  budget ${limit.toFixed(1).padStart(8)} ms  ${over ? 'OVER' : 'ok'}`)
		}
	}
	if (!resumeInfo.carriedHistory) {
		failed = true
		rows.push('resume-request               the resumed request did not carry the session\'s history; the metric measured something else')
	}
	process.stderr.write(`${rows.join('\n')}\nresumed session: ${resumeInfo.turns} turns, ${(resumeInfo.logBytes / 1e6).toFixed(2)} MB of log\n`)
	const report = { measured, resume: resumeInfo, runs: opts.runs, node: process.version, platform: `${process.platform}-${process.arch}`, ciScale: budgets.ciScale, headroom: budgets.headroom }
	if (opts.out) writeFileSync(opts.out, `${JSON.stringify(report, null, 2)}\n`)
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
	if (!opts.work) rmSync(work, { recursive: true, force: true })
	if (failed) {
		process.stderr.write('startup budget exceeded (or the resume metric is invalid); see the rows marked OVER above\n')
		process.exitCode = 1
	}
}
