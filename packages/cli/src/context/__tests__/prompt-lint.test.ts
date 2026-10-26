/**
 * The assembled prompts, read the way a model reads them.
 *
 * Three mistakes cost a turn each and are invisible in a diff: a sentence that
 * points at a tool that is not mounted (the identity once told the model to
 * confirm work "with a real shell like `bash.run`"), a prompt that names some
 * other product, and wording that tells the person to start over. This test
 * assembles the prompt of the main session, of plan mode and of a delegated
 * sub-agent from the same pieces the runtime joins, and checks all three.
 */

import * as sdk from '@namzu/sdk'
import { createRuntimeContextMessage, createUserMessage } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { CONVERSATION_EVIDENCE_GUIDANCE } from '../../integrations/sessions/conversation-search.js'
import { EXPLORE_PROMPT, SUBAGENT_PROMPT } from '../../integrations/subagents/runtime.js'
import { WORKFLOW_DOCTRINE } from '../../integrations/workflows/doctrine.js'
import { WORKFLOW_TOOL_NAME } from '../../integrations/workflows/offering.js'
import { EXIT_PLAN_MODE_TOOL_NAME } from '../../plan/approval.js'
import { hypermodeReminders } from '../../reminders/hypermode.js'
import { modeReminders } from '../../reminders/mode.js'
import { planModeReminders } from '../../reminders/plan-mode.js'
import { DEFERRED_TOOL_GUIDANCE } from '../../tui/agent.js'
import {
	NAMZU_DELEGATION_DOCTRINE,
	NAMZU_PLAN_FILE_DOCTRINE,
	NAMZU_PLAN_MODE_DOCTRINE,
	NAMZU_WORKING_DOCTRINE,
} from '../doctrine.js'
import { type EnvironmentFacts, composeEnvironmentPrompt } from '../environment.js'
import { AGENT_LAUNCH_TOOL, FOREGROUND_BASH_DESCRIPTION, NAMZU_IDENTITY } from '../identity.js'

/** Every builtin tool the SDK ships, by the name the model calls it. */
function sdkToolNames(): Set<string> {
	const names = new Set<string>()
	for (const value of Object.values(sdk as Record<string, unknown>)) {
		if (typeof value !== 'object' || value === null) continue
		const tool = value as { name?: unknown; execute?: unknown }
		if (typeof tool.name === 'string' && typeof tool.execute === 'function') names.add(tool.name)
	}
	return names
}

/**
 * Tools the CLI mounts that the SDK does not ship, and the other tool-shaped
 * words the prompts use on purpose: tool-call parameters, an A2A method name
 * and a few commands. A word added here is a decision that it is not a tool.
 */
const NOT_A_SDK_TOOL = new Set<string>([
	AGENT_LAUNCH_TOOL,
	WORKFLOW_TOOL_NAME,
	EXIT_PLAN_MODE_TOOL_NAME,
	'ask_user_question',
	'task_create',
	'task_update',
	'search_tools',
	'save_memory',
	'search_memory',
	'computer_use',
	// parameters and methods
	'tasks/send',
	'dangerously_disable_sandbox',
	'run_in_background',
	'subagent_type',
	'window_id',
	'wslpath',
	'user.name',
	'user.email',
	'cmd.exe',
	'powershell.exe',
	'explorer.exe',
])

const TOOL_SHAPED = /^[a-z][a-z0-9]*([_.][a-z0-9]+)+$/

const FACTS: EnvironmentFacts = { today: '2026-10-26', branch: 'main', isRepository: true }

function environments(): readonly string[] {
	return [
		composeEnvironmentPrompt(FACTS),
		composeEnvironmentPrompt({ ...FACTS, boundary: { escape: 'ask', interactive: true } }),
		composeEnvironmentPrompt({ ...FACTS, boundary: { escape: 'refused', interactive: false } }),
		composeEnvironmentPrompt({
			...FACTS,
			boundary: {
				sandbox: { environment: 'linux-bwrap', enforced: ['filesystem', 'network'] },
				escape: 'ask',
				interactive: true,
			},
			wsl: { distro: 'Ubuntu', interop: true, drives: ['/mnt/c'] },
		}),
	]
}

const join = (parts: readonly string[]): string => parts.join('\n\n')

