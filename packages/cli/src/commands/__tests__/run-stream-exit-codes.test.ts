/**
 * What `run-stream`'s exit code says, case by case.
 *
 * The command had a stated rule — *started and failed → 0; refused to start →
 * non-zero* — that did not sort the cases it was applied to. An unknown option,
 * a missing prompt, a `--cwd` that is not there and a tool server that will not
 * connect are all refusals to start, and all four exited `0` while an untrusted
 * folder exited `77`.
 *
 * The axis that does sort them, and which every assertion below is an
 * instance of: **can the caller reach the run it asked for by changing what it
 * sends?**
 *
 * Every case asserts three things together, because each one alone is
 * satisfiable by a defect. The code, so a host branching on `$?` is right; the
 * `error` event, so the reason is on the stream a host actually reads; and the
 * terminating `done`, because the NDJSON contract is that every run ends with
 * one and a refusal that forgot it would leave a line-scanner waiting forever.
 *
 * These tests read the handler's RETURN VALUE. Every existing test of this
 * command discards it, which is why moving four cases across the line broke
 * none of them.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { openSessions } from '../../integrations/sessions/store.js'
import { fakeAgentSession } from '../../tui/__fixtures__/agent-session.js'
import { createAgentSession, probeAgentSession } from '../../tui/agent.js'
import { runStreamCommand } from '../run-stream.js'
import type { CommandContext } from '../types.js'

vi.mock('../../integrations/sessions/store.js', () => ({
	openSessions: vi.fn(async () => ({}) as never),
	resolveConversation: vi.fn(async () => 'conv-1' as never),
	loadConversation: vi.fn(async () => []),
	appendMessages: vi.fn(async () => undefined),
}))

const trusted = { value: true }
vi.mock('../../integrations/trust/store.js', () => ({
	isTrusted: () => trusted.value,
	trustDir: () => {},
}))

vi.mock('../../tui/agent.js', () => ({
	probeAgentSession: vi.fn(async () => ({
		preferences: { version: 3, providers: [{ id: 'anthropic' }], subagents: { active: [] } },
		needsRepickReason: null,
		credentialGap: null,
		detected: [],
	})),
	createAgentSession: vi.fn(async () => fakeAgentSession()),
}))

const ctx = { config: {} } as unknown as CommandContext

let stdinWasTTY: boolean | undefined

/** Run the command and keep BOTH halves of what it answered. */
async function run(rawArgs: string[]): Promise<{ code: number; out: string }> {
	const lines: string[] = []
	const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
		lines.push(String(chunk))
		return true
	})
	try {
		const code = (await runStreamCommand.handler({ rawArgs, ctx } as never)) as number
		return { code, out: lines.join('') }
	} finally {
		spy.mockRestore()
	}
}

/** Assert the shared half: it said why, and it ended the stream. */
function reported({ out }: { out: string }): void {
	expect(out, 'the failure was not on the stream').toContain('"kind":"error"')
	expect(out, 'the stream was left unterminated').toContain('"kind":"done"')
}

beforeEach(() => {
	// A terminal, so the stateless path reads nothing rather than waiting on a
	// pipe vitest never closes — the same reason, and the same note, as
	// `a-named-conversation-is-not-substituted`.
	stdinWasTTY = process.stdin.isTTY
	Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
	trusted.value = true
	vi.mocked(openSessions).mockImplementation(async () => ({}) as never)
	vi.mocked(probeAgentSession).mockImplementation(async () => ({
		preferences: { version: 3, providers: [{ id: 'anthropic' }], subagents: { active: [] } },
		needsRepickReason: null,
		credentialGap: null,
		detected: [],
	}))
	vi.mocked(createAgentSession).mockImplementation(async () => fakeAgentSession())
})

afterEach(() => {
	Object.defineProperty(process.stdin, 'isTTY', { value: stdinWasTTY, configurable: true })
	vi.restoreAllMocks()
})

