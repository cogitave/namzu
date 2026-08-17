import type { CostInfo } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import {
	CLI_LOCAL_COMMANDS,
	type SlashContext,
	initPrompt,
	kernelCommandDescriptors,
	matchSlashCommands,
	mergeHostCommands,
	parseSlash,
	renderAgents,
	runSlash,
} from './slashCommands.js'

/**
 * A cost record, built the way the kernel builds one.
 *
 * `unpricedTokens` defaults to 0 — "nothing is unaccounted for" — so a case
 * that does not mention it is asserting a fully-priced run rather than
 * accidentally describing an unknown one.
 */
function cost(totalCost: number, over: Partial<CostInfo> = {}): CostInfo {
	return { totalCost, cacheDiscount: 0, unpricedTokens: 0, ...over }
}

/**
 * The permission half of a context, for the same reason `context` exists below:
 * these were inline literals, so each new field had to be added to all four.
 */
function permissions(over: Partial<SlashContext['permissions']> = {}): SlashContext['permissions'] {
	return {
		skipPermissions: false,
		rules: [],
		approvalLatched: () => false,
		neverPrompted: () => [],
		...over,
	}
}

/**
 * A context with nothing interesting in it, plus whatever this test is about.
 *
 * Built through a helper rather than as literals so that a field added to
 * `SlashContext` lands in one place — the same reason `__fixtures__/agent-session.ts`
 * exists, and this file had two literals that would each have had to grow.
 */
function context(over: Partial<SlashContext> = {}): SlashContext {
	return {
		availableTools: () => [],
		sandbox: null,
		lastAssistantMessageId: () => null,
		providerSummary: null,
		modelSummary: null,
		usage: null,
		permissions: permissions(),
		instructionFiles: [],
		userCommands: [],
		...over,
	}
}

const ctx: SlashContext = context()

const ctxWithTools: SlashContext = context({
	availableTools: () => ['Bash', 'Read', 'Edit'],
	providerSummary: 'anthropic-personal (anthropic)',
	modelSummary: 'claude-opus-4-7',
})

describe('matchSlashCommands', () => {
	it('returns all commands for a bare slash', () => {
		expect(matchSlashCommands('/')).toEqual(CLI_LOCAL_COMMANDS)
	})

	it('filters by name prefix (case-insensitive)', () => {
		const names = matchSlashCommands('/me').map((c) => c.name)
		expect(names).toContain('memory')
		expect(names).not.toContain('help')
		expect(matchSlashCommands('/MO').map((c) => c.name)).toContain('model')
	})

	it('returns [] once a space is typed (now entering arguments)', () => {
		expect(matchSlashCommands('/model ')).toEqual([])
		expect(matchSlashCommands('/skill foo')).toEqual([])
	})

	it('returns [] for non-slash input', () => {
		expect(matchSlashCommands('hello')).toEqual([])
		expect(matchSlashCommands('')).toEqual([])
	})

	it('returns [] when nothing matches the prefix', () => {
		expect(matchSlashCommands('/zzz')).toEqual([])
	})
})

describe('parseSlash', () => {
	it('returns null for non-slash lines', () => {
		expect(parseSlash('hello world')).toBeNull()
		expect(parseSlash('')).toBeNull()
		expect(parseSlash('  ')).toBeNull()
	})

	it('tolerates leading whitespace', () => {
		expect(parseSlash('  /help')).toEqual({ name: 'help', args: [] })
	})

	it('splits args on whitespace', () => {
		expect(parseSlash('/model anthropic claude-opus-4-7')).toEqual({
			name: 'model',
			args: ['anthropic', 'claude-opus-4-7'],
		})
	})

	it('returns null for a bare slash', () => {
		expect(parseSlash('/')).toBeNull()
		expect(parseSlash('/ ')).toBeNull()
	})
})

