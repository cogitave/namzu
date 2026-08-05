import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { openSessions } from '../../integrations/sessions/store.js'
import { parseRunFlags } from '../run-flags.js'
import { historyCommand, runStreamCommand, skillsJSONCommand } from '../run-stream.js'
import type { CommandContext } from '../types.js'

// Mocked so the directory the store is opened at is observable. Nothing here
// touches a real `.namzu` store; `resolveConversation` returning null is the
// "no such session" path, which is what makes the handler terminate.
vi.mock('../../integrations/sessions/store.js', () => ({
	openSessions: vi.fn(async () => ({}) as never),
	resolveConversation: vi.fn(async () => null),
	loadConversation: vi.fn(async () => []),
	appendMessages: vi.fn(async () => undefined),
}))

// Stubbed so a turn can be driven to completion without a credential, and so
// the directory the SESSION is created in is observable. What the session then
// does with that directory is asserted in `src/tui/__tests__/`.
const sessionOptions: Array<
	{ cwd?: string; rules?: unknown[]; permissionMode?: string } | undefined
> = []
vi.mock('../../tui/agent.js', () => ({
	probeAgentSession: vi.fn(async () => ({
		preferences: { version: 2, provider: 'anthropic', subagents: { active: [] } },
		needsRepickReason: null,
		detected: [],
	})),
	createAgentSession: vi.fn(
		async (
			_prefs: unknown,
			_detected: unknown,
			opts?: { cwd?: string; rules?: unknown[]; permissionMode?: string },
		) => {
			sessionOptions.push(opts)
			return {
				hasProvider: true,
				providerSummary: 'stub',
				modelSummary: 'stub',
				toolNames: [],
				errorHint: null,
				send: async function* () {},
			}
		},
	),
}))

/**
 * `run-stream` folded every argument it did not recognise into `rest`, and
 * `rest.join(' ')` is the PROMPT. `--cwd <path>` was in this command's own help
 * text and was never parsed, so the invocation our documentation teaches sent
 * the model a prompt beginning `--cwd /path …` while silently reading the
 * process's own directory.
 *
 * That is the same defect the sibling test in `passthrough-help.test.ts`
 * describes one level up, where `--help` became the prompt. The fix there was
 * to stop treating an option as content; the fix here is the same, plus
 * actually honouring the flag that was advertised.
 */

const ctx = { config: {} } as unknown as CommandContext

function capture(): { lines: string[]; restore: () => void } {
	const lines: string[] = []
	const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
		lines.push(String(chunk))
		return true
	})
	return { lines, restore: () => spy.mockRestore() }
}

beforeEach(() => {
	vi.mocked(openSessions).mockClear()
	sessionOptions.length = 0
})

afterEach(() => {
	vi.restoreAllMocks()
})

async function run(rawArgs: string[]): Promise<string[]> {
	const { lines, restore } = capture()
	try {
		await runStreamCommand.handler({ rawArgs, ctx } as never)
	} finally {
		restore()
	}
	return lines
}

describe('run-stream does not turn options into prompt text', () => {
	it('consumes --cwd instead of speaking it to the model', async () => {
		// With `--cwd` unparsed these two tokens WERE the prompt, so the run
		// proceeded. Reaching "no prompt" is what proves they were consumed.
		const lines = await run(['--cwd', '/tmp/somewhere'])

		expect(lines.join('')).toContain('no prompt')
	})

	it('refuses an option it does not know rather than saying it out loud', async () => {
		const lines = await run(['--temperature', '0.5', 'hello'])

		const joined = lines.join('')
		expect(joined).toContain('unknown option')
		expect(joined).toContain('--temperature')
	})

	it('refuses the flag form written with an equals sign', async () => {
		const lines = await run(['--nope=1', 'hello'])

		expect(lines.join('')).toContain('--nope')
	})

	it('still emits a terminal event when it refuses, so a host is not left hanging', async () => {
		// The NDJSON contract is that every run ends with `done`. A refusal that
		// skipped it would strand a host line-scanning stdout.
		const lines = await run(['--bogus', 'hello'])

		expect(lines.join('')).toContain('"kind":"done"')
	})
})

