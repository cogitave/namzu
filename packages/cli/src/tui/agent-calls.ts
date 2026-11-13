/**
 * The calls a delegated agent made, as plain rows.
 *
 * Two views read them: the live group under a waited-on agent (its last three
 * calls) and the detail of a finished agent's row (every call the monitor
 * still holds). Both come from the agent's retained transcript, so a call
 * appears here only while the transcript keeps it; the counts say how many
 * were dropped. Pure so the wording is tested without an App.
 */

import type { SubagentActivity } from '../integrations/subagents/activity.js'
import { scriptText } from './terminal-display.js'

/** How many calls the live group shows under one agent. */
export const LIVE_CALL_ROWS = 3

/** Widest a call is drawn in a row, in code units, before the row's own truncation. */
const CALL_TEXT_MAX = 160

export type CallState = 'running' | 'done' | 'failed'

export interface AgentCall {
	readonly state: CallState
	/** `Read src/a.ts`: the tool in plain words and what it acts on. */
	readonly text: string
}

/** `◌` is running, `✓` is done and `✗` failed: the marks the agent view uses. */
export function callMark(state: CallState): string {
	return state === 'running' ? '◌' : state === 'failed' ? '✗' : '✓'
}

const PLAIN_VERBS: Readonly<Record<string, string>> = {
	read: 'Read',
	view_image: 'View',
	grep: 'Search',
	glob: 'Find',
	ls: 'List',
	bash: 'Run',
	edit: 'Edit',
	write: 'Write',
	multi_edit: 'Edit',
	web_fetch: 'Fetch',
	web_search: 'Search the web for',
	agent: 'Delegate',
	todo_write: 'Update the plan',
}

/**
 * `Read(src/a.ts)` as `Read src/a.ts`, `Bash(npm test)` as `Run npm test`,
 * `mcp__docs__lookup(x)` as `docs lookup x`. A name nobody mapped is shown as
 * its own words with the underscores taken out.
 */
export function callWords(label: string): string {
	const text = scriptText(label)
	const open = text.indexOf('(')
	const head = open < 0 ? text : text.slice(0, open)
	const target = open < 0 ? '' : text.slice(open + 1, text.endsWith(')') ? -1 : undefined).trim()
	const key = head.toLowerCase()
	const verb =
		PLAIN_VERBS[key] ??
		(key.startsWith('mcp__') ? key.slice(5).split('__').join(' ') : head.replace(/_/gu, ' '))
	const words = target.length > 0 ? `${verb} ${target}` : verb
	return words.length > CALL_TEXT_MAX ? `${words.slice(0, CALL_TEXT_MAX - 1)}…` : words
}

/** Every call the agent's retained transcript still holds, oldest first. */
export function agentCalls(agent: SubagentActivity): readonly AgentCall[] {
	const calls: AgentCall[] = []
	for (const row of agent.transcript) {
		if (row.kind !== 'tool') continue
		calls.push({
			state: row.status === 'working' ? 'running' : row.status === 'failed' ? 'failed' : 'done',
			text: callWords(row.text),
		})
	}
	return calls
}

/** How many of the agent's calls its transcript no longer holds. */
export function callsNotKept(agent: SubagentActivity, kept: number): number {
	return Math.max(0, (agent.toolCalls ?? 0) - kept)
}

export interface LiveCalls {
	/** `… 5 earlier calls not shown (↓ to manage)`, when there were more than are drawn. */
	readonly earlier?: string
	/** The last calls, newest at the bottom. */
	readonly rows: readonly string[]
}

/**
 * What the live group draws under one running agent: its last
 * {@link LIVE_CALL_ROWS} calls and, above them, how many came before. Undefined
 * before the first call, which keeps the `Initializing…` line.
 */
export function liveCalls(agent: SubagentActivity, manageHint: string): LiveCalls | undefined {
	const kept = agentCalls(agent)
	if (kept.length === 0) return undefined
	const shown = kept.slice(-LIVE_CALL_ROWS)
	const before = Math.max(0, (agent.toolCalls ?? kept.length) - shown.length)
	return {
		...(before > 0
			? {
					earlier: `… ${before} earlier ${before === 1 ? 'call' : 'calls'} not shown (${manageHint})`,
				}
			: {}),
		rows: shown.map((call) => `${callMark(call.state)} ${call.text}`),
	}
}

/**
 * The calls section of a finished agent's detail: one line per call with its
 * outcome mark, how many were not retained, or one line saying the list is
 * gone. Empty when the agent made no call.
 */
export function callDetailLines(agent: SubagentActivity): readonly string[] {
	const total = agent.toolCalls ?? 0
	const kept = agentCalls(agent)
	if (kept.length === 0) {
		return total > 0
			? [
					`This agent made ${total} ${total === 1 ? 'call' : 'calls'}; the list is not available any more.`,
				]
			: []
	}
	const missing = callsNotKept(agent, kept.length)
	return [
		...(missing > 0
			? [`${missing} earlier ${missing === 1 ? 'call is' : 'calls are'} not retained.`]
			: []),
		...kept.map((call) => `${callMark(call.state)} ${call.text}`),
	]
}