function assembled(): ReadonlyArray<readonly [string, string]> {
	const common = [
		NAMZU_IDENTITY,
		NAMZU_WORKING_DOCTRINE,
		NAMZU_DELEGATION_DOCTRINE,
		WORKFLOW_DOCTRINE,
		CONVERSATION_EVIDENCE_GUIDANCE,
		DEFERRED_TOOL_GUIDANCE,
	]
	const out: Array<readonly [string, string]> = []
	for (const [i, env] of environments().entries()) {
		out.push([`main ${i}`, join([...common, env])])
		out.push([`plan (file) ${i}`, join([...common, NAMZU_PLAN_FILE_DOCTRINE, env])])
		out.push([`plan (reply) ${i}`, join([...common, NAMZU_PLAN_MODE_DOCTRINE, env])])
		out.push([`sub-agent ${i}`, join([SUBAGENT_PROMPT, env])])
		out.push([`explore ${i}`, join([EXPLORE_PROMPT, env])])
	}
	out.push(['foreground shell description', FOREGROUND_BASH_DESCRIPTION])
	return out
}

describe('the assembled prompts', () => {
	const known = new Set([...sdkToolNames(), ...NOT_A_SDK_TOOL])

	it('has a roster to check against', () => {
		for (const name of ['bash', 'read', 'write', 'edit', 'glob', 'grep']) {
			expect(known.has(name), name).toBe(true)
		}
	})

	it.each(assembled())('%s: every tool-shaped token is a tool that can be mounted', (_n, text) => {
		const tokens = [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1] ?? '')
		const unknown = tokens.filter((t) => TOOL_SHAPED.test(t) && !known.has(t))
		expect(unknown).toEqual([])
	})

	it.each(assembled())('%s: every tool name is spelled exactly as mounted', (_n, text) => {
		// A right name in the wrong case (`Bash`, `Task`) or a one-word alias
		// (`shell`) is the same mistake as `bash.run`, and has no `_` or `.` to
		// give it away.
		const exact = new Set(known)
		const lower = new Map([...exact].map((n) => [n.toLowerCase(), n]))
		const tokens = [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1] ?? '')
		const miscased = tokens.filter((t) => !exact.has(t) && lower.has(t.toLowerCase()))
		const aliases = tokens.filter((t) => ['shell', 'task', 'terminal'].includes(t.toLowerCase()))
		expect([...miscased, ...aliases]).toEqual([])
	})

	it.each(assembled())('%s: Namzu is the only agent it names', (_n, text) => {
		const identities = [...text.matchAll(/\bYou are (?:an? |the )?([A-Z][\w-]*)/g)].map((m) => m[1])
		expect(identities.filter((w) => w !== 'Namzu' && w !== 'In')).toEqual([])
	})

	it.each(assembled())('%s: never tells the person to start over', (_n, text) => {
		expect(text).not.toMatch(
			/start (over|fresh|a new (session|conversation|chat))|\/new\b|\/clear\b/i,
		)
	})

	it('calls Namzu an AI kernel', () => {
		expect(NAMZU_IDENTITY).toContain('Namzu is an AI kernel exposed through a TypeScript SDK')
		for (const [, text] of assembled()) expect(text).not.toMatch(/agent kernel/i)
	})

	it('points at the shell tool by its real name', () => {
		expect(NAMZU_IDENTITY).toContain(`\`${sdk.BashTool.name}\``)
		expect(NAMZU_IDENTITY).not.toContain('bash.run')
	})

	it('says one thing about running shell commands in parallel', () => {
		// The identity and the shell tool's own description both speak to it, so
		// neither may send delegation through a sub-agent as a way to get parallel
		// shell commands, and both keep the rule against claiming concurrency.
		expect(FOREGROUND_BASH_DESCRIPTION).not.toContain(AGENT_LAUNCH_TOOL)
		expect(NAMZU_IDENTITY).not.toMatch(/delegate genuinely independent work/i)
		expect(NAMZU_IDENTITY).toContain('timestamped proof of overlap')
	})

	it('tells a sub-agent what to do with the ask and stop rules it inherits, after them', () => {
		// The working rules say to stop and ask in several places. A sub-agent has
		// no one to ask, so the prompt says what to do instead, and says it last so
		// it governs the rules above it. It must not forbid questions in a way that
		// leaves the inherited rules unanswered.
		const at = SUBAGENT_PROMPT.indexOf('You have no one to ask')
		expect(at).toBeGreaterThan(SUBAGENT_PROMPT.indexOf(NAMZU_WORKING_DOCTRINE))
		expect(SUBAGENT_PROMPT.slice(at)).toMatch(/name the blocker or the assumption/)
		expect(SUBAGENT_PROMPT).not.toMatch(/do not ask the parent questions/i)
	})
})

