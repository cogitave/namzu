import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'

import { AuthorizationGate, NOOP_LOGGER } from '@namzu/sdk'
import type { AuthorizationRule } from '@namzu/sdk'

import type { Preferences } from '../../integrations/providers/index.js'
import { fakeAgentSession } from '../../tui/__fixtures__/agent-session.js'
import type { AgentSession, SendOptions } from '../../tui/agent.js'
import { execCommand } from '../exec.js'
import type { CommandContext } from '../types.js'
import { execJsonCommand } from './exec-json-command.js'

/**
 * `exec` and `exec --json` read four per-run flags the same way: instructions
 * appended to the uncached tail, tool allow and deny lists, a spend limit, and
 * a fallback chain. The session is a stub; what is asserted is what the
 * command hands it.
 */

vi.mock('../../integrations/trust/store.js', () => ({
	isTrusted: () => true,
	trustDir: () => {},
}))

interface Captured {
	prefs: Preferences
	opts: {
		appendSystem?: string
		rules?: readonly AuthorizationRule[]
		limits?: { costLimitUsd?: number }
	}
}
const created: Captured[] = []
const sends: SendOptions[] = []
let script: unknown[] = []

vi.mock('../../tui/agent.js', () => ({
	probeAgentSession: vi.fn(async () => ({
		preferences: {
			version: 3,
			providers: [{ id: 'anthropic', model: 'big-model' }, { id: 'openai' }],
			subagents: { active: [] },
		},
		needsRepickReason: null,
		detected: [],
	})),
	createAgentSession: vi.fn(async (prefs: Preferences, _detected: unknown, opts: never) => {
		created.push({ prefs, opts })
		return fakeAgentSession({
			send: ((_messages: unknown, options: SendOptions) => {
				sends.push(options)
				return (async function* () {
					for (const event of script) yield event
				})()
			}) as AgentSession['send'],
		})
	}),
}))

function context(): { ctx: CommandContext; infos: string[]; errors: string[]; lines: string[] } {
	const infos: string[] = []
	const errors: string[] = []
	const lines: string[] = []
	const ctx = {
		formatter: {
			name: 'text' as const,
			print: (data: unknown) => lines.push(String((data as { text?: string })?.text ?? data)),
			info: (text: string) => infos.push(text),
			error: (e: unknown) => errors.push(String((e as { message?: string })?.message ?? e)),
		},
		config: {},
	} as unknown as CommandContext
	return { ctx, infos, errors, lines }
}

const FINISHED = [{ kind: 'done', stopReason: 'end_turn', text: 'ok' }]

async function runExec(args: string[], events: unknown[] = FINISHED) {
	script = events
	const run = context()
	const code = (await execCommand.handler({
		rawArgs: [...args, 'go'],
		ctx: run.ctx,
	} as never)) as number
	return { ...run, code }
}

/** What the compiled rules say about one call. */
function decide(rules: readonly AuthorizationRule[] | undefined, toolName: string, input: object) {
	const gate = new AuthorizationGate(
		{
			enabled: true,
			rules: [...(rules ?? [])],
			allowReadOnlyTools: false,
			denyDangerousPatterns: false,
			logDecisions: false,
		},
		NOOP_LOGGER,
	)
	return gate.evaluate({
		toolName,
		toolInput: input,
		toolDef: undefined,
		commandDialect: 'sh',
	} as never).decision
}

let dir: string
beforeEach(() => {
	created.length = 0
	sends.length = 0
	dir = mkdtempSync(join(tmpdir(), 'namzu-run-flags-'))
})
afterEach(() => removeTempDir(dir))

describe('exec --append-system-prompt', () => {
	it('hands the text to the session as standing instructions', async () => {
		const { code } = await runExec(['--append-system-prompt', 'Answer in French.'])
		expect(code).toBe(0)
		expect(created[0]?.opts.appendSystem).toBe('Answer in French.')
	})

	it('reads the text from a file when the value starts with @', async () => {
		const file = join(dir, 'rules.md')
		writeFileSync(file, '\nUse metric units.\n')
		await runExec(['--append-system-prompt', `@${file}`])
		expect(created[0]?.opts.appendSystem).toBe('Use metric units.')
	})

	it('refuses a file it cannot read, before any session is built', async () => {
		const { code, errors } = await runExec([
			'--append-system-prompt',
			`@${join(dir, 'missing.md')}`,
		])
		expect(code).toBe(64)
		expect(errors.join('\n')).toMatch(/--append-system-prompt could not read/)
		expect(created).toHaveLength(0)
	})

	it('adds nothing when the flag is absent', async () => {
		await runExec([])
		expect(created[0]?.opts).not.toHaveProperty('appendSystem')
	})
})

