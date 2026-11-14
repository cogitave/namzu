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
			'never a conclusion for the sub-agent to confirm',
			'do not do the work again yourself',
			'report is a claim, not a fact',
			'check one claim you will build on',
			'separate worktrees',
			'not for reviewing or auditing whole files',
		]
		for (const rule of rules) {
			expect((parent ?? '').toLowerCase()).toContain(rule.toLowerCase())
			expect((child ?? '').toLowerCase()).not.toContain(rule.toLowerCase())
		}
		expect(CODING_AGENT_DELEGATION_DOCTRINE).toContain('any record line shown beside it')
		expect(CODING_AGENT_DELEGATION_DOCTRINE).toContain('when the checkout is a git repo')
		expect(CODING_AGENT_DELEGATION_DOCTRINE).not.toContain('the kernel writes beside it')
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

	it('tells the parent how to answer "how is it going", and keeps that rule out of a sub-agent prompt', () => {
		const section = CODING_AGENT_DELEGATION_DOCTRINE.slice(
			CODING_AGENT_DELEGATION_DOCTRINE.indexOf('### Answering how work is going'),
		)
		expect(section).toContain('note about running work')
		for (const verdict of ['progressing', 'waiting', 'stalled', 'dead'])
			expect(section).toContain(verdict)
		expect(section).toContain('how long ago it last moved')
		expect(section).toContain('finished (with its result), running (and where it is), queued')
		// The language rule lives once, at the top of the identity, not in this section.
		expect(section).not.toMatch(/language/)
		expect(section).toContain('say it is still running')
		expect(section).toContain('offer to run it again')
		// Stated as what to do, with its reason, in plain words.
		expect(section).not.toMatch(/\b(MUST|NEVER|CRITICAL)\b/)
		expect(section).not.toMatch(/\/jobs|\/agents|\/tasks/)
		expect(codingAgentDoctrineContribution({ delegation: false }).render({})).not.toContain(
			'Answering how work is going',
		)
	})

	it('answers a question before acting, without an apology or a promise', () => {
		const section = CODING_AGENT_WORKING_DOCTRINE.slice(
			CODING_AGENT_WORKING_DOCTRINE.indexOf('### Answering a question'),
			CODING_AGENT_WORKING_DOCTRINE.indexOf('### Asking and proceeding'),
		)
		expect(section).toContain('gets an answer or an assessment first')
		expect(section).toContain('Act only when asked to act')
		expect(section).toContain('not with an apology')
		expect(section).toContain('a turn never ends on a promise of a later answer')
		// The answering section comes first in the working rules, not mid-prompt.
		expect(CODING_AGENT_WORKING_DOCTRINE.indexOf('### Answering a question')).toBeLessThan(
			CODING_AGENT_WORKING_DOCTRINE.indexOf('### Reporting'),
		)
		// Every agent gets it, a sub-agent included.
		expect(codingAgentDoctrineContribution({ delegation: false }).render({})).toContain(section)
	})

	it('says what is missing and stops when a look finds nothing, rather than widening the search', () => {
		const section = CODING_AGENT_WORKING_DOCTRINE.slice(
			CODING_AGENT_WORKING_DOCTRINE.indexOf('### Answering a question'),
			CODING_AGENT_WORKING_DOCTRINE.indexOf('### Asking and proceeding'),
		)
		expect(section).toContain('When two looks have not given the fact a question asks for')
		expect(section).toContain('say what you looked at and what is missing, then stop')
		expect(section).toContain('do not widen the search a third time')
		expect(section).toContain('report what you ruled out and what would settle it')
	})

	it('asks only when the most likely reading cannot be named, asks once, and does not repeat a failed call', () => {
		const section = CODING_AGENT_WORKING_DOCTRINE.slice(
			CODING_AGENT_WORKING_DOCTRINE.indexOf('### Asking and proceeding'),
			CODING_AGENT_WORKING_DOCTRINE.indexOf('### Reporting'),
		)
		expect(section).toContain('Ask only when you cannot name the most likely reading')
		expect(section).toContain('Ask once, with your best guess')
		expect(section).toContain('change the request or report it; do not issue the same call again')
	})

	it('keeps the coding specifics under one heading that applies only to a change, and the closing report conditional', () => {
		const at = CODING_AGENT_WORKING_DOCTRINE.indexOf('### When the task is to change code')
		const end = CODING_AGENT_WORKING_DOCTRINE.indexOf('### Working with git')
		const code = CODING_AGENT_WORKING_DOCTRINE.slice(at, end)
		expect(code).toContain('applies only when you were asked to change something')
		for (const rule of [
			'Begin editing once you know the first change',
			'Finish the whole task',
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
		const section = CODING_AGENT_WORKING_DOCTRINE.slice(
			CODING_AGENT_WORKING_DOCTRINE.indexOf('### Keeping the user informed'),
		)
		expect(section).toContain(
			'For work that takes several calls, say one short line before the first call',
		)
		expect(section).toContain('one more when you find something or change direction')
		expect(section).toContain('a question that needs at most one look gets no such line')
		expect(section).toContain('no line goes beside each call')
		// Said once: the old unconditional line is gone.
		expect(CODING_AGENT_WORKING_DOCTRINE.match(/first call/g) ?? []).toHaveLength(1)
		expect(CODING_AGENT_WORKING_DOCTRINE).not.toContain('Before your first tool call')
	})
})
