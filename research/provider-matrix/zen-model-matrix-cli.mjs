#!/usr/bin/env node
/**
 * Model-matrix smoke through the REAL `namzu` CLI, for every model the Zen
 * driver catalogues (`@namzu/zen`'s `getZenModels('zen')` — the same table
 * `--provider zen` resolves against).
 *
 * For each catalogued model this spawns the actual built binary,
 *
 *   node packages/cli/dist/bin.js --format json run --trust \
 *     --provider zen --model <id> --effort low --token-budget <n> "<prompt>"
 *
 * inside an isolated `mkdtemp` `NAMZU_HOME` (never the operator's real
 * `~/.namzu`) and a fresh per-model working directory, with one tiny prompt
 * that requires a tool call on the default toolset. No provider is mocked;
 * every row is a real process exit, real stdout/stderr, and a real
 * filesystem check for the file the prompt asked for.
 *
 * Credential handling (read-only): this driver's own auth store lives in
 * `~/.local/share/opencode/auth.json` (or `$XDG_DATA_HOME/opencode/auth.json`),
 * read directly by `packages/cli/src/integrations/providers/harness-credentials.ts`
 * — NOT inside `~/.namzu`. If that file exists, it is copied byte-for-byte
 * (never opened for its contents beyond the copy, never written back to) into
 * this run's isolated `XDG_DATA_HOME`, and the child processes are pointed at
 * the copy via `XDG_DATA_HOME`/`NAMZU_HOME` env vars. `OPENCODE_API_KEY` /
 * `OPENCODE_ZEN_API_KEY`, if set in the parent shell, are forwarded as-is
 * (nothing is written back). On this machine neither the file nor either env
 * var was present at run time — recorded below, not silently assumed.
 *
 * Sequencing: models run one at a time with a short pause between them. A
 * model rejected with a rate-limit signal is retried exactly once after a
 * 60s backoff; if it is still rate-limited the row records `rate_limited`
 * and counts toward a 3-in-a-row early-stop (the remaining models are never
 * attempted and the run is marked partial).
 *
 * Usage:
 *   node research/provider-matrix/zen-model-matrix-cli.mjs [--out-dir DIR]
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..')
const CLI_BIN = join(REPO_ROOT, 'packages', 'cli', 'dist', 'bin.js')
const ZEN_MODELS_DIST = join(REPO_ROOT, 'packages', 'providers', 'zen', 'dist', 'models.js')

const PROMPT = 'Create a file named hello.txt containing the word hello, then say done'
const TOKEN_BUDGET = 20000
const PER_CALL_TIMEOUT_MS = 120_000
const PAUSE_BETWEEN_MODELS_MS = 1500
const RATE_LIMIT_BACKOFF_MS = 60_000
const CONSECUTIVE_RATE_LIMIT_STOP = 3

function log(...args) {
	console.error('[zen-matrix]', ...args)
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms))
}

/** Strip /mnt WSL-mount entries from PATH for the child env — matches repo guidance. */
function filteredPath(rawPath) {
	return rawPath
		.split(':')
		.filter((seg) => seg && !seg.startsWith('/mnt'))
		.join(':')
}

/**
 * Read-only reuse of the operator's own Zen credential, if any exists.
 *
 * Namzu's own `~/.namzu` never holds a Zen API key (see
 * `packages/cli/src/integrations/providers/credential-store.ts` — that file
 * only ever carries the Claude/Codex subscription pair). A Zen credential
 * comes from one of: `OPENCODE_API_KEY` / `OPENCODE_ZEN_API_KEY` in the
 * environment, or the co-installed `opencode` CLI's own
 * `$XDG_DATA_HOME/opencode/auth.json` (default `~/.local/share/opencode/auth.json`),
 * per `packages/cli/src/integrations/providers/harness-credentials.ts`. Both
 * are read here, never written to, and if the file exists it is copied into
 * this run's isolated XDG_DATA_HOME rather than pointing the run at the real
 * one.
 */
