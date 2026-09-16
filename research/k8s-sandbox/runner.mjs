#!/usr/bin/env node
/**
 * W10 end-to-end driver: exercises the real @namzu/sandbox kubernetes
 * backend against a live agent-sandbox controller (kind cluster), in-cluster.
 *
 * Not part of the published package or the k8s/scripts/ acceptance suite —
 * a one-off research driver run as a Kubernetes Job. Prints one JSON object
 * as its last stdout line; everything before that is human-readable log.
 */

import { spawn } from 'node:child_process'
import { readFileSync, unlinkSync } from 'node:fs'

import { createSandboxProvider } from '@namzu/sandbox'

import { getResource } from './cluster-access.mjs'
// Relative filesystem import, deliberately bypassing @namzu/sandbox's own
// `exports` map (which only publishes "."): the same trick
// packages/sandbox/k8s/scripts/contract-suite.mjs uses against the
// monorepo's dist/ directly. This package's `files` field ships the whole
// `dist/` tree, so `dist/testing/sandbox-conformance.js` is present in the
// tarball even though nothing re-exports it from the package root.
import { defineSandboxConformance } from './node_modules/@namzu/sandbox/dist/testing/sandbox-conformance.js'

const NAMESPACE = process.env.NAMZU_E2E_NAMESPACE ?? 'namzu-e2e'
const TEMPLATE = process.env.NAMZU_E2E_TEMPLATE ?? 'namzu-task'
const POOL = process.env.NAMZU_E2E_POOL ?? 'namzu-task-pool'
const ACQUIRE_COUNT = Number(process.env.NAMZU_E2E_ACQUIRE_COUNT ?? 20)
const LEASE_TTL_SECONDS = Number(process.env.NAMZU_E2E_LEASE_TTL_SECONDS ?? 60)
const access = { inCluster: true }

