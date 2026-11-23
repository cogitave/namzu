/**
 * The doctrine tells the model which tools to use. A rule about a tool the
 * reader does not have is an instruction to fail, so the delegation rules
 * must be separable, and every tool the working rules name must be one the
 * kernel actually ships.
 */

import { describe, expect, it } from 'vitest'

import { PromptBuilder } from '../../runtime/query/prompt.js'
import { ToolManager } from '../../toolsets/manager.js'
import {
	CODING_AGENT_DELEGATION_DOCTRINE,
	CODING_AGENT_DOCTRINE_CONTRIBUTION_ID,
	CODING_AGENT_HYPERMODE_DOCTRINE,
	CODING_AGENT_ORCHESTRATE_DOCTRINE,
	CODING_AGENT_WORKING_DOCTRINE,
	PLAN_MODE_DOCTRINE,
	codingAgentDoctrineContribution,
} from '../coding-agent-doctrine.js'
import { PromptContributionRegistry } from '../contributions.js'

describe('the coding-agent doctrine', () => {
	it('names only builtin tools in the rules every agent receives', () => {
		const named = new Set(
			[...CODING_AGENT_WORKING_DOCTRINE.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]),
		)
		for (const tool of ['read', 'edit', 'write', 'bash', 'grep', 'glob']) {
			expect(named.has(tool)).toBe(true)
		}
		expect(named.has('task_create')).toBe(false)
		expect(named.has('Agent')).toBe(false)
	})

	it('tells the model that background work it started is its to end, naming the tool only where offered', () => {
		expect(CODING_AGENT_DELEGATION_DOCTRINE).toContain(
			'- Background work you started is yours to end: stop it (with `stop_task`, where offered) when the person changed course, a result in hand already answers the question, or an earlier stage failed; never because it is only slow. Say in one sentence what you stopped and why.',
		)
	})

	it('speaks of the task list without naming a tool, and never asks to remove a file', () => {
		// The list is optional and its tools are described where they are offered;
		// naming them here sent a model that had none to call a tool it lacked.
		expect(CODING_AGENT_DELEGATION_DOCTRINE).toContain('A task list is optional.')
		expect(CODING_AGENT_DELEGATION_DOCTRINE).not.toMatch(/`task_[a-z_]+`/)
		// A model once deleted its own deliverable on being told to clean up.
		expect(CODING_AGENT_WORKING_DOCTRINE).toContain('where any throwaway file you made is')
		expect(CODING_AGENT_WORKING_DOCTRINE).not.toMatch(
			/\b(?:remove|delete|clean up) (?:any |the )?(?:throwaway|scratch|temporary)/i,
		)
	})

	it('forbids changing git config or other persistent settings without asking', () => {
		// A live session set `git config user.name`/`user.email` on its own
		// when a commit failed for want of an identity.
		expect(CODING_AGENT_WORKING_DOCTRINE).toContain(
			'Never change git configuration or other persistent settings without asking',
		)
		for (const named of ['`user.name`', '`user.email`', 'hooks', 'remotes', '`git config`'])
			expect(CODING_AGENT_WORKING_DOCTRINE).toContain(named)
		expect(CODING_AGENT_WORKING_DOCTRINE).toContain(
			'If a commit fails because no identity is set, stop and tell the user the command to set one; do not invent one.',
		)
	})

	it('keeps the delegation rules out of a sub-agent prompt on request', () => {
		const parent = codingAgentDoctrineContribution().render({})
		const child = codingAgentDoctrineContribution({ delegation: false }).render({})
		expect(parent).toContain(CODING_AGENT_DELEGATION_DOCTRINE)
		expect(child).toBe(CODING_AGENT_WORKING_DOCTRINE)
		expect(child).not.toContain('task_create')
		expect(child).not.toContain('`Agent`')
	})

	it('lands in the cached prefix, after the host identity block', () => {
		const registry = new PromptContributionRegistry()
		registry.register(codingAgentDoctrineContribution())
		const builder = new PromptBuilder({
			systemPrompt: 'You are the host.',
			tools: new ToolManager({ toolsets: [], messages: () => [] }),
			contributions: registry,
		})
		const segments = builder.buildSegmented('full', '/tmp/project')
		expect(segments.static.indexOf('You are the host.')).toBeLessThan(
			segments.static.indexOf('## How you work'),
		)
		expect(segments.dynamic).not.toContain('## How you work')
	})

	it('is one contribution with a namespaced id, and the plan-mode text stands alone', () => {
		expect(CODING_AGENT_DOCTRINE_CONTRIBUTION_ID).toMatch(/^namzu\./)
		expect(codingAgentDoctrineContribution().placement).toBe('static')
		expect(PLAN_MODE_DOCTRINE).toContain('plan mode')
		expect(CODING_AGENT_WORKING_DOCTRINE).not.toContain('plan mode')
	})

	it('strengthens delegation guidance only when hypermode is on', () => {
		const today = `${CODING_AGENT_WORKING_DOCTRINE}\n\n${CODING_AGENT_DELEGATION_DOCTRINE}`
		const off = codingAgentDoctrineContribution().render({})
		const offExplicit = codingAgentDoctrineContribution({ hypermode: false }).render({})
		const on = codingAgentDoctrineContribution({ hypermode: true }).render({})
		// Mode-off output must stay byte-identical to what this contribution
		// rendered before the flag existed — a changed default here would be a
		// `major`, not a `minor`, under this repo's own SemVer rule.
		expect(off).toBe(today)
		expect(offExplicit).toBe(today)
		expect(on).toContain(CODING_AGENT_DELEGATION_DOCTRINE)
		expect(on).toContain(CODING_AGENT_HYPERMODE_DOCTRINE)
		expect(on).not.toBe(off)
		// The text names the mode by the name the operator sees.
		expect(CODING_AGENT_HYPERMODE_DOCTRINE).toMatch(
			/^### Hypermode\nThis session has hypermode on:/,
		)
	})

	it('still honours the deprecated orchestrate name, with the same text', () => {
		expect(CODING_AGENT_ORCHESTRATE_DOCTRINE).toBe(CODING_AGENT_HYPERMODE_DOCTRINE)
		expect(codingAgentDoctrineContribution({ orchestrate: true }).render({})).toBe(
			codingAgentDoctrineContribution({ hypermode: true }).render({}),
		)
	})

	it('asks for one phase to be launched in one response, never one agent at a time', () => {
		// A model given "two agents in parallel" and the mode on still
		// launched them one response apart; the doctrine now says so outright.
		expect(CODING_AGENT_HYPERMODE_DOCTRINE).toContain(
			'Agents in the same phase are launched in the same response',
		)
		expect(CODING_AGENT_HYPERMODE_DOCTRINE).toContain('never started one agent at a time')
		// The delegation text without the mode is untouched by this sentence.
		expect(CODING_AGENT_DELEGATION_DOCTRINE).not.toContain('same phase')
	})

	it('carries the delegation-restraint rules only where delegation is mounted', () => {
		const parent = codingAgentDoctrineContribution().render({})
		const child = codingAgentDoctrineContribution({ delegation: false }).render({})
		const rules = [
			'do small work, or work whose target you already know, yourself',
			'never a conclusion to confirm',
			'report is a claim, not a fact',
			'check one claim you will build on',
			'tell the user what each delegated agent found',
		]
		for (const rule of rules) {
			expect((parent ?? '').toLowerCase()).toContain(rule.toLowerCase())
			expect((child ?? '').toLowerCase()).not.toContain(rule.toLowerCase())
		}
		// Forks, explore, worktrees and parallel writers are the Agent tool's own description now.
		for (const moved of ['fork', 'worktree', 'explore'])
			expect(CODING_AGENT_DELEGATION_DOCTRINE).not.toContain(moved)
		// Hypermode says outright that it overrides the do-it-yourself rule.
		expect(CODING_AGENT_HYPERMODE_DOCTRINE).toContain(
			'overrides the advice above to do small work yourself',
		)
		// Hypermode stays its own section and an override, not part of the base rules.
		expect(CODING_AGENT_DELEGATION_DOCTRINE).not.toContain('### Hypermode')
		expect(codingAgentDoctrineContribution({ hypermode: true }).render({})).toContain(
			CODING_AGENT_HYPERMODE_DOCTRINE,
		)
	})

	it('never appends the hypermode text to a sub-agent prompt with delegation off', () => {
		for (const flag of [{ hypermode: true }, { orchestrate: true }]) {
			const child = codingAgentDoctrineContribution({ delegation: false, ...flag }).render({})
			expect(child).toBe(CODING_AGENT_WORKING_DOCTRINE)
			expect(child).not.toContain(CODING_AGENT_HYPERMODE_DOCTRINE)
		}
	})

	it('leaves the "how is it going" rules to the running-work note, and out of every doctrine', () => {
		// The rules ride with the note that lists running work, so a session with
		// nothing running never reads them.
		for (const text of [CODING_AGENT_WORKING_DOCTRINE, CODING_AGENT_DELEGATION_DOCTRINE]) {
			expect(text).not.toContain('Answering how work is going')
			expect(text).not.toContain('note about running work')
		}
	})

	const section = (from: string, to: string) =>
		CODING_AGENT_WORKING_DOCTRINE.slice(
			CODING_AGENT_WORKING_DOCTRINE.indexOf(from),
			CODING_AGENT_WORKING_DOCTRINE.indexOf(to),
		)

	it('answers a plain question first, without an apology, and treats a report of something broken as a request to fix it', () => {
		const text = section('### Questions, problems and investigations', '### Reporting')
		expect(text).toContain('A plain question')
		expect(text).toContain('gets the answer first')
		expect(text).toContain('not with an apology')
		expect(text).toContain('Put every look it needs in one response')
		expect(text).toContain('A status or cost question is answered from what is at hand')
		// A description of a problem is not held back as "a question to assess".
		expect(text).toContain(
			'is a request to fix it, unless the person says they only want a diagnosis',
		)
		expect(CODING_AGENT_WORKING_DOCTRINE).not.toContain('Act only when asked to act')
		expect(CODING_AGENT_WORKING_DOCTRINE).not.toContain('then stop; look further only when')
		// Every agent gets it, a sub-agent included.
		expect(codingAgentDoctrineContribution({ delegation: false }).render({})).toContain(text)
	})

	it('carries an investigation to its cause instead of stopping after one look', () => {
		const text = section('### Questions, problems and investigations', '### Reporting')
		expect(text).toContain('continues until the cause is found or every reasonable lead is used up')
		expect(text).toContain('what you ruled out and what would settle it')
	})

	it('finishes the whole task: no plan or promise in place of the work, obstacles worked through, no early wrap-up', () => {
		const text = section('### Finishing the work', '### Asking and proceeding')
		expect(text).toContain('Ending your turn stops all work')
		expect(text).toContain('never close on a plan or a promise of later work: do it now')
		expect(text).toContain('A step that says it will do something does it in that step')
		expect(text).toContain('Work through ordinary obstacles')
		expect(text).toContain('A denied call is a decision: adjust, and do not retry it')
		expect(text).toContain('do not issue the same call again')
		expect(text).toContain('finish every other part in full, and say what you left out and why')
		expect(text).toContain('Context is compacted automatically')
		expect(text).toContain('never a reason to wrap up early')
		// First in the working rules, and for every agent.
		expect(CODING_AGENT_WORKING_DOCTRINE.indexOf('### Finishing the work')).toBeLessThan(
			CODING_AGENT_WORKING_DOCTRINE.indexOf('### Reporting'),
		)
		expect(codingAgentDoctrineContribution({ delegation: false }).render({})).toContain(text)
	})

	it('acts on enough information, keeps decisions settled, and recommends instead of surveying', () => {
		const text = section('### Asking and proceeding', '### Questions, problems and investigations')
		expect(text).toContain('Act when you have enough information')
		expect(text).toContain('without re-deriving or reopening them')
		expect(text).toContain('give a recommendation, not a survey of options')
		expect(text).toContain('Ask only when you cannot name the most likely reading')
		expect(text).toContain('Ask once, with your best guess')
	})

	it('keeps the coding specifics under one heading that applies only to a change, and the closing report conditional', () => {
		const at = CODING_AGENT_WORKING_DOCTRINE.indexOf('### When the task is to change code')
		const end = CODING_AGENT_WORKING_DOCTRINE.indexOf('### Working with git')
		const code = CODING_AGENT_WORKING_DOCTRINE.slice(at, end)
		expect(code).toContain('applies only when you were asked to change something')
		for (const rule of [
			'Begin editing once you know the first change',
			'reproduce it first',
			"Run the project's tests",
		]) {
			expect(code).toContain(rule)
			// Outside that heading these rules do not ride on a plain question.
			expect(CODING_AGENT_WORKING_DOCTRINE.replace(code, '')).not.toContain(rule)
		}
		expect(CODING_AGENT_WORKING_DOCTRINE).toContain(
			'When you changed something, close with what changed, what was verified and what is left. For a question the reply is the answer.',
		)
	})

	it('narrates only work of several calls: one line first, one on a finding, none per call', () => {
		const text = CODING_AGENT_WORKING_DOCTRINE.slice(
			CODING_AGENT_WORKING_DOCTRINE.indexOf('### Keeping the user informed'),
		)
		expect(text).toContain(
			'For work that takes several calls, say one short line before the first call',
		)
		expect(text).toContain('when you find something, change direction or hit a blocker')
		expect(text).toContain('none beside each call')
		expect(text).toContain('none for a question that needs one look')
		// Said once: the old unconditional line is gone.
		expect(CODING_AGENT_WORKING_DOCTRINE.match(/first call/g) ?? []).toHaveLength(1)
		expect(CODING_AGENT_WORKING_DOCTRINE).not.toContain('Before your first tool call')
	})

	it('keeps the mismatch rule for evidence', () => {
		expect(CODING_AGENT_WORKING_DOCTRINE).toContain(
			'If a check or an exact-match edit reports a mismatch, inspect the current state and revise',
		)
	})

	it('leaves fork, explore and parallel-writer mechanics to the Agent tool, and keeps looks in one response', () => {
		// Those details ride in the Agent tool's description (a CLI test reads it);
		// the doctrine keeps only the rules about when to delegate and how to brief.
		expect(CODING_AGENT_DELEGATION_DOCTRINE).not.toContain('a fork cannot start forks')
		expect(CODING_AGENT_DELEGATION_DOCTRINE).not.toContain('never asks the user for permission')
		expect(CODING_AGENT_WORKING_DOCTRINE).toContain('Put every look it needs in one response')
	})
})