describe('exec --allowed-tools and --disallowed-tools', () => {
	it('allow an entry for this run and deny another', async () => {
		await runExec(['--allowed-tools', 'edit,bash(git status*)', '--disallowed-tools', 'bash(rm *)'])
		const rules = created[0]?.opts.rules
		expect(decide(rules, 'edit', { path: 'a.ts' })).toBe('allow')
		expect(decide(rules, 'bash', { command: 'git status' })).toBe('allow')
		expect(decide(rules, 'bash', { command: 'rm -rf build' })).toBe('deny')
	})

	it('a deny wins over an allow that names the same call', async () => {
		await runExec(['--allowed-tools', 'bash', '--disallowed-tools', 'bash(rm *)'])
		const rules = created[0]?.opts.rules
		expect(decide(rules, 'bash', { command: 'rm -rf build' })).toBe('deny')
		expect(decide(rules, 'bash', { command: 'ls' })).toBe('allow')
	})

	it('can be repeated, and one value can hold several entries', async () => {
		await runExec(['--allowed-tools', 'edit', '--allowed-tools', 'write read'])
		const rules = created[0]?.opts.rules
		for (const tool of ['edit', 'write', 'read']) expect(decide(rules, tool, {})).toBe('allow')
	})

	it('refuses an entry with an unclosed bracket instead of dropping it', async () => {
		const { code, errors } = await runExec(['--disallowed-tools', 'bash(rm *'])
		expect(code).toBe(64)
		expect(errors.join('\n')).toMatch(/--disallowed-tools/)
		expect(created).toHaveLength(0)
	})
})

describe('exec --fallback-model', () => {
	it('builds the chain from the primary and the models named, in order', async () => {
		await runExec(['--fallback-model', 'openai/small-model,backup-model'])
		expect(created[0]?.prefs.providers).toEqual([
			{ id: 'anthropic', model: 'big-model' },
			{ id: 'openai', model: 'small-model' },
			{ id: 'anthropic', model: 'backup-model' },
		])
	})

	it('replaces the saved fallbacks rather than adding to them', async () => {
		await runExec(['--fallback-model', 'anthropic/other'])
		expect(created[0]?.prefs.providers.map((member) => member.id)).toEqual([
			'anthropic',
			'anthropic',
		])
	})

	it('says which model took over, on stderr beside the other status lines', async () => {
		const { infos } = await runExec(
			['--fallback-model', 'openai'],
			[
				{
					kind: 'provider-fallback',
					text: 'Anthropic was too busy, so Namzu used OpenAI for the rest of that reply.',
				},
				...FINISHED,
			],
		)
		expect(infos).toContain(
			'Anthropic was too busy, so Namzu used OpenAI for the rest of that reply.',
		)
	})
})

describe('exec --max-budget-usd', () => {
	it('sets the spend limit the session enforces', async () => {
		await runExec(['--max-budget-usd', '0.5'])
		expect(created[0]?.opts.limits?.costLimitUsd).toBe(0.5)
	})

	it('refuses an amount that is not above zero', async () => {
		for (const value of ['0', 'lots']) {
			const { code, errors } = await runExec(['--max-budget-usd', value])
			expect(code).toBe(64)
			expect(errors.join('\n')).toContain('--max-budget-usd')
		}
		expect(created).toHaveLength(0)
	})

	it('exits 1 and says the limit was reached when the turn stops on it', async () => {
		const { code, errors } = await runExec(
			['--max-budget-usd', '0.5'],
			[
				{ kind: 'delta', text: 'half' },
				{ kind: 'done', stopReason: 'cost_limit' },
			],
		)
		expect(code).toBe(1)
		expect(errors.join('\n')).toMatch(/stopped at the spend limit of \$0\.50/)
		expect(errors.join('\n')).toMatch(/partial/)
	})
})

describe('exec --json reads the same four flags', () => {
	it('passes appended instructions, tool lists, the chain and the spend limit', async () => {
		script = FINISHED
		const run = context()
		const written: string[] = []
		const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
			written.push(String(chunk))
			return true
		})
		try {
			await execJsonCommand.handler({
				rawArgs: [
					'--append-system-prompt',
					'Be brief.',
					'--allowed-tools',
					'edit',
					'--fallback-model',
					'openai',
					'--max-budget-usd',
					'2',
					'go',
				],
				ctx: run.ctx,
			} as never)
		} finally {
			spy.mockRestore()
		}
		const options = created[0]?.opts
		expect(options?.appendSystem).toBe('Be brief.')
		expect(decide(options?.rules, 'edit', {})).toBe('allow')
		expect(options?.limits?.costLimitUsd).toBe(2)
		expect(created[0]?.prefs.providers.map((member) => member.id)).toEqual(['anthropic', 'openai'])
	})
})

describe('a value the flag parser refuses', () => {
	it('is a usage error in a sentence, not a crash', async () => {
		const run = context()
		const code = (await execCommand.handler({
			rawArgs: ['--max-budget-usd', 'lots', 'go'],
			ctx: run.ctx,
		} as never)) as number
		expect(code).toBe(64)
		expect(run.errors).toEqual([
			'--max-budget-usd takes a number of dollars greater than 0, got lots',
		])
		expect(created).toHaveLength(0)
	})

	it('is an error event and a done event in --json, which the caller can fix', async () => {
		const run = context()
		const written: string[] = []
		const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
			written.push(String(chunk))
			return true
		})
		let code: number
		try {
			code = (await execCommand.handler({
				rawArgs: ['--json', '--token-budget', 'lots', 'go'],
				ctx: run.ctx,
			} as never)) as number
		} finally {
			spy.mockRestore()
		}
		expect(code).toBe(0)
		expect(written.map((line) => JSON.parse(line))).toEqual([
			{ kind: 'error', message: expect.stringContaining('--token-budget') },
			{ kind: 'done' },
		])
	})
})
