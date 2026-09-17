import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { REMOTE_EXECUTION_PROTOCOL_VERSION } from '../../remote-execution-controller.js'
import { buildDockerBackend, redactDockerArgv, resolveLayout } from '../index.js'

/**
 * The container backend is the only place that can mint the worker's
 * credential: it starts the container, it hands it the environment, and it
 * is the caller on every subsequent request. Those three have to agree, and
 * two of them are invisible from the backend's own source — the token
 * reaches the container through the docker CLI's environment, resolved from
 * a VALUELESS `--env NAMZU_SANDBOX_TOKEN`, and the client sends it as a
 * header on a request that never leaves the host.
 *
 * So this drives the whole create path against a `docker` shim, the way the
 * readiness suite does, and reads every end back: the argv the shim was
 * handed, the environment it was handed, and the headers the fetch stub
 * received.
 *
 * What it is guarding is a pairing. A token minted and never sent is a
 * sandbox whose every command fails with 401; a token sent and never minted
 * is the same; a token that is the SAME across instances is the static
 * shared secret this design exists to avoid; and a token in an argv — or in
 * the error a failed `docker run` throws — is a secret in a log line. All
 * four look like a working backend from the outside, which is why each is
 * asserted separately.
 */

const realFetch = globalThis.fetch
let workDir: string
let dockerShim: string
let dockerLog: string

/** One `docker run`: the argv it was handed, and what the CLI's env held. */
interface DockerRun {
	readonly argv: string[]
	/** `NAMZU_SANDBOX_TOKEN` as the docker CLI itself saw it. */
	readonly tokenInCliEnv: string
}

/**
 * Every `docker run` the backend performed.
 *
 * The shim logs its own environment alongside the argv, because the argv is
 * where the credential must NOT be: the test that would have caught the
 * first shape of this change is the one that checks both places.
 */
function dockerRuns(): DockerRun[] {
	const log = readFileSync(dockerLog, 'utf8')
	return log
		.split('RUN\n')
		.slice(1)
		.map((chunk) => chunk.split('\n').filter(Boolean))
		.map((lines) => {
			const env = lines.find((line) => line.startsWith('ENV '))
			return {
				argv: lines.filter((line) => !line.startsWith('ENV ')),
				tokenInCliEnv: (env ?? '').slice('ENV '.length),
			}
		})
}

/**
 * Every argv entry that names the credential. The valueless form is what
 * docker resolves out of the CLI's own environment; an entry with a value
 * is one somebody wrote into an argv.
 */
function renderedTokenEntries(argv: string[]): string[] {
	return argv.filter(
		(arg) => arg === 'NAMZU_SANDBOX_TOKEN' || arg.startsWith('NAMZU_SANDBOX_TOKEN='),
	)
}

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), 'namzu-docker-token-'))
	dockerShim = join(workDir, 'docker-shim')
	dockerLog = join(workDir, 'docker.log')
	writeFileSync(dockerLog, '')
	process.env.NAMZU_TEST_DOCKER_TOKEN_LOG = dockerLog
	writeFileSync(
		dockerShim,
		[
			'#!/bin/sh',
			'case "$1" in',
			'  network) printf "false\\n" ;;',
			// Log the argv AND the CLI's own environment before deciding how to
			// exit: the failure case below has to leave behind the credential it
			// held, or the assertion that the error does not carry it proves
			// nothing.
			'  run) { printf "RUN\\n"; for arg in "$@"; do printf "%s\\n" "$arg"; done; printf "ENV %s\\n" "${NAMZU_SANDBOX_TOKEN-}"; } >> "${NAMZU_TEST_DOCKER_TOKEN_LOG:?}"; if [ "${NAMZU_TEST_DOCKER_FAIL_RUN:-}" = "1" ]; then printf "docker: Error response from daemon: pull access denied for worker\\n" >&2; exit 125; fi; printf "container-id\\n" ;;',
			'  inspect) printf "65534\\n" ;;',
			'  rm) exit 0 ;;',
			'  *) exit 2 ;;',
			'esac',
		].join('\n'),
		{ mode: 0o755 },
	)
})

afterEach(() => {
	vi.restoreAllMocks()
	globalThis.fetch = realFetch
	process.env.NAMZU_TEST_DOCKER_TOKEN_LOG = undefined
	process.env.NAMZU_TEST_DOCKER_FAIL_RUN = undefined
	rmSync(workDir, { recursive: true, force: true })
})

function backend() {
	return buildDockerBackend({
		image: 'worker:test',
		layout: resolveLayout({
			outputs: { source: { type: 'hostDir', hostPath: workDir } },
		}),
		dockerBinary: dockerShim,
		network: 'bridge',
		readyTimeoutMs: 200,
		readyPollIntervalMs: 5,
	})
}

