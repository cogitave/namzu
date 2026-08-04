import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { openSessions } from '../../integrations/sessions/store.js'
import { historyCommand, parseRunStreamFlags, runStreamCommand } from '../run-stream.js'
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

const ctx = {} as unknown as CommandContext

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

describe('the flag parser itself', () => {
	// Asserted here rather than through the handler: a valid prompt sends the
	// handler on to stdin and a provider probe, so the first version of this
	// case hung for five seconds and failed on a timeout rather than on the
	// behaviour. A pure function deserves to be called.
	it('lets `--` carry a prompt that begins with a dash', () => {
		const flags = parseRunStreamFlags(['--', '--this-is-the-prompt'])

		expect(flags.rest).toEqual(['--this-is-the-prompt'])
		expect(flags.unknown).toEqual([])
	})

	it('stops interpreting options after `--`', () => {
		const flags = parseRunStreamFlags(['--session', 'abc', '--', '--model', 'not-a-flag'])

		expect(flags.session).toBe('abc')
		expect(flags.model).toBeNull()
		expect(flags.rest).toEqual(['--model', 'not-a-flag'])
	})

	it('reads --cwd in both spellings', () => {
		expect(parseRunStreamFlags(['--cwd', '/a', 'hi']).cwd).toBe('/a')
		expect(parseRunStreamFlags(['--cwd=/b', 'hi']).cwd).toBe('/b')
		expect(parseRunStreamFlags(['--cwd', '/a', 'hi']).rest).toEqual(['hi'])
	})

	it('leaves a lone dash alone, since that is not an option', () => {
		expect(parseRunStreamFlags(['-', 'hi']).unknown).toEqual([])
		expect(parseRunStreamFlags(['-', 'hi']).rest).toEqual(['-', 'hi'])
	})
})

describe('history reads the directory it was pointed at', () => {
	it('opens the store at --cwd, not at the process directory', async () => {
		// Parsing the flag is not the fix; USING it is. An assertion that the
		// command merely survives `--cwd` would pass with the wiring reverted —
		// `[]` is printed either way — which would leave the flag parsed and
		// still undriven, the exact shape being repaired here.
		const { lines, restore } = capture()
		try {
			await historyCommand.handler({
				rawArgs: ['--cwd', '/tmp/elsewhere', '--session', 'some-key'],
				ctx,
			} as never)
		} finally {
			restore()
		}

		expect(openSessions).toHaveBeenCalledWith('/tmp/elsewhere')
		expect(lines.join('').trim()).toBe('[]')
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