const results = {
	startedAt: new Date().toISOString(),
	namespace: NAMESPACE,
	template: TEMPLATE,
	pool: POOL,
	acquireCount: ACQUIRE_COUNT,
	leaseTtlSeconds: LEASE_TTL_SECONDS,
	phases: {},
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function percentile(sortedMs, p) {
	const index = Math.min(sortedMs.length - 1, Math.ceil((p / 100) * sortedMs.length) - 1)
	return sortedMs[Math.max(0, index)]
}

function stringify(value) {
	try {
		return JSON.stringify(value)
	} catch {
		return String(value)
	}
}

function baseConfig(overrides = {}) {
	return {
		tier: 'microvm',
		service: 'kubernetes',
		namespace: NAMESPACE,
		access,
		sandboxTemplateName: TEMPLATE,
		warmPoolName: POOL,
		...overrides,
	}
}

async function podExists(name) {
	try {
		await getResource(access, `/api/v1/namespaces/${encodeURIComponent(NAMESPACE)}/pods/${encodeURIComponent(name)}`)
		return true
	} catch (err) {
		if (err instanceof Error && / -> 404$/.test(err.message)) return false
		throw err
	}
}

async function waitForWarmPool(timeoutMs = 120_000) {
	const path = `/apis/extensions.agents.x-k8s.io/v1beta1/namespaces/${encodeURIComponent(
		NAMESPACE,
	)}/sandboxwarmpools/${encodeURIComponent(POOL)}`
	const deadline = Date.now() + timeoutMs
	for (;;) {
		const pool = await getResource(access, path)
		const wanted = pool?.spec?.replicas ?? 1
		const ready = pool?.status?.readyReplicas ?? 0
		if (ready >= wanted) return { ready, wanted }
		if (Date.now() > deadline) {
			throw new Error(`SandboxWarmPool ${POOL} never reached ${wanted} readyReplicas (last observed ${ready})`)
		}
		await sleep(1000)
	}
}

async function phase(name, fn) {
	console.log(`\n=== phase: ${name} ===`)
	const startedAt = Date.now()
	try {
		const value = await fn()
		results.phases[name] = { ok: true, durationMs: Date.now() - startedAt, ...(value ?? {}) }
	} catch (err) {
		results.phases[name] = {
			ok: false,
			durationMs: Date.now() - startedAt,
			error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
		}
		console.error(`[phase:${name}] FAILED:`, err)
	}
	console.log(`=== phase: ${name} done in ${results.phases[name].durationMs}ms ok=${results.phases[name].ok} ===`)
}

// ---------------------------------------------------------------------------
// phase: wait for the warm pool
// ---------------------------------------------------------------------------
await phase('poolWarm', async () => {
	const { ready, wanted } = await waitForWarmPool()
	console.log(`warm pool ready: ${ready}/${wanted}`)
	return { ready, wanted }
})

// ---------------------------------------------------------------------------
// phase: acquire latency (>= 20 sequential acquires from the warm pool)
// ---------------------------------------------------------------------------
await phase('acquireLatency', async () => {
	const provider = createSandboxProvider({ backend: baseConfig() })
	const durationsMs = []
	for (let i = 0; i < ACQUIRE_COUNT; i++) {
		const startedAt = process.hrtime.bigint()
		const sandbox = await provider.create()
		const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000
		durationsMs.push(elapsedMs)
		await sandbox.destroy().catch(() => {})
		console.log(`  acquire ${i + 1}/${ACQUIRE_COUNT}: ${elapsedMs.toFixed(1)}ms`)
	}
	const sorted = [...durationsMs].sort((a, b) => a - b)
	const p50Ms = percentile(sorted, 50)
	const p99Ms = percentile(sorted, 99)
	console.log(`acquire p50=${p50Ms.toFixed(1)}ms p99=${p99Ms.toFixed(1)}ms over ${ACQUIRE_COUNT} acquires`)
	return { durationsMs, p50Ms, p99Ms, under1sP50: p50Ms < 1000 }
})

// ---------------------------------------------------------------------------
// phase: the W9 sandbox conformance suite, against one acquired sandbox at a
// time (each `it()` gets a fresh warm-pool acquire — see
// sandbox-conformance.ts's own doc comment on why: no case may be affected
// by another's writes/aborts/destroys).
// ---------------------------------------------------------------------------
await phase('conformance', async () => {
	const provider = createSandboxProvider({ backend: baseConfig() })

	const tests = []
	const path = []
	const describe = (name, body) => {
		path.push(name)
		body()
		path.pop()
	}
	const it = (name, body) => tests.push({ name: [...path, name].join(' > '), body })
	const expect = (actual) => ({
		toBe(expected) {
			if (!Object.is(actual, expected)) throw new Error(`expected ${stringify(actual)} to be ${stringify(expected)}`)
		},
		toEqual(expected) {
			if (stringify(actual) !== stringify(expected)) {
				throw new Error(`expected ${stringify(actual)} to equal ${stringify(expected)}`)
			}
		},
		toBeGreaterThan(expected) {
			if (!(actual > expected)) throw new Error(`expected ${stringify(actual)} to be greater than ${stringify(expected)}`)
		},
		toMatch(expected) {
			if (typeof actual !== 'string' || !expected.test(actual)) {
				throw new Error(`expected ${stringify(actual)} to match ${expected}`)
			}
		},
	})

	defineSandboxConformance({
		describe,
		it,
		expect,
		label: 'kubernetes (kind e2e)',
		makeSandbox: async () => ({ sandbox: await provider.create() }),
	})

	let passed = 0
	let failed = 0
	const cases = []
	for (const test of tests) {
		try {
			await test.body()
			cases.push({ name: test.name, passed: true })
			passed++
			console.log(`  [PASS] ${test.name}`)
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err)
			cases.push({ name: test.name, passed: false, detail })
			failed++
			console.log(`  [FAIL] ${test.name} — ${detail}`)
		}
	}
	return { total: tests.length, passed, failed, cases }
})