describe('runSlash', () => {
	it('returns null for non-slash input', () => {
		expect(runSlash('plain message', ctx)).toBeNull()
	})

	it('reports unknown commands as system messages', () => {
		const r = runSlash('/nope', ctx)
		expect(r?.kind).toBe('message')
		if (r?.kind === 'message') expect(r.content).toContain('Unknown command')
	})

	it('/help lists every registered command', () => {
		const r = runSlash('/help', ctx)
		expect(r?.kind).toBe('message')
		if (r?.kind === 'message') {
			for (const cmd of CLI_LOCAL_COMMANDS) {
				expect(r.content).toContain(`/${cmd.name}`)
			}
		}
	})

	it('/clear returns a clear action', () => {
		expect(runSlash('/clear', ctx)).toEqual({ kind: 'clear' })
	})

	it('/quit and /exit both produce an exit action', () => {
		expect(runSlash('/quit', ctx)).toEqual({ kind: 'exit' })
		expect(runSlash('/exit', ctx)).toEqual({ kind: 'exit' })
	})

	it('/tools reports "no tools" when registry is empty', () => {
		const r = runSlash('/tools', ctx)
		expect(r?.kind).toBe('message')
		if (r?.kind === 'message') expect(r.content).toContain('No tools registered')
	})

	it('/tools lists registered tools when present', () => {
		const r = runSlash('/tools', ctxWithTools)
		expect(r?.kind).toBe('message')
		if (r?.kind === 'message') {
			expect(r.content).toContain('Bash')
			expect(r.content).toContain('Read')
			expect(r.content).toContain('3')
		}
	})

	it('/provider says "not configured" when no provider', () => {
		const r = runSlash('/provider', ctx)
		expect(r?.kind).toBe('message')
		if (r?.kind === 'message') expect(r.content).toContain('No provider configured')
	})

	it('/provider shows summary when configured', () => {
		const r = runSlash('/provider', ctxWithTools)
		expect(r?.kind).toBe('message')
		if (r?.kind === 'message') {
			expect(r.content).toContain('anthropic-personal')
			expect(r.content).toContain('claude-opus-4-7')
		}
	})

	it('/model re-opens the picker (repick action)', () => {
		expect(runSlash('/model', ctxWithTools)).toEqual({ kind: 'repick' })
	})
})

describe('/cost', () => {
	it('says so plainly before any turn has reported usage', () => {
		const r = runSlash('/cost', context({ usage: null }))
		expect(r?.kind).toBe('message')
		if (r?.kind === 'message') expect(r.content).toContain('No usage reported yet')
	})

	it('prints exact figures rather than the status bar abbreviation', () => {
		const r = runSlash('/cost', context({ usage: { totalTokens: 12_345, cost: cost(0.0731) } }))
		expect(r?.kind).toBe('message')
		if (r?.kind === 'message') {
			// `12,345`, not `12.3k` — someone who asked wants the number.
			expect(r.content).toContain('12,345')
			// Four decimals, not `$0.07`. The kernel's own `describeCost` rounds
			// above a cent, which is why this command does not use it.
			expect(r.content).toContain('$0.0731')
		}
	})

	// The three states this command has to keep apart. Two of them used to
	// print the same sentence, and it was the wrong sentence for both.
	it('reports a measured zero as free, not as a missing price', () => {
		const r = runSlash('/cost', context({ usage: { totalTokens: 900, cost: cost(0) } }))
		if (r?.kind === 'message') {
			expect(r.content).toContain('measured zero')
			expect(r.content).toContain('bills nothing')
			// The old line said this about every zero, including this one.
			expect(r.content).not.toContain('no price')
		}
	})

	it('reports an unpriced run as not known, and says it is not a claim of free', () => {
		const r = runSlash(
			'/cost',
			context({ usage: { totalTokens: 900, cost: cost(0, { unpricedTokens: 900 }) } }),
		)
		if (r?.kind === 'message') {
			expect(r.content).toContain('not known')
			expect(r.content).toContain('900 tokens')
			// The whole clause, not the word `not` — which appears in the
			// neighbouring sentence too, so asserting it alone held against a
			// version with this disclaimer deleted. Matched against the prose
			// with its wrapping collapsed: the sentence is the property, and
			// where the line happens to break is not.
			expect(r.content.replace(/\s+/g, ' ')).toContain('not a claim that they were free')
			// It must not read as the free case.
			expect(r.content).not.toContain('measured zero')
			// And it must not assert something about the provider that nothing
			// checked. The old copy did exactly that.
			expect(r.content).not.toContain('provider reported')
		}
	})

	it('gives the free and the unknown run different answers', () => {
		// The assertion the old code could not have passed: both runs have a
		// total of zero, and a reader has to be able to tell them apart. A test
		// that only checked one of them in isolation would have passed against
		// the single sentence that used to serve both.
		const free = runSlash('/cost', context({ usage: { totalTokens: 900, cost: cost(0) } }))
		const unknown = runSlash(
			'/cost',
			context({ usage: { totalTokens: 900, cost: cost(0, { unpricedTokens: 900 }) } }),
		)
		if (free?.kind === 'message' && unknown?.kind === 'message') {
			expect(free.content).not.toBe(unknown.content)
		}
	})

	it('says a partly-priced run is a floor rather than the answer', () => {
		const r = runSlash(
			'/cost',
			context({ usage: { totalTokens: 1_000, cost: cost(0.5, { unpricedTokens: 400 }) } }),
		)
		if (r?.kind === 'message') {
			expect(r.content).toContain('$0.5000')
			expect(r.content).toContain('400 tokens')
			expect(r.content).toContain('see below')
		}
	})

	it('says the number is spend and not context fill', () => {
		// The two were conflated once, in the gauge. A command that prints one
		// without naming which it is invites the same misreading back.
		const r = runSlash('/cost', context({ usage: { totalTokens: 10, cost: cost(1) } }))
		if (r?.kind === 'message') {
			expect(r.content).toContain('Cumulative')
			expect(r.content).toContain('how full')
		}
	})
})