function prepareCredentialEnv(isolatedRoot) {
	const isolatedXdgDataHome = join(isolatedRoot, 'xdg-data-home')
	mkdirSync(isolatedXdgDataHome, { recursive: true })

	const envKeysPresent = ['OPENCODE_API_KEY', 'OPENCODE_ZEN_API_KEY'].filter(
		(k) => typeof process.env[k] === 'string' && process.env[k].trim().length > 0,
	)

	const xdgConfigured = process.env.XDG_DATA_HOME?.trim()
	const sourceAuthPath = xdgConfigured
		? join(xdgConfigured, 'opencode', 'auth.json')
		: join(homedir(), '.local', 'share', 'opencode', 'auth.json')

	let copiedFrom = null
	if (existsSync(sourceAuthPath)) {
		const destDir = join(isolatedXdgDataHome, 'opencode')
		mkdirSync(destDir, { recursive: true })
		// Byte-for-byte copy; the source is never parsed here.
		writeFileSync(join(destDir, 'auth.json'), readFileSync(sourceAuthPath))
		copiedFrom = sourceAuthPath
	}

	return {
		isolatedXdgDataHome,
		envKeysPresent,
		sourceAuthPath,
		copiedFrom,
		hadAnyCredential: copiedFrom !== null || envKeysPresent.length > 0,
	}
}

/**
 * Extract every top-level, balanced `{...}` JSON object from free text,
 * tolerating both single-line NDJSON (`--log-format json` records, and the
 * JsonFormatter's `info()`/`error()` single-line writes) and the
 * JsonFormatter's pretty (`JSON.stringify(..., 2)`) multi-line `print()` /
 * `error()` payloads — both appear in the same stream. Brace-depth scanning
 * with string-awareness, not line splitting, is what makes that safe.
 */
function extractJsonObjects(text) {
	const out = []
	let depth = 0
	let start = -1
	let inString = false
	let escaped = false
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]
		if (inString) {
			if (escaped) escaped = false
			else if (ch === '\\') escaped = true
			else if (ch === '"') inString = false
			continue
		}
		if (ch === '"') {
			inString = true
			continue
		}
		if (ch === '{') {
			if (depth === 0) start = i
			depth++
		} else if (ch === '}') {
			if (depth > 0) {
				depth--
				if (depth === 0 && start >= 0) {
					const candidate = text.slice(start, i + 1)
					try {
						out.push(JSON.parse(candidate))
					} catch {
						// Not actually a standalone JSON object (e.g. braces inside a
						// non-JSON log line); skip it.
					}
					start = -1
				}
			}
		}
	}
	return out
}

function classifyFailure(stderrText, timedOut) {
	if (timedOut) return { outcome: 'timeout', errorClass: 'timeout' }
	const t = stderrText
	const rules = [
		[/No credential found for Zen/i, 'no_credential'],
		[/does not advertise this reasoning effort level/i, 'effort_unsupported'],
		[/does not advertise disabled reasoning/i, 'effort_unsupported'],
		[/\[provider\.rate_limit\]/i, 'rate_limited'],
		[/rate limiting this run/i, 'rate_limited'],
		[/\b429\b/, 'rate_limited'],
		[/\[provider\.permission\]/i, 'permission_error'],
		[/\[provider\.auth\]/i, 'auth_error'],
		[/rejected the credentials for this run/i, 'auth_error'],
		[/\[provider\.context_overflow\]/i, 'context_overflow'],
		[/\[provider\.model_not_found\]/i, 'model_not_found'],
		[/does not recognise the model/i, 'model_not_found'],
		[/\[provider\.content_filter\]/i, 'content_filter'],
		[/\[provider\.unavailable\]/i, 'server_error'],
		[/failing on its own side/i, 'server_error'],
		[/\[provider\.network\]/i, 'network_error'],
		[/could not be reached/i, 'network_error'],
		[/rejected the request as invalid/i, 'bad_request'],
	]
	for (const [re, cls] of rules) {
		if (re.test(t)) return { outcome: cls, errorClass: cls }
	}
	return { outcome: 'error', errorClass: 'unclassified' }
}

function firstErrorLine(jsonObjects, stderrText) {
	const errObj = jsonObjects.find((o) => o && o.level === 'error' && typeof o.message === 'string')
	if (errObj) return errObj.message.split('\n')[0]
	const line = stderrText
		.split('\n')
		.map((l) => l.trim())
		.find((l) => l.length > 0 && !/^\+\d+ms\s/.test(l))
	return line ?? ''
}