// ---------------------------------------------------------------------------
// phase: exec / writeFile / readFile / terminal / tcp against one sandbox
// ---------------------------------------------------------------------------
await phase('operations', async () => {
	const provider = createSandboxProvider({ backend: baseConfig() })
	const sandbox = await provider.create()
	const out = { sandboxId: sandbox.id }
	try {
		const execResult = await sandbox.exec('/bin/sh', ['-c', 'echo namzu-e2e-exec-ok'])
		out.exec = { exitCode: execResult.exitCode, stdout: execResult.stdout.trim() }
		console.log(`  exec: exit=${execResult.exitCode} stdout=${JSON.stringify(execResult.stdout.trim())}`)

		const marker = `namzu-e2e-${Date.now()}`
		await sandbox.writeFile('/workspace/e2e-marker.txt', marker)
		const readBack = (await sandbox.readFile('/workspace/e2e-marker.txt')).toString('utf8')
		out.fileRoundTrip = { wrote: marker, readBack, matches: readBack === marker }
		console.log(`  writeFile/readFile round trip: matches=${out.fileRoundTrip.matches}`)

		if (sandbox.openTerminal) {
			const terminal = await sandbox.openTerminal({
				command: '/bin/sh',
				args: ['-c', 'echo namzu-e2e-terminal-hello; sleep 0.2'],
				size: { cols: 80, rows: 24 },
			})
			let data = ''
			const unsubscribe = terminal.onData((chunk) => {
				data += chunk
			})
			const exit = await terminal.exited
			unsubscribe()
			out.terminal = { exitCode: exit.exitCode, sawHello: data.includes('namzu-e2e-terminal-hello') }
			console.log(`  terminal: exit=${exit.exitCode} sawHello=${out.terminal.sawHello}`)
		} else {
			out.terminal = { skipped: true, reason: 'openTerminal not implemented by this sandbox' }
		}

		if (sandbox.openTcpConnection && sandbox.openTerminal) {
			// Start a real TCP echo listener INSIDE this sandbox, bound to ITS
			// OWN loopback — openTcpConnection only ever reaches a service the
			// guest agent itself can dial from inside the pod's network
			// namespace, so the target has to live there too (see
			// research/k8s-sandbox/kind-e2e-results.md for why the generic
			// conformance suite's own echo server, bound on the ORCHESTRATOR's
			// loopback, cannot satisfy this for a real remote backend).
			//
			// Started through openTerminal, NOT `exec` + shell `&` backgrounding:
			// a long-lived grandchild that never exits keeps the exec channel's
			// underlying pipe from ever reporting closed, which the transport
			// correctly refuses to treat as a completed command — see
			// research/k8s-sandbox/kind-e2e-results.md for the reproduction.
			// openTerminal is the SDK's actual primitive for a process the
			// caller does not wait on, and the sandbox owns and kills it.
			const port = 9101
			const serverScript = `const net=require("net");const s=net.createServer(sock=>{sock.once("data",d=>{sock.end(Buffer.concat([Buffer.from("echo:"),d]))})});s.listen(${port},"127.0.0.1",()=>console.log("listening"))`
			const echoTerminal = await sandbox.openTerminal({
				command: 'node',
				args: ['-e', serverScript],
				size: { cols: 80, rows: 24 },
			})
			try {
				const started = await new Promise((resolve, reject) => {
					const timer = setTimeout(() => reject(new Error('echo server did not report listening within 5s')), 5_000)
					const unsubscribe = echoTerminal.onData((chunk) => {
						if (chunk.includes('listening')) {
							clearTimeout(timer)
							unsubscribe()
							resolve(true)
						}
					})
				})

				const connection = await sandbox.openTcpConnection({ port })
				const received = await new Promise((resolve, reject) => {
					let buf = ''
					const timer = setTimeout(() => reject(new Error('tcp echo timed out')), 10_000)
					const unsubscribe = connection.onData((chunk) => {
						buf += Buffer.from(chunk).toString('utf8')
					})
					connection.closed.then(() => {
						clearTimeout(timer)
						unsubscribe()
						resolve(buf)
					}, reject)
					connection.write('namzu-e2e-tcp-hello')
				})
				out.tcp = { started, received, matches: received === 'echo:namzu-e2e-tcp-hello' }
				console.log(`  tcp: started=${out.tcp.started} matches=${out.tcp.matches} received=${JSON.stringify(received)}`)

				let refused = false
				try {
					await sandbox.openTcpConnection({ port: 9, host: '203.0.113.10' })
				} catch {
					refused = true
				}
				out.tcpNonLoopbackRefused = refused
				console.log(`  tcp non-loopback host refused: ${refused}`)
			} finally {
				echoTerminal.kill('SIGKILL')
			}
		} else {
			out.tcp = { skipped: true, reason: 'openTcpConnection or openTerminal not implemented by this sandbox' }
		}
	} finally {
		await sandbox.destroy().catch(() => {})
	}
	return out
})