describe('run-stream works in the directory it was pointed at', () => {
	it('hands --cwd to the agent session, not only to the session store', async () => {
		// `--session` keeps the turn off stdin: without a session key the command
		// reads prior history from a pipe, and in a test runner that pipe never
		// closes.
		const elsewhere = mkdtempSync(join(tmpdir(), 'namzu-run-stream-'))
		try {
			await run(['--cwd', elsewhere, '--session', 'k', 'read', 'notes.txt'])
		} finally {
			rmSync(elsewhere, { recursive: true, force: true })
		}

		expect(sessionOptions[0]?.cwd).toBe(elsewhere)
	})

	it('refuses a --cwd that is not there instead of quietly using this one', async () => {
		// The silent fallback is the whole defect: the run proceeds, searches the
		// wrong tree, finds nothing, and reports that the file does not exist.
		const lines = await run(['--cwd', join(tmpdir(), 'namzu-no-such-dir'), 'hello'])

		const joined = lines.join('')
		expect(joined).toContain('--cwd does not exist')
		expect(joined).toContain('"kind":"done"')
		expect(sessionOptions).toEqual([])
	})
})

describe('the flag parser itself', () => {
	// Asserted here rather than through the handler: a valid prompt sends the
	// handler on to stdin and a provider probe, so the first version of this
	// case hung for five seconds and failed on a timeout rather than on the
	// behaviour. A pure function deserves to be called.
	it('lets `--` carry a prompt that begins with a dash', () => {
		const flags = parseRunFlags(['--', '--this-is-the-prompt'])

		expect(flags.rest).toEqual(['--this-is-the-prompt'])
		expect(flags.unknown).toEqual([])
	})

	it('stops interpreting options after `--`', () => {
		const flags = parseRunFlags(['--session', 'abc', '--', '--model', 'not-a-flag'])

		expect(flags.session).toBe('abc')
		expect(flags.model).toBeNull()
		expect(flags.rest).toEqual(['--model', 'not-a-flag'])
	})

	it('reads --cwd in both spellings', () => {
		expect(parseRunFlags(['--cwd', '/a', 'hi']).cwd).toBe('/a')
		expect(parseRunFlags(['--cwd=/b', 'hi']).cwd).toBe('/b')
		expect(parseRunFlags(['--cwd', '/a', 'hi']).rest).toEqual(['hi'])
	})

	it('leaves a lone dash alone, since that is not an option', () => {
		expect(parseRunFlags(['-', 'hi']).unknown).toEqual([])
		expect(parseRunFlags(['-', 'hi']).rest).toEqual(['-', 'hi'])
	})
})

describe('skills-json lists the directory it was pointed at', () => {
	// A host that lists skills for one checkout and then runs a turn in that
	// same checkout has to be told about the same skills both times. It was
	// not: this command read the process directory whatever `--cwd` said, so
	// it could offer a skill that `run-stream --cwd <there>` then could not
	// find, and hide one that was actually available.
	function skillIn(root: string, name: string): void {
		mkdirSync(join(root, 'skills', name), { recursive: true })
		writeFileSync(
			join(root, 'skills', name, 'SKILL.md'),
			`---\nname: ${name}\ndescription: only in this checkout\n---\n\nbody\n`,
		)
	}

	it('discovers the project skills under --cwd', async () => {
		const elsewhere = mkdtempSync(join(tmpdir(), 'namzu-skills-'))
		skillIn(elsewhere, 'only-over-there')
		const { lines, restore } = capture()
		try {
			await skillsJSONCommand.handler({ rawArgs: ['--cwd', elsewhere], ctx } as never)
		} finally {
			restore()
			rmSync(elsewhere, { recursive: true, force: true })
		}

		const names = (JSON.parse(lines.join('').trim()) as Array<{ name: string }>).map((s) => s.name)
		expect(names).toContain('only-over-there')
	})

	// There is deliberately no paired "and not from anywhere else" case: with
	// the flag ignored the command read `packages/cli`, which has no skills
	// directory, so a negative assertion passes with the defect still in place
	// and would only look like coverage.
})

