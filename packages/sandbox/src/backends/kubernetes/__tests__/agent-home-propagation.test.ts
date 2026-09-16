/**
 * `k8s/entrypoint.sh` (see its own `__tests__/entrypoint.test.ts`) resolves
 * and exports a writable `HOME` before either of its two exec sites — but
 * exporting it is only half of #493's fix. The other half is `agent.cjs`'s
 * pre-existing `childEnvironment`, UNCHANGED by #493: it copies every
 * `process.env` key that is not `NAMZU_AGENT_*`/`NAMZU_SANDBOX_*` into every
 * `execute` and terminal child, and `HOME` is neither prefix. This file
 * proves that mechanism end to end against the real agent over a loopback
 * socket, standing in for entrypoint.sh's export with a plain
 * `process.env.HOME` assignment: a directory the process cannot write to
 * (standing in for `/root` after the privilege drop — #469) makes a child's
 * own `touch "$HOME/..."` fail exactly as it did before #493, and a
 * directory it CAN write to (standing in for whatever entrypoint.sh
 * resolved) lets both an `execute` child and a `terminal` child succeed and
 * report that same value back — the propagation path, unchanged by #493
 * and unchanged by this file.
 */

import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { type AddressInfo, type Server, type Socket, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AGENT_ENV_KEYS } from './fixtures/agent-env.js'
import { sendFramedRequest } from './fixtures/framed-agent-client.js'

const require_ = createRequire(import.meta.url)
const AGENT_PATH = '../../../../agent/agent.cjs'

// Neither trust-on-first-use variable is set anywhere in this file, so the
// agent authenticates nothing — the credential gate is `agent-bind-token
// .test.ts`'s concern, not this file's.
//
// `HOME` itself is not one of `AGENT_ENV_KEYS` (the agent's own knobs), but
// every `it()` below assigns `process.env.HOME` directly to stand in for
// entrypoint.sh's export, so it goes through the same save/clear/restore
// discipline as `agent-bind-token.test.ts` uses for `NAMZU_TEST_MARKER` —
// otherwise the real HOME this worker started with would be lost the moment
// `afterEach` removes `workDir`, which the last case pointed it at.
const MANAGED_ENV = [...AGENT_ENV_KEYS, 'HOME'] as const

let server: Server
let port: number
let workDir: string
let writableHome: string
let unwritableHome: string
let saved: Record<string, string | undefined>

function clearEnv(keys: readonly string[]): void {
	for (const key of keys) delete process.env[key]
}

async function startAgent(): Promise<void> {
	delete require_.cache[require_.resolve(AGENT_PATH)]
	const agent = require_(AGENT_PATH) as { handleConnection(socket: Socket): void }
	server = createServer((socket) => agent.handleConnection(socket))
	await new Promise<void>((resolve, reject) => {
		server.on('error', reject)
		server.listen(0, '127.0.0.1', () => resolve())
	})
	port = (server.address() as AddressInfo).port
}

beforeEach(async () => {
	saved = Object.fromEntries(MANAGED_ENV.map((key) => [key, process.env[key]]))
	clearEnv(MANAGED_ENV)

	workDir = realpathSync(mkdtempSync(join(tmpdir(), 'k8s-agent-home-')))
	process.env.NAMZU_SANDBOX_WORKSPACE = workDir

	writableHome = join(workDir, 'writable-home')
	mkdirSync(writableHome)

	// Owned by this process but with every write bit off — stands in for
	// `/root` after the privilege drop, the exact directory #469 verified
	// the agent uid cannot use. Meaningless once this process itself is
	// root (root ignores the write bit), so the case that relies on it is
	// skipped there rather than passing for the wrong reason.
	unwritableHome = join(workDir, 'unwritable-home')
	mkdirSync(unwritableHome)
	chmodSync(unwritableHome, 0o555)

	await startAgent()
})

afterEach(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()))
	clearEnv(MANAGED_ENV)
	for (const [key, value] of Object.entries(saved)) {
		if (value !== undefined) process.env[key] = value
	}
	clearEnv(['NAMZU_SANDBOX_WORKSPACE'])
	chmodSync(unwritableHome, 0o755)
	rmSync(workDir, { recursive: true, force: true })
})

/** One `execute` round trip, parsed into its streamed events. */
async function runExecute(command: string, args: string[]) {
	const exchange = await sendFramedRequest(port, { op: 'execute', body: { command, args } })
	const events = exchange.frames
		.filter((raw) => raw.length > 0)
		.map((raw) => JSON.parse(raw) as Record<string, unknown>)
	const stdout = events
		.filter((event) => event.type === 'stdout_delta')
		.map((event) => String(event.data))
		.join('')
	const result = events.find((event) => event.type === 'result')
	return { stdout, exitCode: result?.exitCode as number | undefined }
}

describe('HOME propagates from the agent process to every child it spawns', () => {
	// Meaningless as root: the kernel does not enforce the write bit this
	// case relies on for a process with CAP_DAC_OVERRIDE, so it would pass
	// for a reason unrelated to the propagation path this file exists to
	// prove.
	it.skipIf(process.getuid?.() === 0)(
		"an unwritable HOME makes an execute child's own touch fail, exactly as before #493",
		async () => {
			process.env.HOME = unwritableHome

			const { stdout, exitCode } = await runExecute('/bin/sh', [
				'-c',
				'touch "$HOME/.w" && echo ok',
			])

			expect(exitCode).not.toBe(0)
			expect(stdout).not.toContain('ok')
		},
	)

	it('a writable HOME lets an execute child touch a file there and print ok', async () => {
		process.env.HOME = writableHome

		const { stdout, exitCode } = await runExecute('/bin/sh', ['-c', 'touch "$HOME/.w" && echo ok'])

		expect(exitCode).toBe(0)
		expect(stdout).toContain('ok')
	})

	// The other spawning op, and the one that matters most for a model's
	// interactive session — Linux only, as `agent-bind-token.test.ts`'s own
	// terminal case is (the PTY is util-linux `script` plus `/proc`).
	it.skipIf(process.platform !== 'linux')(
		'a terminal child reports the same HOME its request was started under',
		async () => {
			process.env.HOME = writableHome

			const exchange = await sendFramedRequest(port, {
				op: 'terminal',
				body: {
					cols: 80,
					rows: 24,
					cwd: workDir,
					command: '/bin/sh',
					// `env` first so the output is forwarded early; the sleep
					// keeps the shell alive while the agent resolves the PTY
					// slave through /proc and answers `ready`.
					args: ['-c', 'env; sleep 1'],
				},
			})

			const events = exchange.frames
				.filter((raw) => raw.length > 0)
				.map((raw) => JSON.parse(raw) as Record<string, unknown>)
			const output = events
				.filter((event) => event.type === 'data')
				.map((event) => String(event.data))
				.join('')

			expect(events.some((event) => event.type === 'ready')).toBe(true)
			expect(output).toContain(`HOME=${writableHome}`)
		},
	)
})