/** Every request the client made, with the headers it carried. */
function recordFetch() {
	const requests: Array<{ url: string; headers: Record<string, string> }> = []
	globalThis.fetch = vi.fn(async (input: Request | string | URL, init?: RequestInit) => {
		const url = String(input)
		requests.push({
			url,
			headers: Object.fromEntries(
				Object.entries((init?.headers ?? {}) as Record<string, string>).map(([key, value]) => [
					key.toLowerCase(),
					value,
				]),
			),
		})
		if (url.endsWith('/healthz')) {
			return new Response(
				JSON.stringify({ ok: true, protocolVersion: REMOTE_EXECUTION_PROTOCOL_VERSION }),
				{
					status: 200,
				},
			)
		}
		if (url.endsWith('/executions/reserve')) {
			return new Response(
				JSON.stringify({
					ok: true,
					protocolVersion: REMOTE_EXECUTION_PROTOCOL_VERSION,
					executionId: 'exec_00000000-0000-4000-8000-000000000001',
					leaseExpiresAt: Date.now() + 30_000,
				}),
				{ status: 201 },
			)
		}
		if (url.endsWith('/execute')) {
			return new Response('{"type":"result","exitCode":0,"timedOut":false,"durationMs":1}\n', {
				status: 200,
			})
		}
		throw new Error(`unexpected URL ${url}`)
	}) as typeof fetch
	return requests
}

