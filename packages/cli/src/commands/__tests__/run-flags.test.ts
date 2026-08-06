/**
 * `namzu run` accepts what `namzu run-stream` accepts.
 *
 * The two are the same headless one-shot and differ only in how they print, so
 * an option one takes and the other reads aloud to the model is a defect, not a
 * design. `run` joined every argument into the prompt, which is the exact shape
 * already fixed once in the streaming sibling — `--cwd` was documented there,
 * unparsed, and silently ran in the process's own directory.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import { EXIT_USAGE } from '../../exit-codes.js'
import { composePrompt, runCommand } from '../run.js'
import type { CommandContext } from '../types.js'

const seen: {
	prompt: string | null
	cwd: string | undefined
	provider: string | undefined
	model: string | undefined
} = { prompt: null, cwd: undefined, provider: undefined, model: undefined }

vi.mock('../../tui/agent.js', () => ({
	probeAgentSession: vi.fn(async () => ({
		preferences: { version: 2, provider: 'mock', subagents: { active: [] } },
		needsRepickReason: null,
		detected: [],
	})),
	createAgentSession: vi.fn(
		async (
			prefs: { provider?: string; model?: string },
			_detected: unknown,
			opts?: { cwd?: string },
		) => {
			seen.cwd = opts?.cwd
			seen.provider = prefs.provider
			seen.model = prefs.model
			return {
				hasProvider: true,
				providerSummary: 'mock',
				modelSummary: 'mock-model',
				toolNames: [],
				// Present because a real session always sets it — a stub missing a
				// field production always has is a fixture for a system that does
				// not ship.
				instructionFiles: [] as readonly string[],
				errorHint: null,
				send: (messages: Array<{ content: string }>) => {
					seen.prompt = messages[0]?.content ?? null
					return (async function* () {
						yield { kind: 'done', stopReason: 'end_turn' }
					})()
				},
			}
		},
	),
}))

function context(): { ctx: CommandContext; printed: string[]; errors: string[] } {
	const printed: string[] = []
	const errors: string[] = []
	const ctx = {
		formatter: {
			name: 'text' as const,
			print: (d: unknown) => printed.push(String((d as { text?: string })?.text ?? d)),
			info: () => {},
			error: (e: unknown) => errors.push(String((e as { message?: string })?.message ?? e)),
		},
		config: {},
	} as unknown as CommandContext
	return { ctx, printed, errors }
}

async function run(rawArgs: string[]): Promise<{ code: number; errors: string[] }> {
	seen.prompt = null
	seen.cwd = undefined
	seen.provider = undefined
	seen.model = undefined
	const { ctx, errors } = context()
	const code = (await runCommand.handler({ rawArgs, ctx } as never)) as number
	return { code, errors }
}

describe('namzu run reads its options instead of reciting them', () => {
	it('works in --cwd and keeps it out of the prompt', async () => {
		const elsewhere = mkdtempSync(join(tmpdir(), 'namzu-run-cwd-'))
		try {
			const { code } = await run(['--cwd', elsewhere, 'fix', 'the', 'test'])

			expect(code).toBe(0)
			expect(seen.cwd).toBe(elsewhere)
			// The whole point: the flag was previously the first two words the
			// model was asked to act on.
			expect(seen.prompt).toBe('fix the test')
		} finally {
			rmSync(elsewhere, { recursive: true, force: true })
		}
	})

	it('takes --provider and --model over the stored preference', async () => {
		const { code } = await run(['--provider', 'openai', '--model', 'some-model', 'hello'])

		expect(code).toBe(0)
		expect(seen.provider).toBe('openai')
		expect(seen.model).toBe('some-model')
		expect(seen.prompt).toBe('hello')
	})

	it('refuses an option it does not know, with a usage exit code', async () => {
		// A shell caller reads `$?`; saying "--temperature 0.5" to the model and
		// exiting 0 is the failure this replaces.
		const { code, errors } = await run(['--temperature', '0.5', 'hello'])

		expect(code).toBe(EXIT_USAGE)
		expect(errors.join('')).toContain('--temperature')
		expect(seen.prompt).toBeNull()
	})

	it('refuses a --cwd that is not there rather than running in this one', async () => {
		const { code, errors } = await run(['--cwd', join(tmpdir(), 'namzu-run-no-such'), 'hello'])

		expect(code).toBe(EXIT_USAGE)
		expect(errors.join('')).toContain('--cwd does not exist')
		expect(seen.prompt).toBeNull()
	})

	it('lets `--` carry a prompt that begins with a dash', async () => {
		const { code } = await run(['--', '--force', 'is', 'part', 'of', 'the', 'question'])

		expect(code).toBe(0)
		expect(seen.prompt).toBe('--force is part of the question')
	})

	it('accepts --yolo and does not put it in the prompt', async () => {
		// Headless turns never prompt for approval, so there is nothing to skip.
		// Accepting it silently is what keeps `namzu --yolo run …` working.
		const { code } = await run(['--yolo', 'hello'])

		expect(code).toBe(0)
		expect(seen.prompt).toBe('hello')
	})
})

describe('a pipe and a question are both the prompt', () => {
	// `cat notes.txt | namzu run "summarise this"` read the three words and
	// silently dropped the file: piped input was consulted only when there was
	// no argument prompt. The run succeeded and answered about nothing.
	it('keeps piped material alongside the question', () => {
		const prompt = composePrompt('summarise this', 'line one\nline two\n')

		expect(prompt).toContain('summarise this')
		expect(prompt).toContain('line one')
		expect(prompt).toContain('line two')
	})

	it('fences the piped material so it cannot read as part of the question', () => {
		// Without a boundary the last line of a long paste runs into the
		// instruction, and the model cannot tell the request from the material.
		const prompt = composePrompt('what is wrong here?', 'const x = 1')

		expect(prompt).toBe('what is wrong here?\n\n<stdin>\nconst x = 1\n</stdin>')
	})

	it('is just the pipe when no question was given', () => {
		expect(composePrompt('', 'do the thing')).toBe('do the thing')
	})

	it('is just the question when nothing was piped', () => {
		expect(composePrompt('do the thing', '')).toBe('do the thing')
		// No empty tag block either — a model shown `<stdin></stdin>` is being
		// told something was attached when nothing was.
		expect(composePrompt('do the thing', '   \n  ')).toBe('do the thing')
	})

	it('is empty when neither was given, so the caller can report it', () => {
		expect(composePrompt('', '')).toBe('')
	})
})

describe('the pipe reaches the model, not just the composer', () => {
	// composePrompt is pure and proves the shape. This proves the plumbing:
	// that piped bytes are actually READ when a prompt argument is present.
	// They were not — stdin was consulted only when the argument was absent —
	// and a unit test of the composer alone would pass with that defect intact.
	function withStdin(text: string | null, fn: () => Promise<void>): Promise<void> {
		const real = Object.getOwnPropertyDescriptor(process, 'stdin')
		const fake = text === null ? Readable.from([]) : Readable.from([Buffer.from(text)])
		Object.defineProperty(process, 'stdin', {
			configurable: true,
			get: () => Object.assign(fake, { isTTY: text === null }),
		})
		return fn().finally(() => {
			if (real) Object.defineProperty(process, 'stdin', real)
		})
	}

	it('sends the piped file alongside the question', async () => {
		await withStdin('the contents of notes.txt', async () => {
			const { code } = await run(['summarise this'])

			expect(code).toBe(0)
			expect(seen.prompt).toContain('summarise this')
			expect(seen.prompt).toContain('the contents of notes.txt')
		})
	})

	it('reads the pipe as the whole prompt for the `-` sentinel', async () => {
		await withStdin('the question is in here', async () => {
			const { code } = await run(['-'])

			expect(code).toBe(0)
			expect(seen.prompt).toBe('the question is in here')
		})
	})
})

describe('a flag that was never read is refused, not swallowed', () => {
	// `--instance` was parsed into a field nothing anywhere in the repo read.
	// A host passing it got the persona selection it asked for exactly never,
	// and was told exactly nothing — which is worse than an absent flag,
	// because an absent flag says so immediately.
	it('refuses --instance now that it means nothing', async () => {
		const { code, errors } = await run(['--instance', 'namzu-2', 'hello'])

		expect(code).toBe(EXIT_USAGE)
		expect(errors.join('')).toContain('--instance')
		expect(seen.prompt).toBeNull()
	})
})