// ---------------------------------------------------------------------------
// phase: lease proof — hold ~2x TTL with renewal running, then abandon the
// handle (a separate child process, killed without destroy()) and confirm
// the controller reaps the claim/sandbox after the TTL.
// ---------------------------------------------------------------------------
await phase('leaseProof', async () => {
	const statusFile = '/tmp/lease-holder-status.json'
	try {
		unlinkSync(statusFile)
	} catch {
		/* did not exist yet */
	}

	const holdMs = LEASE_TTL_SECONDS * 1000 * 2 + 15_000
	const child = spawn(process.execPath, ['./lease-holder.mjs', statusFile], {
		env: {
			...process.env,
			NAMZU_E2E_NAMESPACE: NAMESPACE,
			NAMZU_E2E_TEMPLATE: TEMPLATE,
			NAMZU_E2E_POOL: POOL,
			NAMZU_E2E_LEASE_TTL_SECONDS: String(LEASE_TTL_SECONDS),
			NAMZU_E2E_HOLD_MS: String(holdMs),
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	child.stdout.on('data', (chunk) => process.stdout.write(`  [holder] ${chunk}`))
	child.stderr.on('data', (chunk) => process.stderr.write(`  [holder:err] ${chunk}`))

	const readStatus = () => {
		try {
			return JSON.parse(readFileSync(statusFile, 'utf8'))
		} catch {
			return undefined
		}
	}

	// Wait for the holder to report it acquired a sandbox.
	const acquireDeadline = Date.now() + 60_000
	let sandboxId
	while (Date.now() < acquireDeadline) {
		const status = readStatus()
		if (status?.sandboxId) {
			sandboxId = status.sandboxId
			break
		}
		await sleep(500)
	}
	if (!sandboxId) throw new Error('lease holder never reported an acquired sandbox id')
	console.log(`  holder acquired ${sandboxId}, holding for ${holdMs}ms (TTL=${LEASE_TTL_SECONDS}s)`)

	const childExit = await new Promise((resolve) => {
		child.on('exit', (code, signal) => resolve({ code, signal }))
	})
	const finalStatus = readStatus() ?? {}
	const checks = finalStatus.checks ?? []
	const survivedHold = checks.length > 0 && checks.every((c) => c.exists && c.execOk)
	console.log(
		`  holder exited code=${childExit.code} signal=${childExit.signal ?? 'none'} checks=${checks.length} survivedHold=${survivedHold}`,
	)

	// The holder exited WITHOUT calling destroy() — this is the "dead host"
	// half of the proof. Poll for the controller reaping the claim/sandbox
	// once the last-stamped shutdownTime (at most TTL after the LAST
	// renewal, which happens at most half a jittered TTL before exit) passes.
	const reapTimeoutMs = (LEASE_TTL_SECONDS + 60) * 1000
	const reapDeadline = Date.now() + reapTimeoutMs
	let reaped = false
	while (Date.now() < reapDeadline) {
		if (!(await podExists(sandboxId))) {
			reaped = true
			break
		}
		await sleep(5000)
	}
	console.log(`  reaped after holder exit (within ${reapTimeoutMs}ms): ${reaped}`)

	return {
		sandboxId,
		holdMs,
		checks,
		survivedHold,
		childExitCode: childExit.code,
		reapTimeoutMs,
		reapedAfterHolderExit: reaped,
	}
})

// ---------------------------------------------------------------------------
// phase: pool-less (direct) create — no warmPoolName, so the backend copies
// the SandboxTemplate's own podTemplate into a Sandbox it posts directly.
// ---------------------------------------------------------------------------
await phase('poolLessCreate', async () => {
	const provider = createSandboxProvider({ backend: baseConfig({ warmPoolName: undefined }) })
	const startedAt = process.hrtime.bigint()
	const sandbox = await provider.create()
	const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000
	try {
		const execResult = await sandbox.exec('/bin/sh', ['-c', 'echo namzu-e2e-poolless-ok'])
		console.log(`  pool-less acquire: ${elapsedMs.toFixed(1)}ms, exec exit=${execResult.exitCode}`)
		return { acquireMs: elapsedMs, sandboxId: sandbox.id, exitCode: execResult.exitCode, stdout: execResult.stdout.trim() }
	} finally {
		await sandbox.destroy().catch(() => {})
	}
})

results.finishedAt = new Date().toISOString()
results.ok = Object.values(results.phases).every((p) => p.ok)

console.log('\n=== RESULTS_JSON_START ===')
console.log(JSON.stringify(results, null, 2))
console.log('=== RESULTS_JSON_END ===')

process.exitCode = results.ok ? 0 : 1