describe('the worker credential the container backend mints', () => {
	it('reaches the container, reaches the client, and differs per instance', async () => {
		const requests = recordFetch()

		const first = await backend().create({ workingDirectory: workDir })
		await first.exec('true', [], undefined)
		await first.destroy()
		const firstRequests = [...requests]
		requests.length = 0

		const second = await backend().create({ workingDirectory: workDir })
		await second.exec('true', [], undefined)
		await second.destroy()

		const runs = dockerRuns()
		expect(runs).toHaveLength(2)
		const [firstToken, secondToken] = runs.map((run) => run.tokenInCliEnv)

		// 32 bytes of `randomBytes`, base64url — a secret, not an identifier.
		expect(firstToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
		expect(secondToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
		expect(firstToken).not.toBe(secondToken)

		// The value is NOT in the argv either run was handed. It cannot be:
		// `ps` on the host shows an argv to every user, so the credential
		// rides in the docker CLI's environment instead, which the valueless
		// `--env NAME` resolves. This is the assertion that would have caught
		// the first shape of this change.
		for (const run of runs) {
			expect(renderedTokenEntries(run.argv)).toEqual(['NAMZU_SANDBOX_TOKEN'])
			expect(run.argv.join(' ')).not.toContain(run.tokenInCliEnv)
		}

		// The token the container was started with is the one the client sends,
		// on the routes that act. `/healthz` is the exception and stays one:
		// readiness probing happens before the host has any business with the
		// worker and must not need the secret to answer.
		const acting = (made: typeof firstRequests) =>
			made.filter((request) => !request.url.endsWith('/healthz'))
		expect(acting(firstRequests).length).toBeGreaterThan(0)
		for (const request of acting(firstRequests)) {
			expect(request.headers.authorization, request.url).toBe(`Bearer ${firstToken}`)
		}
		for (const request of acting(requests)) {
			expect(request.headers.authorization, request.url).toBe(`Bearer ${secondToken}`)
		}
		for (const request of [...firstRequests, ...requests]) {
			if (!request.url.endsWith('/healthz')) continue
			expect(request.headers.authorization, request.url).toBeUndefined()
		}
	}, 30_000)

	it('keeps the minted token when the host’s own env sets the same variable', async () => {
		// Docker applies repeated `--env` flags in order and the last one wins.
		// The host's entry is rendered first and the valueless one — which
		// resolves to the value this backend put in the CLI's environment —
		// last, so the value the client sends is the value the container
		// holds. Render them the other way round and the container would
		// refuse every call the host itself makes, which reads as a broken
		// worker rather than as a duplicated setting.
		recordFetch()

		const sandbox = await backend().create({
			workingDirectory: workDir,
			env: { NAMZU_SANDBOX_TOKEN: 'a-host-supplied-value' },
		})
		await sandbox.destroy()

		const [run] = dockerRuns()
		expect(renderedTokenEntries(run?.argv ?? [])).toEqual([
			'NAMZU_SANDBOX_TOKEN=a-host-supplied-value',
			'NAMZU_SANDBOX_TOKEN',
		])
		expect(run?.tokenInCliEnv).toMatch(/^[A-Za-z0-9_-]{43}$/)
		expect(run?.tokenInCliEnv).not.toBe('a-host-supplied-value')
	}, 30_000)

	it('does not put the credential, or any other env value, in the error a failed run throws', async () => {
		// A non-zero `docker run` is routine — a missing image, a name
		// conflict, no runtime, a daemon hiccup — and its message is what a
		// host logs, ships to telemetry, or pastes into a bug report. The
		// argv carries every `--env` value, so that message is rendered with
		// the values redacted and the KEYS kept: the keys are what
		// distinguishes "the image could not be pulled" from "the
		// environment was rejected", and the values are secrets.
		process.env.NAMZU_TEST_DOCKER_FAIL_RUN = '1'
		recordFetch()

		let thrown = ''
		try {
			await backend().create({
				workingDirectory: workDir,
				env: { MY_APP_TOKEN: 'a-host-secret-value' },
			})
			expect.unreachable('create() should have thrown')
		} catch (error) {
			thrown = error instanceof Error ? error.message : String(error)
		}

		const [run] = dockerRuns()
		const minted = run?.tokenInCliEnv ?? ''
		// The premise: a real credential was in play for a real run.
		expect(minted).toMatch(/^[A-Za-z0-9_-]{43}$/)
		expect(thrown).toContain('exited 125')

		expect(thrown).not.toContain(minted)
		expect(thrown).not.toContain('a-host-secret-value')
		// Redacted, not deleted: the keys survive, so the message still says
		// what was passed.
		expect(thrown).toContain('NAMZU_SANDBOX_TOKEN')
		expect(thrown).toContain('MY_APP_TOKEN=<redacted>')
	}, 30_000)
})

/**
 * The redaction rule, at the spelling level.
 *
 * `redactDockerArgv` compared each element to the literal `'--env'`, so it
 * redacted the long separated form this builder emits and printed `-e K=V`,
 * `--env=K=V` and `-e=K=V` in full. Nothing in the tree writes those three
 * today, which is exactly why the suite above did not notice: it drives
 * `docker run` end to end, and the builder has one spelling. A future
 * caller with a different one would have put a credential in a log line
 * behind a docblock that promised it would not, so each spelling is pinned
 * here against the module's own export — the real function, not a copy of
 * its rule — and the end-to-end assertion above stays where it is.
 */
describe('redactDockerArgv', () => {
	const SECRET = 's3cr3t-value-must-not-appear'

	/** Every spelling docker accepts for the flag, and what it renders as. */
	const spellings: ReadonlyArray<readonly [string, readonly string[], readonly string[]]> = [
		[
			'`--env K=V`, the one this backend emits',
			['--env', `MY_APP_TOKEN=${SECRET}`],
			['--env', 'MY_APP_TOKEN=<redacted>'],
		],
		['`-e K=V`', ['-e', `MY_APP_TOKEN=${SECRET}`], ['-e', 'MY_APP_TOKEN=<redacted>']],
		['`--env=K=V`', [`--env=MY_APP_TOKEN=${SECRET}`], ['--env=MY_APP_TOKEN=<redacted>']],
		['`-e=K=V`', [`-e=MY_APP_TOKEN=${SECRET}`], ['-e=MY_APP_TOKEN=<redacted>']],
		['`-eK=V`', [`-eMY_APP_TOKEN=${SECRET}`], ['-eMY_APP_TOKEN=<redacted>']],
	]

	for (const [label, argv, expected] of spellings) {
		it(`redacts the value and keeps the key for ${label}`, () => {
			const rendered = redactDockerArgv(argv)

			expect(rendered.join(' ')).not.toContain(SECRET)
			expect(rendered).toEqual(expected)
		})
	}

	it('passes a valueless entry through, because the CLI fills it from its own environment', () => {
		// There is no value in the argv to redact — and redacting the name
		// would take away the one thing the message still has to say.
		expect(redactDockerArgv(['--env', 'NAMZU_SANDBOX_TOKEN'])).toEqual([
			'--env',
			'NAMZU_SANDBOX_TOKEN',
		])
		expect(redactDockerArgv(['--env=NAMZU_SANDBOX_TOKEN'])).toEqual(['--env=NAMZU_SANDBOX_TOKEN'])
	})

	it('leaves every other argument alone, including one that only looks like an option', () => {
		const argv = [
			'run',
			'--rm',
			'--env-file',
			'/tmp/env',
			'--entrypoint=/bin/sh',
			'-it',
			'worker:test',
			`MY_APP_TOKEN=${SECRET}`,
		]

		expect(redactDockerArgv(argv)).toEqual(argv)
	})

	it('does not fall over on a trailing flag with nothing after it', () => {
		expect(redactDockerArgv(['run', '--env'])).toEqual(['run', '--env'])
		expect(redactDockerArgv(['run', '-e'])).toEqual(['run', '-e'])
	})
})
