/**
 * A command the operator defined works in `namzu run`, not only in the TUI.
 *
 * Reported from a real run of the published CLI: a project with
 * `.namzu/commands/ozet.md`, then `namzu run --trust "/ozet hedef.js"`. The
 * model received the literal string, could not make sense of it, and offered to
 * create a file called `ozet hedef.js`. Exit 0, confident output, nothing to do
 * with the command.
 *
 * The loader had exactly one call site — the TUI's `App.tsx` — and that was
 * never a decision. It was where the work happened to be done. A boundary
 * nobody chose, announced by nothing, is worse than either answer.
 *
 * ## What is asserted, and what is deliberately not
 *
 * The rule is NOT "a leading slash is a command". `namzu run "/usr/local/bin is
 * missing"` and `namzu run "/clear the cache in redis"` are ordinary prompts,
 * and breaking a working prompt to fix a broken one is not a trade worth
 * making. The rule is "the first token names a command this project declares" —
 * a file the operator wrote is an explicit declaration; a built-in's name is a
 * common English word nobody declared.
 *
 * So the pass-through cases are pinned as hard as the expansion is. Without
 * them this file would pass with an implementation that hijacks every slash.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runCommand } from '../commands/run.js'
import type { CommandContext } from '../commands/types.js'

// Trusted, because this file is about prompt expansion. The gate that refuses
// an untrusted folder has its own test.
vi.mock('../integrations/trust/store.js', () => ({
	isTrusted: () => true,
	trustDir: () => {},
}))

/** What the model was actually sent. */
const sent: string[] = []

vi.mock('../tui/agent.js', () => ({
	probeAgentSession: vi.fn(async () => ({
		preferences: { version: 2, provider: 'mock', subagents: { active: [] } },
		needsRepickReason: null,
		detected: [],
	})),
	createAgentSession: vi.fn(async () => {
		const { fakeAgentSession: make } = await import('../tui/__fixtures__/agent-session.js')
		return make({
			send: (messages) => {
				for (const m of messages) {
					if (typeof m.content === 'string') sent.push(m.content)
				}
				return (async function* () {
					yield { kind: 'delta', text: 'ok' }
					yield { kind: 'done', stopReason: 'end_turn' }
				})() as never
			},
		})
	}),
}))

let cwd: string

beforeEach(() => {
	sent.length = 0
	cwd = mkdtempSync(join(tmpdir(), 'namzu-headless-cmd-'))
})

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true })
})

function writeCommand(name: string, body: string): void {
	const dir = join(cwd, '.namzu', 'commands')
	mkdirSync(dir, { recursive: true })
	writeFileSync(join(dir, name), body)
}

function context(): { ctx: CommandContext; errors: string[] } {
	const errors: string[] = []
	const ctx = {
		formatter: {
			name: 'text' as const,
			print: () => {},
			info: () => {},
			error: (e: unknown) => errors.push(String((e as { message?: string })?.message ?? e)),
		},
		config: {},
	} as unknown as CommandContext
	return { ctx, errors }
}

async function run(prompt: string): Promise<{ code: number; errors: string[] }> {
	const { ctx, errors } = context()
	const code = (await runCommand.handler({
		rawArgs: ['--cwd', cwd, '--trust', prompt],
		ctx,
	} as never)) as number
	return { code, errors }
}

describe('a command file in a headless run', () => {
	it('is expanded, with its arguments substituted', () => {
		writeCommand('ozet.md', 'Summarise $ARGUMENTS in three bullets.')
		return run('/ozet hedef.js').then(({ code }) => {
			expect(code).toBe(0)
			// The reported defect: this used to be the literal `/ozet hedef.js`.
			expect(sent.join('\n')).toContain('Summarise hedef.js in three bullets.')
			expect(sent.join('\n')).not.toContain('/ozet')
		})
	})

	it('is refused, not silently sent, when its arguments cannot land', async () => {
		writeCommand('static.md', 'Summarise the diff.')
		const { code, errors } = await run('/static extra words')
		expect(code).not.toBe(0)
		expect(errors.join('\n')).toContain('takes no arguments')
		expect(sent).toHaveLength(0)
	})

	it('is refused when the file cannot be read', async () => {
		writeCommand('broken.md', '---\nunclosed frontmatter')
		const { code, errors } = await run('/broken')
		expect(code).not.toBe(0)
		expect(errors.join('\n')).toMatch(/unclosed/i)
		expect(sent).toHaveLength(0)
	})
})

describe('a leading slash that is not a command', () => {
	it('passes through as ordinary prose', async () => {
		// The case that makes "every slash is a command" wrong. Nothing declares
		// `/usr`, so this is a sentence.
		const { code } = await run('/usr/local/bin is missing, what should I check?')
		expect(code).toBe(0)
		expect(sent.join('\n')).toContain('/usr/local/bin is missing')
	})

	it('passes through even when it starts with a built-in name plus words', async () => {
		// `/clear the cache in redis` is a request, not an invocation of `/clear`.
		// A built-in's name is a common word that nobody declared, so matching on
		// it would break working prompts.
		const { code } = await run('/clear the cache in redis')
		expect(code).toBe(0)
		expect(sent.join('\n')).toContain('/clear the cache in redis')
	})

	it('refuses a bare built-in, which nobody means literally', async () => {
		// `namzu run "/help"` is not a sentence. Answering it by letting the model
		// improvise on the string is the same silent misfire as the original bug.
		const { code, errors } = await run('/help')
		expect(code).not.toBe(0)
		expect(errors.join('\n')).toContain('interactive')
		expect(sent).toHaveLength(0)
	})
})
