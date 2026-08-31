import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify, stripVTControlCharacters } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const runner = fileURLToPath(new URL('../../../../scripts/run-sdk-tests.mjs', import.meta.url))
const probe = 'src/__fixtures__/sdk-test-working-directory-probe.test.ts'
const rootLine = /^\[namzu:sdk-test-root\] (.+)$/m

type RunnerResult = {
	readonly code: number
	readonly stdout: string
	readonly stderr: string
}

type SignalledRunnerResult = RunnerResult & {
	readonly elapsedMs: number
	readonly signal: NodeJS.Signals | null
}

async function run(args: readonly string[], environment = process.env): Promise<RunnerResult> {
	try {
		const { stdout, stderr } = await execFileAsync(process.execPath, [runner, ...args], {
			env: { ...environment, NAMZU_SDK_TEST_DEBUG_ROOT: '1' },
			timeout: 30_000,
			maxBuffer: 4 * 1024 * 1024,
		})
		return { code: 0, stdout, stderr }
	} catch (error) {
		const failure = error as Error & {
			code?: number | string
			killed?: boolean
			stdout?: string
			stderr?: string
		}
		if (typeof failure.code !== 'number' && !failure.killed) throw error
		return {
			code: typeof failure.code === 'number' ? failure.code : -1,
			stdout: failure.stdout ?? '',
			stderr: failure.stderr ?? '',
		}
	}
}

async function terminateHeldProbe(): Promise<SignalledRunnerResult> {
	const startedAt = Date.now()
	const child = spawn(process.execPath, [runner, 'unit', probe], {
		env: {
			...process.env,
			NAMZU_SDK_TEST_DEBUG_ROOT: '1',
			NAMZU_SDK_TEST_PROBE_HOLD: '1',
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	let stdout = ''
	let stderr = ''
	let terminationRequested = false
	child.stdout.setEncoding('utf8')
	child.stderr.setEncoding('utf8')
	child.stdout.on('data', (chunk: string) => {
		stdout += chunk
	})
	child.stderr.on('data', (chunk: string) => {
		stderr += chunk
		if (!terminationRequested && rootLine.test(stderr)) {
			terminationRequested = true
			child.kill('SIGTERM')
		}
	})

	return await new Promise<SignalledRunnerResult>((resolveResult, rejectResult) => {
		const timeout = setTimeout(() => {
			stderr += '\nTimed out waiting for the signalled SDK test runner.'
			child.kill('SIGKILL')
		}, 10_000)
		child.once('error', (error) => {
			clearTimeout(timeout)
			rejectResult(error)
		})
		// `close`, not `exit`: if forwarding regresses, the grandchild still owns
		// these pipes until its bounded hold ends. Cleanup is safe only afterwards.
		child.once('close', (code, signal) => {
			clearTimeout(timeout)
			resolveResult({ code: code ?? 0, elapsedMs: Date.now() - startedAt, signal, stdout, stderr })
		})
	})
}

function reportedRoot(result: RunnerResult): string {
	const match = result.stderr.match(rootLine)
	expect(match, result.stderr).not.toBeNull()
	return match?.[1] ?? ''
}

async function removeLeakedProbe(path: string): Promise<void> {
	if (!path || !existsSync(path)) return
	const [canonical, temporaryRoot] = await Promise.all([realpath(path), realpath(tmpdir())])
	if (dirname(canonical) !== temporaryRoot || !basename(canonical).startsWith('namzu-sdk-tests-')) {
		throw new Error(`Refusing to clean a probe path outside the SDK test boundary: ${canonical}`)
	}
	await rm(canonical, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
}

describe('SDK test working-directory owner', () => {
	it('waits for a real focused suite and removes its exact root after exit', async () => {
		const result = await run(['unit', '--passWithNoTests', '--', probe])
		const root = reportedRoot(result)
		try {
			expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0)
			// Hosted runners may force colour even though this child is captured.
			// The summary is evidence that the real focused suite ran; ANSI styling
			// is presentation and must not sit between the observer's words/numbers.
			expect(stripVTControlCharacters(result.stdout)).toMatch(/Test Files\s+1 passed \(1\)/)
			expect(existsSync(root)).toBe(false)
		} finally {
			await removeLeakedProbe(root)
		}
	}, 30_000)

	it('preserves a child failure and still removes its exact root', async () => {
		const result = await run(['unit', probe], {
			...process.env,
			NAMZU_SDK_TEST_PROBE_FAIL: '1',
		})
		const root = reportedRoot(result)
		try {
			expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(1)
			expect(result.stdout).toContain('deliberate SDK test-runner child failure')
			expect(existsSync(root)).toBe(false)
		} finally {
			await removeLeakedProbe(root)
		}
	}, 30_000)

	it('forwards termination, waits for child exit, cleans, and preserves the signal', async () => {
		const result = await terminateHeldProbe()
		const root = reportedRoot(result)
		try {
			expect(result.signal, `${result.stdout}\n${result.stderr}`).toBe('SIGTERM')
			expect(result.elapsedMs).toBeLessThan(2_000)
			expect(existsSync(root)).toBe(false)
		} finally {
			await removeLeakedProbe(root)
		}
	}, 30_000)

	it.skipIf(process.platform === 'win32')(
		'refuses a same-name replacement instead of losing the original root',
		async () => {
			const result = await run(['unit', probe], {
				...process.env,
				NAMZU_SDK_TEST_PROBE_REPLACE_ROOT: '1',
			})
			const root = reportedRoot(result)
			const movedRoot = `${root}-moved`
			try {
				expect(result.code).toBe(1)
				expect(result.stderr).toContain('identity changed')
				expect(existsSync(root)).toBe(true)
				expect(existsSync(movedRoot)).toBe(true)
			} finally {
				await removeLeakedProbe(root)
				await removeLeakedProbe(movedRoot)
			}
		},
		30_000,
	)

	for (const option of [
		'-c',
		'-r',
		'--browser.enabled',
		'--config=elsewhere.ts',
		'--pool=threads',
		'--root=/tmp',
	]) {
		it(`refuses isolation override ${option}`, async () => {
			const result = await run(['unit', option, probe])

			expect(result.code).toBe(2)
			expect(result.stderr).toContain(`${option.split('=', 1)[0]} is owned by the SDK test runner`)
			expect(result.stderr).not.toMatch(rootLine)
		})
	}
})