describe('/permissions', () => {
	it('reports that unreviewed calls are asked about by default', () => {
		const r = runSlash('/permissions', context())
		if (r?.kind === 'message') expect(r.content).toContain('you are asked')
	})

	it('names the flag when approval is automatic', () => {
		const r = runSlash(
			'/permissions',
			context({ permissions: permissions({ skipPermissions: true }) }),
		)
		if (r?.kind === 'message') {
			expect(r.content).toContain('approved automatically')
			expect(r.content).toContain('--dangerously-skip-permissions')
		}
	})

	it('lists configured rules with their verb', () => {
		const r = runSlash(
			'/permissions',
			context({
				permissions: permissions({
					rules: [
						{ type: 'deny_by_name', toolNames: ['bash'] },
						{ type: 'allow_by_name', toolNames: ['read', 'glob'] },
					],
				}),
			}),
		)
		if (r?.kind === 'message') {
			expect(r.content).toContain('deny')
			expect(r.content).toContain('bash')
			expect(r.content).toContain('allow')
			expect(r.content).toContain('read, glob')
		}
	})

	it('reports approve-all as automatic approval, not as "you are asked"', () => {
		// The defect this readout was rewritten for. One `a` at a prompt turns
		// every later tool call into an automatic approval, and the page whose
		// job is to report that posture kept reporting the opposite.
		const r = runSlash(
			'/permissions',
			context({ permissions: permissions({ approvalLatched: () => true }) }),
		)
		if (r?.kind === 'message') {
			expect(r.content).toContain('approved automatically')
			expect(r.content).toContain('approve all')
			expect(r.content, 'still claims calls are reviewed').not.toContain('you are asked')
		}
	})

	it('reads the latch when it renders, not when the context was built', () => {
		// The staleness this is really guarding against. The context object is
		// assembled during a render and read later from a callback that captured
		// it, so a boolean field would report whatever was true at build time.
		// Here the latch flips AFTER the context exists — which is exactly what
		// happens when the operator presses `a` mid-turn.
		let latched = false
		const ctxLive = context({ permissions: permissions({ approvalLatched: () => latched }) })

		const before = runSlash('/permissions', ctxLive)
		if (before?.kind === 'message') expect(before.content).toContain('you are asked')

		latched = true

		const after = runSlash('/permissions', ctxLive)
		if (after?.kind === 'message') {
			expect(after.content).toContain('approved automatically')
			expect(after.content).not.toContain('you are asked')
		}
	})

	it('discloses the tools that never reach a prompt', () => {
		// Undiscoverable by using namzu: these calls simply never appear, so
		// their absence reads as "the agent did not use any".
		const r = runSlash(
			'/permissions',
			context({
				permissions: permissions({ neverPrompted: () => ['glob', 'read', 'task_create'] }),
			}),
		)
		if (r?.kind === 'message') {
			expect(r.content).toContain('Never prompted')
			expect(r.content).toContain('glob, read, task_create')
			// Must not overclaim: a rule still outranks this, and a call flagged
			// destructive is prompted for even when it is on the list.
			expect(r.content).toContain('deny')
			expect(r.content).toContain('destructive')
		}
	})

	it('describes a pattern rule instead of printing its type name', () => {
		// A `permissions` table compiles every per-pattern entry to
		// `custom_pattern`, so this is the shape of the commonest real config.
		// It used to render as the single word `custom_pattern`.
		const r = runSlash(
			'/permissions',
			context({
				permissions: permissions({
					rules: [
						{
							type: 'custom_pattern',
							pattern: '^bash .*git push.*$',
							target: 'both',
							decision: 'deny',
						},
					],
				}),
			}),
		)
		if (r?.kind === 'message') {
			expect(r.content).toContain('deny')
			expect(r.content).toContain('git push')
			expect(r.content, 'printed the enum name').not.toContain('custom_pattern')
		}
	})

	it('describes an argument rule by naming the argument it tests', () => {
		const r = runSlash(
			'/permissions',
			context({
				permissions: permissions({
					rules: [
						{
							type: 'argument_pattern',
							toolNames: ['bash'],
							argument: 'command',
							pattern: '^rm ',
							decision: 'deny',
						},
					],
				}),
			}),
		)
		if (r?.kind === 'message') {
			expect(r.content).toContain('bash')
			expect(r.content).toContain('command')
			expect(r.content).not.toContain('argument_pattern')
		}
	})

	it('points at the config in the syntax the config is actually written in', () => {
		// It said `[permissions] table`, which is TOML, in a file that is JSON.
		const r = runSlash('/permissions', context())
		if (r?.kind === 'message') {
			expect(r.content).toContain('namzu.config.json')
			expect(r.content, 'TOML syntax for a JSON file').not.toContain('[permissions]')
		}
	})

	it('names the safety gate, which outranks everything else on the page', () => {
		// The function claims to describe "what decides a tool call, in the order
		// it actually decides it", and used to begin one step in. The gate is
		// hardcoded on and no flag reaches it, so leaving it out let "a rule
		// decides first" read as the whole story.
		const r = runSlash('/permissions', context())
		if (r?.kind === 'message') {
			expect(r.content).toContain('safety gate')
			expect(r.content).toContain('every mode')
		}
	})

	it('states that a rule outranks the approval setting', () => {
		// The precedence people get wrong, and wrong in the dangerous direction:
		// assuming the bypass flag lifts a `deny` they wrote. It does not.
		const r = runSlash(
			'/permissions',
			context({ permissions: permissions({ skipPermissions: true }) }),
		)
		if (r?.kind === 'message') expect(r.content).toContain('never reopen what a')
	})
})

