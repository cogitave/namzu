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
import { describe, expect, it, vi } from 'vitest'

import { EXIT_USAGE } from '../../exit-codes.js'
import { runCommand } from '../run.js'
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
				deferredToolCount: 0,
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