async function runOnce(model, env, attempt) {
	const workDir = mkdtempSync(join(tmpdir(), 'namzu-zen-matrix-work-'))
	const args = [
		'--format',
		'json',
		'run',
		'--trust',
		'--provider',
		'zen',
		'--model',
		model.id,
		'--effort',
		'low',
		'--token-budget',
		String(TOKEN_BUDGET),
		PROMPT,
	]

	const start = Date.now()
	let stdout = ''
	let stderr = ''
	let timedOut = false
	let exitCode = null

	await new Promise((resolveRun) => {
		const child = spawn(process.execPath, [CLI_BIN, ...args], {
			cwd: workDir,
			env,
			stdio: ['ignore', 'pipe', 'pipe'],
		})
		const timer = setTimeout(() => {
			timedOut = true
			child.kill('SIGKILL')
		}, PER_CALL_TIMEOUT_MS)
		child.stdout.on('data', (d) => {
			stdout += d.toString('utf8')
		})
		child.stderr.on('data', (d) => {
			stderr += d.toString('utf8')
		})
		child.on('close', (code) => {
			clearTimeout(timer)
			exitCode = code
			resolveRun()
		})
		child.on('error', (err) => {
			clearTimeout(timer)
			stderr += `\n[spawn error] ${err.message}`
			resolveRun()
		})
	})

	const latencyMs = Date.now() - start
	const helloPath = join(workDir, 'hello.txt')
	const fileExists = existsSync(helloPath)
	let fileContent = null
	if (fileExists) {
		try {
			fileContent = readFileSync(helloPath, 'utf8')
		} catch {
			fileContent = null
		}
	}

	const jsonObjects = extractJsonObjects(stderr)
	const toolStarted = jsonObjects.some(
		(o) => o && o.level === 'info' && typeof o.message === 'string' && o.message.startsWith('⏺ '),
	)
	const toolNames = jsonObjects
		.filter((o) => o && o.level === 'info' && typeof o.message === 'string' && o.message.startsWith('⏺ '))
		.map((o) => o.message.replace(/^⏺\s*/, '').split(/\s+/)[0])

	let stdoutParsed = null
	if (stdout.trim().length > 0) {
		try {
			stdoutParsed = JSON.parse(stdout.trim())
		} catch {
			stdoutParsed = null
		}
	}

	const succeeded = exitCode === 0 && stdoutParsed && typeof stdoutParsed.text === 'string'

	let outcome
	let errorClass
	let errorFirstLine = ''
	if (succeeded) {
		outcome = 'ok'
		errorClass = 'none'
	} else {
		const classified = classifyFailure(stderr, timedOut)
		outcome = classified.outcome
		errorClass = classified.errorClass
		errorFirstLine = firstErrorLine(jsonObjects, stderr)
	}

	const tokens = succeeded ? (stdoutParsed.usage?.totalTokens ?? null) : null
	const toolCallOk = succeeded && toolStarted && fileExists && /hello/i.test(fileContent ?? '')

	rmSync(workDir, { recursive: true, force: true })

	return {
		model: model.id,
		attempt,
		outcome,
		errorClass,
		exitCode,
		timedOut,
		latencyMs,
		tokens,
		toolStarted,
		toolNames,
		fileExists,
		fileContent,
		toolCallOk,
		answerText: succeeded ? stdoutParsed.text : null,
		errorFirstLine,
		stderrBytes: stderr.length,
		stdoutBytes: stdout.length,
	}
}