describe('the roster formatter', () => {
	// `/agents` is answered by the KERNEL's registry now — the roster is its
	// fact, and the CLI carrying a second copy meant two answers to one
	// question that could disagree. What is left here is the drawing.
	it('answers honestly when nothing is mounted', () => {
		const rendered = renderAgents([])

		expect(rendered).toContain('No delegates')
		expect(rendered).toContain('does the work itself')
	})

	it('lists the roster it was given', () => {
		const rendered = renderAgents(['general-purpose', 'reviewer'])

		expect(rendered).toContain('general-purpose')
		expect(rendered).toContain('reviewer')
		expect(rendered).toContain('2')
	})
})

describe('/init', () => {
	it('refuses without a provider, because it works by asking the agent', () => {
		const r = runSlash('/init', context({ providerSummary: null }))
		expect(r?.kind).toBe('message')
		if (r?.kind === 'message') expect(r.content).toContain('needs a provider')
	})

	it('drives a turn rather than printing at the user', () => {
		// The whole design: the kernel reads the tree and writes the file, so
		// this must be a prompt and not a CLI-side generator.
		const r = runSlash('/init', context({ providerSummary: 'mock (mock)' }))
		expect(r?.kind).toBe('prompt')
	})

	it('tells the agent to verify claims and omit what it cannot establish', () => {
		// An AGENTS.md of plausible inventions is worse than none, because the
		// next agent obeys it. If this instruction goes missing the command
		// still "works" and quietly gets worse, so it is pinned.
		const p = initPrompt([])
		expect(p).toContain('Verify every claim against the tree')
		expect(p).toContain('leave it out')
	})

	it('asks for a new file when the project has no instructions', () => {
		const p = initPrompt([])
		expect(p).toContain('no AGENTS.md yet')
		expect(p).not.toContain('Do not overwrite')
	})

	it('refuses to overwrite instructions that already exist, and names them', () => {
		const p = initPrompt(['/repo/AGENTS.md', '/repo/pkg/AGENTS.md'])
		expect(p).toContain('Do not overwrite')
		expect(p).toContain('/repo/AGENTS.md')
		expect(p).toContain('/repo/pkg/AGENTS.md')
		expect(p).not.toContain('no AGENTS.md yet')
	})
})

