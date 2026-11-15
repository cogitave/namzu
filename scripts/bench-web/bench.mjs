// The web benchmark: drives the real TUI through a task and scores it. ON DEMAND ONLY, never in CI:
// it calls a real model through the recording proxy and costs money.
//
//   node scripts/bench-web/bench.mjs run    --root <worktree> --out <dir> --proxy-port <file> --rec <file> \
//        --label-file <file> --tasks A2,S --models haiku,deepseek --runs 3 [--from 1] [--prefix base] [--cap-usd 0.5]
//   node scripts/bench-web/bench.mjs report --results <results.jsonl> [--out report.md]
//
// Start the proxy first (see proxy.mjs; its key file comes from BENCH_KEY_FILE). Each run gets its own
// scratch HOME under --home-base (default $TMPDIR/bench-web-home), its own copy of the bench site on a
// free port, and a bubblewrap sandbox around the CLI. Nothing touches the real ~/.namzu.
//
// One JSON line per run goes to <out>/results.jsonl:
//   steps done out of N scored from the site's event log, the final answer's check, requests, tool calls,
//   side-channel calls (bash, sub-agent, memory), cost, input tokens per request, wall time.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MODELS, TASKS } from './tasks.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SITE = path.resolve(HERE, '../../packages/browser/test/fixtures/bench-site/server.mjs')

function args(argv) {
	const out = { _: [] }
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]
		if (a.startsWith('--')) out[a.slice(2)] = argv[++i]
		else out._.push(a)
	}
	return out
}