async function main() {
	log('repo root:', REPO_ROOT)
	if (!existsSync(CLI_BIN)) {
		throw new Error(`CLI binary not found at ${CLI_BIN} — build the workspace first, do not rebuild mid-run.`)
	}
	if (!existsSync(ZEN_MODELS_DIST)) {
		throw new Error(`Zen models module not found at ${ZEN_MODELS_DIST}.`)
	}

	const { getZenModels } = await import(`file://${ZEN_MODELS_DIST}`)
	const allModels = getZenModels('zen')
	log(`catalogue has ${allModels.length} zen-service models`)

	const mustHave = ['big-pickle', 'muse-spark-1.3-contributor-free']
	for (const id of mustHave) {
		if (!allModels.some((m) => m.id === id)) {
			throw new Error(`Expected catalogued model "${id}" is missing from getZenModels('zen').`)
		}
	}

	// Test-only knobs, never used for the committed full-matrix results:
	// `--limit N` restricts the run to the first N catalogued models;
	// `--only id1,id2,...` restricts it to exactly those model ids.
	const limitArgIndex = process.argv.indexOf('--limit')
	const limit = limitArgIndex >= 0 ? Number(process.argv[limitArgIndex + 1]) : undefined
	const onlyArgIndex = process.argv.indexOf('--only')
	const only = onlyArgIndex >= 0 ? process.argv[onlyArgIndex + 1].split(',') : undefined
	let models = allModels
	if (only) models = allModels.filter((m) => only.includes(m.id))
	else if (limit && Number.isFinite(limit) && limit > 0) models = allModels.slice(0, limit)

	const runRoot = mkdtempSync(join(tmpdir(), 'namzu-zen-matrix-run-'))
	const namzuHome = join(runRoot, 'namzu-home')
	mkdirSync(namzuHome, { recursive: true })
	const credentialInfo = prepareCredentialEnv(runRoot)
	log('credential probe:', JSON.stringify(credentialInfo))

	const childEnv = {
		...process.env,
		PATH: filteredPath(process.env.PATH ?? ''),
		NAMZU_HOME: namzuHome,
		XDG_DATA_HOME: credentialInfo.isolatedXdgDataHome,
	}

	const rows = []
	let consecutiveRateLimited = 0
	let stoppedEarly = false
	let stopReason = null

	for (let i = 0; i < models.length; i++) {
		const model = models[i]
		log(`[${i + 1}/${models.length}] ${model.id} — starting`)
		let result = await runOnce(model, childEnv, 1)

		if (result.outcome === 'rate_limited') {
			log(`  rate limited, backing off ${RATE_LIMIT_BACKOFF_MS}ms then retrying once`)
			await sleep(RATE_LIMIT_BACKOFF_MS)
			result = await runOnce(model, childEnv, 2)
		}

		log(
			`  -> outcome=${result.outcome} exit=${result.exitCode} latency=${result.latencyMs}ms ` +
				`tool=${result.toolStarted} file=${result.fileExists} tokens=${result.tokens ?? 'n/a'}`,
		)

		rows.push({
			model: model.id,
			name: model.name,
			protocol: model.protocol,
			supportsAnonymousAccess: model.supportsAnonymousAccess === true,
			effortLevels: model.effortLevels ?? [],
			...result,
		})

		if (result.outcome === 'rate_limited') {
			consecutiveRateLimited += 1
		} else {
			consecutiveRateLimited = 0
		}

		if (consecutiveRateLimited >= CONSECUTIVE_RATE_LIMIT_STOP) {
			stoppedEarly = true
			stopReason = `${CONSECUTIVE_RATE_LIMIT_STOP} consecutive models rate-limited (last: ${model.id})`
			log(`STOPPING EARLY: ${stopReason}`)
			break
		}

		if (i < models.length - 1) await sleep(PAUSE_BETWEEN_MODELS_MS)
	}

	rmSync(runRoot, { recursive: true, force: true })

	const summary = {
		generatedAt: new Date().toISOString(),
		repoRoot: REPO_ROOT,
		cliBin: CLI_BIN,
		prompt: PROMPT,
		tokenBudget: TOKEN_BUDGET,
		perCallTimeoutMs: PER_CALL_TIMEOUT_MS,
		catalogueSize: allModels.length,
		modelsInThisRun: models.length,
		modelsAttempted: rows.length,
		status: stoppedEarly ? 'partial' : 'completed',
		stopReason,
		credential: {
			envKeysPresent: credentialInfo.envKeysPresent,
			sourceAuthPathChecked: credentialInfo.sourceAuthPath,
			copiedFrom: credentialInfo.copiedFrom,
			hadAnyCredential: credentialInfo.hadAnyCredential,
		},
		counts: rows.reduce((acc, r) => {
			acc[r.outcome] = (acc[r.outcome] ?? 0) + 1
			return acc
		}, {}),
		rows,
	}

	return summary
}

const outDirArgIndex = process.argv.indexOf('--out-dir')
const outDir = outDirArgIndex >= 0 ? resolve(process.argv[outDirArgIndex + 1]) : HERE

main()
	.then((summary) => {
		mkdirSync(outDir, { recursive: true })
		const jsonPath = join(outDir, 'zen-model-matrix-results.json')
		writeFileSync(jsonPath, `${JSON.stringify(summary, null, 2)}\n`)
		log(`wrote ${jsonPath}`)
		console.log(JSON.stringify({ status: summary.status, counts: summary.counts, modelsAttempted: summary.modelsAttempted }))
	})
	.catch((err) => {
		console.error('[zen-matrix] FATAL', err)
		process.exitCode = 1
	})