describe('the new commands are reachable', () => {
	it('/help lists them, so they are discoverable without docs', () => {
		// Through the MERGED set, which is the whole claim: `/agents` is the
		// kernel's command now, and it reaches `/help` with no edit to this
		// file. Deleting the merge makes this fail.
		const merged = mergeHostCommands(kernelCommandDescriptors())
		const r = runSlash('/help', { ...ctx, builtins: merged }, merged)
		expect(r?.kind).toBe('message')
		if (r?.kind === 'message') {
			// Anchored on the whole name, not a prefix. `toContain('/agents')` was
			// the first version and it survived renaming the command to
			// `/agentsXX`, because that contains it — the same substring trap that
			// let a deleted command keep passing a `--help` assertion in
			// `cli.test.ts`. `/help` pads the name, so a real entry is the name
			// followed by whitespace.
			expect(r.content).toMatch(/\/cost\s/)
			expect(r.content).toMatch(/\/permissions\s/)
			expect(r.content).toMatch(/\/agents\s/)
			// `/expand` replaced a key. A key is discoverable by pressing it and a
			// command is not, so the entry that names it is load-bearing in a way
			// the others are not.
			expect(r.content).toMatch(/\/expand\s/)
		}
	})

	it('autocomplete offers them', () => {
		const merged = mergeHostCommands(kernelCommandDescriptors())
		const names = (prefix: string) => matchSlashCommands(prefix, [], merged).map((c) => c.name)

		expect(names('/co')).toContain('cost')
		// The kernel's, reaching the dropdown with no edit to this file.
		expect(names('/ag')).toContain('agents')
		expect(names('/ta')).toContain('tasks')
		expect(names('/per')).toContain('permissions')
		expect(names('/ex')).toContain('expand')
	})
})

describe('/expand argument parsing', () => {
	// This module validates the SHAPE of the argument and nothing else. Whether
	// block 4 exists is a fact about the transcript, which App owns; putting the
	// lookup here as well would give one question two answers.

	it('takes the most recent block when given no argument', () => {
		expect(runSlash('/expand', ctx)).toEqual({ kind: 'expand', which: 'last' })
	})

	it('passes a number through', () => {
		expect(runSlash('/expand 3', ctx)).toEqual({ kind: 'expand', which: 3 })
	})

	it('refuses a number-with-a-suffix rather than reading the digits off it', () => {
		// `parseInt('2nd')` is 2, so a parser built on it expands block 2 for
		// what was a typo — and shows the operator output they did not ask for
		// with nothing to indicate the substitution. `Number` returns NaN, which
		// is the honest reading of `2nd` as a block number.
		const r = runSlash('/expand 2nd', ctx)
		expect(r?.kind).toBe('message')
		if (r?.kind === 'message') expect(r.content).toContain('Usage: /expand')
	})

	it('accepts only the spelling a hint can print', () => {
		// Every one of these is a number JavaScript is happy to parse and no
		// collapse hint has ever shown. They matter because each turns a typo
		// into a VALID reference to some other block, which is the silently-wrong
		// answer this surface exists to remove — `0x10` reaching block 16 is
		// worse than `0x10` being refused.
		//
		// `Number(arg)` with `Number.isInteger` — the first version of this
		// parser — accepts all four.
		for (const arg of ['0', '-1', '1.5', '0x10', '1e2', '+3', '3.0', '3 3']) {
			const r = runSlash(`/expand ${arg}`, ctx)
			expect(r?.kind, `"${arg}" was accepted as a block number`).toBe('message')
		}
	})

	it('is not fussy about the spacing around it', () => {
		// Refusing `0x10` is about a wrong answer being possible. Extra spaces
		// cannot produce a wrong answer, and refusing them would be strictness
		// for its own sake — `parseSlash` splits on runs of whitespace, so this
		// is already the same argument.
		expect(runSlash('/expand   3', ctx)).toEqual({ kind: 'expand', which: 3 })
		expect(runSlash('  /expand 3  ', ctx)).toEqual({ kind: 'expand', which: 3 })
	})
})