describe('exit 0 — the caller can reach the run by sending something else', () => {
	it('an unknown option', async () => {
		const r = await run(['--format', 'json', 'hello'])
		expect(r.code).toBe(0)
		reported(r)
	})

	it('no prompt at all', async () => {
		const r = await run([])
		expect(r.code).toBe(0)
		reported(r)
	})

	it('a --cwd that does not exist', async () => {
		const r = await run(['--cwd', join(tmpdir(), 'namzu-no-such-dir-xyz'), 'hello'])
		expect(r.code).toBe(0)
		reported(r)
	})

	it('a --permission-mode that is not a mode', async () => {
		const r = await run(['--permission-mode', 'whatever', 'hello'])
		expect(r.code).toBe(0)
		reported(r)
	})

	it('an interactive command named headlessly', async () => {
		const r = await run(['/help'])
		expect(r.code).toBe(0)
		reported(r)
		expect(r.out).toContain('interactive')
	})

	it('a provider id that is not a provider', async () => {
		// `--provider` is a flag, so this is the caller's own text and the caller
		// fixes it. It arrives through the same `hasProvider === false` branch as
		// four environment failures, which is why the session has to say WHICH —
		// see the classification test in `agent-classifies-its-refusal`.
		vi.mocked(createAgentSession).mockImplementation(async () =>
			fakeAgentSession({
				hasProvider: false,
				errorHint: 'Unknown provider "not-a-provider" — pick another.',
				errorKind: 'invocation',
			}),
		)
		const r = await run(['--provider', 'not-a-provider', 'hello'])
		expect(r.code).toBe(0)
		reported(r)
	})

	it('a run that started and then failed', async () => {
		// Unchanged, and the case the whole in-band contract is built for: the
		// turn ran, the host renders the failure, and retrying may well work.
		vi.mocked(createAgentSession).mockImplementation(async () =>
			fakeAgentSession({
				send: async function* () {
					yield { kind: 'error', message: 'the provider returned 503' } as never
					yield { kind: 'done' } as never
				},
			}),
		)
		const r = await run(['hello'])
		expect(r.code).toBe(0)
		expect(r.out).toContain('503')
	})
})

describe('exit 1 — nothing the caller sends changes it', () => {
	it('a named conversation that cannot be opened', async () => {
		// The case #314 put on the wrong side. `resolveConversation` creates the
		// key on first use, so this can never be a key the host got wrong — the
		// only way here is the store itself, an unwritable `.namzu` or a corrupt
		// map file, and a host treating 0 as "render it and move on" would loop on
		// it.
		vi.mocked(openSessions).mockImplementation(async () => {
			throw new Error('EACCES: permission denied')
		})
		const r = await run(['--session', 'nightly', 'hello'])
		expect(r.code).toBe(1)
		reported(r)
	})

	it('no LLM provider available at all', async () => {
		vi.mocked(probeAgentSession).mockImplementation(async () => ({
			preferences: null,
			needsRepickReason: null,
			credentialGap: null,
			detected: [],
		}))
		const r = await run(['hello'])
		expect(r.code).toBe(1)
		reported(r)
	})

	it('a session that came up without a provider for an environment reason', async () => {
		vi.mocked(createAgentSession).mockImplementation(async () =>
			fakeAgentSession({
				hasProvider: false,
				errorHint: 'No credential found for Anthropic.',
				errorKind: 'environment',
			}),
		)
		const r = await run(['hello'])
		expect(r.code).toBe(1)
		reported(r)
	})

	it('a declared tool server that is not there', async () => {
		// Declared in `namzu.config.json`, not in the invocation, so no argument
		// brings it up. `namzu run` already exits 1 here.
		vi.mocked(createAgentSession).mockImplementation(async () =>
			fakeAgentSession({ mcpFailed: [{ name: 'tickets', reason: 'ENOENT' }] as never }),
		)
		const r = await run(['hello'])
		expect(r.code).toBe(1)
		reported(r)
		expect(r.out).toContain('tickets')
	})

	it('a command file that will not parse', async () => {
		// The other half of the expansion refusal. No prompt fixes a file.
		const dir = mkdtempSync(join(tmpdir(), 'namzu-cmds-'))
		mkdirSync(join(dir, '.namzu', 'commands'), { recursive: true })
		// Frontmatter that opens and never closes — the reader's own definition of
		// a file it cannot use.
		writeFileSync(join(dir, '.namzu', 'commands', 'broken.md'), '---\ndescription: half a file\n')
		const r = await run(['--cwd', dir, '/broken', 'go'])
		expect(r.code).toBe(1)
		reported(r)
		expect(r.out, 'the reader did not say what was wrong with the file').toContain('frontmatter')
	})
})

describe('exit 77 — only a person can change it', () => {
	it('an untrusted folder', async () => {
		// Kept to this one condition. Being unambiguous is 77's entire
		// justification, and widening it spends the only thing it has.
		trusted.value = false
		const r = await run(['hello'])
		expect(r.code).toBe(77)
		reported(r)
	})
})

describe('flags this command does not implement', () => {
	it('refuses --continue rather than quietly running stateless', async () => {
		// The shared parser accepts both; this command reads neither. A host that
		// asked to reopen a conversation was given a fresh one, reported as an
		// ordinary success — the worst cell in the table this file is about, and
		// the one no exit code could have rescued.
		const r = await run(['--continue', 'hello'])
		expect(r.code).toBe(0)
		reported(r)
		expect(r.out, 'the refusal does not say what to use instead').toContain('--session')
	})

	it('refuses --resume the same way', async () => {
		const r = await run(['--resume', 'ses_123', 'hello'])
		expect(r.code).toBe(0)
		reported(r)
		expect(r.out).toContain('--session')
	})
})