const median = (xs) => {
	if (xs.length === 0) return null
	const s = [...xs].sort((a, b) => a - b)
	const m = Math.floor(s.length / 2)
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

function freePort() {
	return new Promise((resolve, reject) => {
		const srv = net.createServer()
		srv.listen(0, '127.0.0.1', () => {
			const { port } = srv.address()
			srv.close(() => resolve(port))
		})
		srv.on('error', reject)
	})
}

async function get(url) {
	for (let i = 0; i < 20; i++) {
		try {
			return await (await fetch(url)).json()
		} catch {
			await new Promise((r) => setTimeout(r, 250))
		}
	}
	return null
}

/** Requests the proxy recorded for one label: the chat calls only. */
function requestsFor(rec, label) {
	const lines = fs.existsSync(rec) ? fs.readFileSync(rec, 'utf8').split('\n').filter(Boolean) : []
	return lines
		.map((l) => JSON.parse(l))
		.filter((r) => r.run === label && String(r.path).startsWith('/chat'))
}

const SIDE = /^(bash|shell|exec|run_command|agent|task|subagent|sub_agent|memory|memory_save|save_memory|remember)/i

function metricsOf(recs) {
	const calls = recs.flatMap((r) => r.response?.tool_calls ?? [])
	const browser = calls.filter((c) => /^browser/.test(c.name))
	const other = calls.filter((c) => !/^browser/.test(c.name))
	const t = recs.map((r) => Date.parse(r.time))
	return {
		requests: recs.length,
		browserCalls: browser.length,
		otherCalls: other.map((c) => c.name),
		sideChannel: other.filter((c) => SIDE.test(c.name)).length,
		costUsd: recs.reduce((a, r) => a + (r.usage?.cost ?? 0), 0),
		inputTokens: recs.reduce((a, r) => a + (r.usage?.prompt_tokens ?? 0), 0),
		inputPerRequest: median(recs.map((r) => r.usage?.prompt_tokens ?? 0)),
		wallS: recs.length ? (Math.max(...t) - Math.min(...t)) / 1000 + (recs.at(-1).ms ?? 0) / 1000 : 0,
		// Results the model saw that say a ref or origin was refused or an outcome was unknown.
		refusals: recs
			.flatMap((r) => r.request?.messages ?? [])
			.filter((m) => m.role === 'tool')
			.filter((m) => /not on the page any more|outcome is unknown|refused — the page is at/.test(JSON.stringify(m.content)))
			.length,
	}
}

async function runOne({ opts, task, modelKey, n }) {
	const def = TASKS[task]
	const model = MODELS[modelKey]
	const root = path.resolve(opts.root)
	const cli = path.join(root, 'packages/cli/dist/bin.js')
	const label = `${opts.prefix ?? 'run'}-${task.toLowerCase()}-${modelKey}-${n}`
	const out = path.join(path.resolve(opts.out), label)
	const home = path.join(opts['home-base'] ?? path.join(os.tmpdir(), 'bench-web-home'), label)
	const proj = `${out}-proj`
	fs.mkdirSync(out, { recursive: true })
	fs.mkdirSync(home, { recursive: true })
	fs.mkdirSync(proj, { recursive: true })
	fs.writeFileSync(path.join(proj, 'README.md'), '# scratch project\n')

	let site
	let sitePort = 0
	if (def.site) {
		sitePort = await freePort()
		site = spawn(process.execPath, [SITE, String(sitePort)], { stdio: 'ignore' })
		await get(`http://127.0.0.1:${sitePort}/state`)
	}
	const started = Date.now()
	try {
		const prompt = fs
			.readFileSync(path.join(HERE, 'tasks', def.file), 'utf8')
			.replaceAll('127.0.0.1:18765', `127.0.0.1:${sitePort}`)
		const promptFile = path.join(out, 'prompt.txt')
		fs.writeFileSync(promptFile, prompt)
		const port = fs.readFileSync(opts['proxy-port'], 'utf8').trim()
		const setup = spawnSync(process.execPath, [path.join(HERE, 'setup-home.mjs'), root, home, port, model], {
			env: { ...process.env, HOME: home },
			encoding: 'utf8',
		})
		if (setup.status !== 0) throw new Error(`setup-home failed: ${setup.stderr}`)
		fs.writeFileSync(opts['label-file'], label)
		const nodeBin = path.dirname(process.execPath)
		const driver = path.join(HERE, 'tui-driver.mjs')
		const bw = [
			'--ro-bind', '/', '/', '--tmpfs', '/tmp',
			'--bind', out, out, '--bind', home, home, '--bind', proj, proj,
			'--ro-bind', driver, driver, '--ro-bind', promptFile, promptFile,
			'--tmpfs', '/mnt', '--dev', '/dev', '--proc', '/proc', '--share-net', '--die-with-parent', '--unshare-pid',
			'--chdir', proj,
			'env', '-i', `HOME=${home}`, `PATH=${nodeBin}:/usr/local/bin:/usr/bin:/bin`, 'TERM=xterm-256color', `CLI=${cli}`,
			...(process.env.PLAYWRIGHT_BROWSERS_PATH ? [`PLAYWRIGHT_BROWSERS_PATH=${process.env.PLAYWRIGHT_BROWSERS_PATH}`] : []),
			`TURN_LIMIT_S=${opts['turn-limit-s'] ?? 420}`, 'IDLE_S=30', 'SNAP_S=15', 'CLI_ARGS=--account openrouter:proxy',
			process.execPath, driver, out, proj, promptFile,
		]
		await new Promise((resolve) => {
			const child = spawn('bwrap', bw, { stdio: ['ignore', fs.openSync(path.join(out, 'driver.log'), 'w'), 'inherit'] })
			child.on('exit', resolve)
		})
		const score = def.site ? await get(`http://127.0.0.1:${sitePort}/score?task=${task === 'A2' ? 'A2' : task}`) : null
		const state = def.site ? await get(`http://127.0.0.1:${sitePort}/state`) : null
		if (state) fs.writeFileSync(path.join(out, 'site-state.json'), JSON.stringify(state, null, 2))
		const finalScreen = fs.existsSync(path.join(out, 'final-screen.txt')) ? fs.readFileSync(path.join(out, 'final-screen.txt'), 'utf8') : ''
		// The model's answer is the last page of the screen; check it against the task's expected values.
		const tail = finalScreen.split('\n').slice(-60).join('\n')
		const answerOk = def.answer.every((re) => re.test(tail))
		const m = metricsOf(requestsFor(opts.rec, label))
		const steps = score ? { ...score.steps } : {}
		// A2's second step (read the Gold price) is only visible in the answer.
		if (task === 'A2') steps['read-price'] = /\$?\s?42\b/.test(tail)
		const done = Object.values(steps).filter(Boolean).length
		const total = Object.keys(steps).length
		const row = {
			label, task, model: modelKey, run: n, steps, done, total: total || null,
			// A site task whose score could not be read (the site died) is never complete.
			scoreLost: def.site && !score,
			complete: def.site ? Boolean(score) && done === total && answerOk : answerOk,
			answerOk,
			wrongCode: score?.extra?.wrongCode ?? 0,
			...m, wallClockS: (Date.now() - started) / 1000,
		}
		fs.appendFileSync(path.join(path.resolve(opts.out), 'results.jsonl'), `${JSON.stringify(row)}\n`)
		return row
	} finally {
		if (site?.pid) {
			try {
				process.kill(site.pid)
			} catch {}
		}
	}
}

function spentSoFar(rec) {
	if (!fs.existsSync(rec)) return 0
	let s = 0
	for (const l of fs.readFileSync(rec, 'utf8').split('\n')) {
		if (!l) continue
		try {
			s += JSON.parse(l).usage?.cost ?? 0
		} catch {}
	}
	return s
}

async function run(opts) {
	for (const k of ['root', 'out', 'proxy-port', 'rec', 'label-file']) if (!opts[k]) throw new Error(`--${k} is required`)
	const tasks = (opts.tasks ?? 'A2').split(',')
	const models = (opts.models ?? 'haiku,deepseek').split(',')
	const runs = Number(opts.runs ?? 3)
	const from = Number(opts.from ?? 1)
	const cap = Number(opts['cap-usd'] ?? 0.5)
	const startSpend = spentSoFar(opts.rec)
	for (const task of tasks) {
		if (!TASKS[task]) throw new Error(`unknown task ${task}`)
		for (const modelKey of models) {
			if (!MODELS[modelKey]) throw new Error(`unknown model ${modelKey}`)
			for (let n = from; n < from + runs; n++) {
				if (spentSoFar(opts.rec) - startSpend >= cap) {
					console.log(`cap of USD ${cap} reached for this set; stopping`)
					return
				}
				const r = await runOne({ opts, task, modelKey, n })
				console.log(`${r.label}\tdone ${r.done}/${r.total ?? '-'}\tanswer ${r.answerOk}\treq ${r.requests}\tside ${r.sideChannel}\t$${r.costUsd.toFixed(4)}\t${r.wallClockS.toFixed(0)}s`)
			}
		}
	}
}

function report(opts) {
	const rows = fs.readFileSync(opts.results, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
	const groups = new Map()
	for (const r of rows) {
		const k = `${r.task}\t${r.model}`
		if (!groups.has(k)) groups.set(k, [])
		groups.get(k).push(r)
	}
	const fmt = (xs, d = 0) => (xs.length === 0 ? '-' : `${median(xs).toFixed(d)} (${Math.min(...xs).toFixed(d)}-${Math.max(...xs).toFixed(d)})`)
	const lines = [
		'| Task | Model | Runs | Complete | Steps done (each run) | Requests med (range) | Cost USD med (range) | Input tokens/request med | Side-channel calls | Browser calls med |',
		'|---|---|---|---|---|---|---|---|---|---|',
	]
	for (const [k, rs] of groups) {
		const [task, model] = k.split('\t')
		lines.push(
			`| ${task} | ${model} | ${rs.length} | ${rs.filter((r) => r.complete).length}/${rs.length} | ${rs.map((r) => (r.total ? `${r.done}/${r.total}` : r.answerOk ? 'ok' : 'no')).join(', ')} | ${fmt(rs.map((r) => r.requests))} | ${fmt(rs.map((r) => r.costUsd), 4)} | ${median(rs.map((r) => r.inputPerRequest ?? 0))?.toFixed(0)} | ${rs.reduce((a, r) => a + r.sideChannel, 0)} | ${median(rs.map((r) => r.browserCalls))} |`,
		)
	}
	const text = `${lines.join('\n')}\n`
	if (opts.out) fs.writeFileSync(opts.out, text)
	else process.stdout.write(text)
}

const [cmd] = args(process.argv.slice(2))._
const opts = args(process.argv.slice(2))
if (cmd === 'run') await run(opts)
else if (cmd === 'report') report(opts)
else {
	console.error('usage: bench.mjs run|report (see the header of this file)')
	process.exit(2)
}