describe('/login and /logout', () => {
	it('starts an attempt when typed on its own', () => {
		expect(runSlash('/login', ctx)).toEqual({ kind: 'login' })
	})

	it('finishes the attempt in flight when given an address or a code', () => {
		expect(runSlash('/login abc#xyz', ctx)).toEqual({ kind: 'login', pasted: 'abc#xyz' })
		expect(runSlash('/login http://localhost:53692/callback?code=a&state=b', ctx)).toEqual({
			kind: 'login',
			pasted: 'http://localhost:53692/callback?code=a&state=b',
		})
	})

	it('treats a trailing space as a start, not an empty paste', () => {
		// An empty `pasted` would be sent onward as if it were an authorization
		// code, and refused by a token endpoint rather than by us.
		expect(runSlash('/login   ', ctx)).toEqual({ kind: 'login' })
	})

	it('keeps the whole argument rather than only the first word', () => {
		// A pasted address can arrive broken by a terminal wrap; dropping
		// everything after the first space would silently truncate the code.
		expect(runSlash('/login a b', ctx)).toEqual({ kind: 'login', pasted: 'a b' })
	})

	it('offers logout with no argument to misread', () => {
		expect(runSlash('/logout', ctx)).toEqual({ kind: 'logout' })
		expect(runSlash('/logout everything', ctx)).toEqual({ kind: 'logout' })
	})

	it('both appear in /help, or nobody finds them', () => {
		const help = runSlash('/help', ctx)
		expect(help?.kind).toBe('message')
		if (help?.kind === 'message') {
			expect(help.content).toContain('/login')
			expect(help.content).toContain('/logout')
		}
	})

	it('both are offered by autocomplete', () => {
		expect(matchSlashCommands('/log').map((c) => c.name)).toEqual(
			expect.arrayContaining(['login', 'logout']),
		)
	})
})

describe('/feedback', () => {
	const run = (args: string[], last: string | null) =>
		CLI_LOCAL_COMMANDS.find((c) => c.name === 'feedback')?.action(
			context({ lastAssistantMessageId: () => last }),
			args,
		)

	it('names the message it is rating', () => {
		// The id comes from the command, not from App re-deriving it later.
		// Re-deriving would open a window where the answer moved between the
		// check and the write — a rating landing on the wrong message.
		expect(run(['good'], 'msg_42')).toEqual({
			kind: 'feedback',
			rating: 'good',
			messageId: 'msg_42',
		})
	})

	it('carries a note when one is given', () => {
		expect(run(['bad', 'wrong', 'file'], 'msg_42')).toEqual({
			kind: 'feedback',
			rating: 'bad',
			messageId: 'msg_42',
			note: 'wrong file',
		})
	})

	it('refuses rather than inventing a message id when there is no answer yet', () => {
		// The case that matters. A feedback row is read later to answer "which
		// answers were bad"; one pointing at a synthesized id cannot be traced
		// back to what was said and is indistinguishable from a real one.
		const result = run(['good'], null)

		expect(result?.kind).toBe('message')
		expect((result as { content: string }).content).toMatch(/Nothing to rate/)
	})

	it('refuses a rating that is not one of the two', () => {
		const result = run(['meh'], 'msg_42')

		expect(result?.kind).toBe('message')
		expect((result as { content: string }).content).toMatch(/good\|bad/)
	})

	it('refuses an empty argument list', () => {
		expect(run([], 'msg_42')?.kind).toBe('message')
	})
})