describe('history reads the directory it was pointed at', () => {
	it('opens the store at --cwd, not at the process directory', async () => {
		// Parsing the flag is not the fix; USING it is. An assertion that the
		// command merely survives `--cwd` would pass with the wiring reverted —
		// `[]` is printed either way — which would leave the flag parsed and
		// still undriven, the exact shape being repaired here.
		//
		// A real directory, because `--cwd` is now resolved and checked before
		// the store is opened: a path that is not there cannot be told apart
		// from a session with no messages, so it never reaches the store.
		const elsewhere = mkdtempSync(join(tmpdir(), 'namzu-history-'))
		const { lines, restore } = capture()
		try {
			await historyCommand.handler({
				rawArgs: ['--cwd', elsewhere, '--session', 'some-key'],
				ctx,
			} as never)
		} finally {
			restore()
			rmSync(elsewhere, { recursive: true, force: true })
		}

		expect(openSessions).toHaveBeenCalledWith(elsewhere)
		expect(lines.join('').trim()).toBe('[]')
	})

	it('resolves a relative --cwd against the process directory', async () => {
		// A host that passes `.` or `../sibling` gets the directory it meant,
		// and the agent downstream gets an absolute path it cannot misread.
		const { restore } = capture()
		try {
			await historyCommand.handler({ rawArgs: ['--cwd', '.', '--session', 'k'], ctx } as never)
		} finally {
			restore()
		}

		expect(openSessions).toHaveBeenCalledWith(resolve(process.cwd(), '.'))
	})

	it('falls back to the process directory when --cwd is absent', async () => {
		const { restore } = capture()
		try {
			await historyCommand.handler({ rawArgs: ['--session', 'some-key'], ctx } as never)
		} finally {
			restore()
		}

		expect(openSessions).toHaveBeenCalledWith(process.cwd())
	})
})

describe('run-stream honours the permission surface, not just parses it', () => {
	// It accepted `--permission-mode` and never used it, and it never compiled
	// the `[permissions]` table at all — so an operator who wrote rules, or who
	// typed `--permission-mode strict` precisely because they did not trust the
	// run, got an unrestricted one that looked like it had obeyed. A safety
	// control that parses and does nothing is worse than one that is missing,
	// because the absence is visible and the silence is not.
	const withConfig = {
		config: { permissions: { bash: 'deny' } },
	} as unknown as CommandContext

	async function runWith(rawArgs: string[], context = withConfig): Promise<string[]> {
		const { lines, restore } = capture()
		try {
			await runStreamCommand.handler({ rawArgs, ctx: context } as never)
		} finally {
			restore()
		}
		return lines
	}

	it('compiles the operator table into the session', async () => {
		await runWith(['--session', 'k', 'hello'])

		expect(sessionOptions[0]?.rules).toEqual([{ type: 'deny_by_name', toolNames: ['bash'] }])
	})

	it('passes --permission-mode through instead of ignoring it', async () => {
		await runWith(['--session', 'k', '--permission-mode', 'strict', 'hello'])

		expect(sessionOptions[0]?.permissionMode).toBe('strict')
	})

	it('refuses a mode it does not know rather than running unrestricted', async () => {
		const lines = await runWith(['--session', 'k', '--permission-mode', 'yolo', 'hello'])

		expect(lines.join('')).toContain('--permission-mode must be one of')
		expect(sessionOptions).toEqual([])
	})

	it('defaults to auto when nothing was asked for, and says so by acting on it', async () => {
		await runWith(['--session', 'k', 'hello'])

		expect(sessionOptions[0]?.permissionMode).toBe('auto')
	})

	it('reports an unreadable rule in band, where a host can see it', async () => {
		const bad = {
			config: { permissions: { bash: { 'git push*': 'maybe' } } },
		} as unknown as CommandContext

		const lines = await runWith(['--session', 'k', 'hello'], bad)

		// Parsed, not substring-matched: the line is JSON, so the quotes around
		// the pattern are escaped in the raw text and a naive contains() would
		// pass or fail for reasons unrelated to what the host actually reads.
		const messages = lines
			.map((l) => JSON.parse(l) as { message?: string })
			.map((e) => e.message ?? '')
		expect(messages.some((m) => m.includes('permissions.bash."git push*"'))).toBe(true)
	})
})