/**
 * The reminders are model-facing text too, and a prompt-level reminder reaches
 * a model at the edge of its context, where emphasis is easiest to overdo. Each
 * is read here the way the model reads it: framed, in the words a person set.
 */
describe('the reminder texts', () => {
	const PLAN = '/home/u/.namzu/plans/plan.md'

	function reminders(): ReadonlyArray<readonly [string, string]> {
		const out: Array<readonly [string, string]> = []
		for (const planExists of [false, true]) {
			for (const canAsk of [false, true]) {
				const input = {
					messages: [createUserMessage('go')],
					mode: 'plan',
					planPath: PLAN,
					planExists,
					canAsk,
				}
				for (const text of planModeReminders(input))
					out.push([`plan full (${planExists}, ${canAsk})`, text])
				// The short form, the exit note and the re-entry note.
				const first = planModeReminders(input)
				const history = [
					createUserMessage('one'),
					...first.map((text) => createRuntimeContextMessage(text, 'reminder')),
					createUserMessage('two'),
				]
				for (const text of planModeReminders({ ...input, messages: history, mode: 'prompt' }))
					out.push([`plan exit (${planExists}, ${canAsk})`, text])
				const exited = [
					...history,
					...planModeReminders({ ...input, messages: history, mode: 'prompt' }).map((text) =>
						createRuntimeContextMessage(text, 'reminder'),
					),
				]
				for (const text of planModeReminders({ ...input, messages: exited, planExists: true }))
					out.push([`plan re-entry (${canAsk})`, text])
			}
		}
		const sparseSource = [createUserMessage('go')]
		for (let turn = 0; turn < 6; turn++) {
			for (const text of planModeReminders({
				messages: sparseSource,
				mode: 'plan',
				planPath: PLAN,
				planExists: false,
				canAsk: true,
			}))
				sparseSource.push(createRuntimeContextMessage(text, 'reminder'))
			sparseSource.push(createUserMessage(`turn ${turn}`))
		}
		for (const text of planModeReminders({
			messages: sparseSource,
			mode: 'plan',
			planPath: PLAN,
			planExists: false,
			canAsk: true,
		}))
			out.push(['plan sparse', text])
		for (const mode of ['auto', 'accept-edits', 'bypass'] as const) {
			for (const text of modeReminders({ messages: [], mode, interactive: true }))
				out.push([`mode ${mode}`, text])
		}
		for (const toolListed of [false, true]) {
			for (const text of hypermodeReminders({ messages: [], on: true, toolListed }))
				out.push([`hypermode (${toolListed})`, text])
		}
		return out
	}

	const known = new Set([...sdkToolNames(), ...NOT_A_SDK_TOOL])

	it('has reminders to read', () => {
		expect(reminders().length).toBeGreaterThan(10)
	})

	it.each(reminders())('%s: never tells anyone to start over', (_name, text) => {
		expect(text).not.toMatch(
			/start (over|fresh|a new (session|conversation|chat))|\/new\b|\/clear\b/i,
		)
	})

	it.each(reminders())('%s: uses ordinary emphasis, with no capitals stacks', (_name, text) => {
		// A word of four or more capital letters is shouting; the tag attributes are lowercase.
		expect(text.match(/\b[A-Z]{4,}\b/g) ?? []).toEqual([])
	})

	it.each(reminders())('%s: ranks nothing above every other instruction', (_name, text) => {
		// Project rules never outrank the safety and permission rules, so a reminder
		// that claims to beat every instruction contradicts the order the prompt sets.
		expect(text).not.toMatch(/overrides? (every|all) other|above (every|all) other|no matter what/i)
	})

	it.each(reminders())('%s: every tool it names is in backticks and mounted', (_name, text) => {
		const named = [...text.matchAll(/\b(exit_plan_mode|ask_user_question)\b/g)].map((m) => m[1])
		for (const name of named) expect(text).toContain(`\`${name}\``)
		const tokens = [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1] ?? '')
		expect(tokens.filter((t) => TOOL_SHAPED.test(t) && !known.has(t))).toEqual([])
	})

	it('gives the plan reminder its reason', () => {
		const [full] = planModeReminders({
			messages: [createUserMessage('go')],
			mode: 'plan',
			planPath: PLAN,
			planExists: false,
			canAsk: true,
		})
		expect(full).toContain('so the user can review the plan before anything changes')
		expect(full).toContain('cannot be answered in the approval screen')
	})
})
