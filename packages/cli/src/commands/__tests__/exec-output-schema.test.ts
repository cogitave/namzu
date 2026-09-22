/**
 * `namzu exec --output-schema <file>` binds the final answer to a JSON Schema.
 *
 * The flag used to exist only on the TUI, and was refused on every subcommand.
 * These are reachability tests: the loaded schema has to arrive in the session
 * options of both output modes, and a schema that cannot be loaded has to be
 * refused in each mode's own channel before any session is built.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it, vi } from 'vitest'

import { fakeAgentSession } from '../../tui/__fixtures__/agent-session.js'
import type { CommandContext } from '../types.js'

const createAgentSession = vi.fn(async () => sessionStub)

vi.mock('../../integrations/trust/store.js', () => ({
	isTrusted: () => true,
	trustDir: () => {},
}))

vi.mock('../../tui/agent.js', () => ({
	probeAgentSession: vi.fn(async () => ({
		preferences: { version: 3, providers: [{ id: 'mock' }], subagents: { active: [] } },
		detected: [],
	})),
	createAgentSession: (...args: unknown[]) =>
		(createAgentSession as unknown as (...a: unknown[]) => unknown)(...args),
}))

const sessionStub = fakeAgentSession({
	send: () =>
		(async function* () {
			yield { kind: 'done', text: '{"score":1}', stopReason: 'end_turn' } as never
		})(),
})

const { execCommand } = await import('../exec.js')
const { parseExecFlags } = await import('../exec-flags.js')
const { execJsonCommand } = await import('./exec-json-command.js')

const dir = mkdtempSync(join(tmpdir(), 'namzu-exec-schema-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const schemaPath = join(dir, 'schema.json')
writeFileSync(
	schemaPath,
	JSON.stringify({
		type: 'object',
		properties: { score: { type: 'number' } },
		required: ['score'],
		additionalProperties: false,
	}),
)

function context(): { ctx: CommandContext; printed: unknown[]; errors: string[] } {
	const printed: unknown[] = []
	const errors: string[] = []
	return {
		printed,
		errors,
		ctx: {
			formatter: {
				name: 'text' as const,
				print: (value: unknown) => printed.push(value),
				info: () => {},
				error: (e: { message: string }) => errors.push(e.message),
			},
			config: {},
		} as unknown as CommandContext,
	}
}

async function stdoutOf(work: () => Promise<number>): Promise<{ code: number; out: string }> {
	const lines: string[] = []
	const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
		lines.push(String(chunk))
		return true
	})
	try {
		return { code: await work(), out: lines.join('') }
	} finally {
		spy.mockRestore()
	}
}

describe('parsing', () => {
	it('reads --output-schema and --json out of the prompt', () => {
		const flags = parseExecFlags(['--json', '--output-schema', 'a.json', 'score', 'it'])
		expect(flags.json).toBe(true)
		expect(flags.outputSchema).toBe('a.json')
		expect(flags.rest).toEqual(['score', 'it'])
		expect(parseExecFlags(['--output-schema=b.json']).outputSchema).toBe('b.json')
	})
})

describe('the schema reaches the turn', () => {
	it('in the default mode, and the settled answer is printed', async () => {
		createAgentSession.mockClear()
		const { ctx, printed } = context()
		const code = await execCommand.handler({
			ctx,
			rawArgs: ['--output-schema', schemaPath, 'score it'],
		})
		expect(code).toBe(0)
		const options = (createAgentSession.mock.calls[0] as unknown[])[2] as {
			structuredOutput?: { mode: string; schema: { safeParse(v: unknown): { success: boolean } } }
		}
		expect(options.structuredOutput?.mode).toBe('native')
		expect(options.structuredOutput?.schema.safeParse({ score: 1 }).success).toBe(true)
		expect(options.structuredOutput?.schema.safeParse({ score: 'x' }).success).toBe(false)
		expect(printed).toEqual(['{"score":1}'])
	})

	it('with --json', async () => {
		createAgentSession.mockClear()
		const { ctx } = context()
		const { code, out } = await stdoutOf(() =>
			execJsonCommand.handler({
				ctx,
				rawArgs: [
					'--session',
					'40e7c721-43ca-4da8-a737-2e03c9347063',
					'--output-schema',
					schemaPath,
					'score it',
				],
			}),
		)
		expect(code).toBe(0)
		const options = (createAgentSession.mock.calls[0] as unknown[])[2] as {
			structuredOutput?: { mode: string }
		}
		expect(options.structuredOutput?.mode).toBe('native')
		expect(out).toContain('"text":"{\\"score\\":1}"')
	})

	it('is absent when the flag is not given', async () => {
		createAgentSession.mockClear()
		await execCommand.handler({ ctx: context().ctx, rawArgs: ['score it'] })
		const options = (createAgentSession.mock.calls[0] as unknown[])[2] as Record<string, unknown>
		expect('structuredOutput' in options).toBe(false)
	})
})

describe('a schema that cannot be loaded', () => {
	const missing = join(dir, 'missing.json')

	it('exits 64 in the default mode and builds no session', async () => {
		createAgentSession.mockClear()
		const { ctx, errors } = context()
		const code = await execCommand.handler({ ctx, rawArgs: ['--output-schema', missing, 'x'] })
		expect(code).toBe(64)
		expect(errors.join('\n')).toContain(`--output-schema ${missing}`)
		expect(createAgentSession).not.toHaveBeenCalled()
	})

	it('is an in-band error with --json, exit 0, because the caller can fix it', async () => {
		createAgentSession.mockClear()
		const { code, out } = await stdoutOf(() =>
			execJsonCommand.handler({ ctx: context().ctx, rawArgs: ['--output-schema', missing, 'x'] }),
		)
		expect(code).toBe(0)
		const events = out
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line) as { kind: string; message?: string })
		expect(events[0]?.kind).toBe('error')
		expect(events[0]?.message).toContain('--output-schema')
		expect(events.at(-1)?.kind).toBe('done')
		expect(createAgentSession).not.toHaveBeenCalled()
	})
})

describe('--session without --json', () => {
	it('is refused rather than ignored', async () => {
		createAgentSession.mockClear()
		const { ctx, errors } = context()
		const code = await execCommand.handler({ ctx, rawArgs: ['--session', 'k', 'x'] })
		expect(code).toBe(64)
		expect(errors.join('\n')).toContain('--continue or --resume')
		expect(createAgentSession).not.toHaveBeenCalled()
	})
})
