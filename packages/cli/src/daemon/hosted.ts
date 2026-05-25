/**
 * Daemon-hosted agent sessions: the daemon runs the actual agent loop and
 * keeps an append-only event log per session, so a TUI in any terminal can
 * attach — replay the log, then stream new events — and send input. This is
 * what makes cross-terminal switching real: the session lives in the daemon,
 * not in any one terminal.
 *
 * The agent config (provider, tools, sub-agents) is built once and shared;
 * each hosted session is a conversation (its own history + event log).
 */

import { type Message, createAssistantMessage, createUserMessage } from '@namzu/sdk'

import type { Preferences } from '../integrations/providers/index.js'
import {
	type AgentEvent,
	type AgentSession,
	createAgentSession,
	probeAgentSession,
} from '../tui/agent.js'

/** One logged event plus its sequence number (clients poll `since=seq`). */
export interface LoggedEvent {
	readonly seq: number
	readonly event: AgentEvent
}

type HostedState = 'idle' | 'thinking' | 'tool' | 'awaiting-permission' | 'error'

interface HostedSession {
	readonly id: string
	title: string
	readonly cwd: string
	readonly history: Message[]
	readonly log: AgentEvent[]
	state: HostedState
	running: boolean
}

export interface HostedView {
	readonly id: string
	readonly title: string
	readonly cwd: string
	readonly state: HostedState
	readonly running: boolean
	readonly seq: number
}

export class HostedSessionManager {
	private agent: AgentSession | null = null
	private agentInit: Promise<AgentSession | null> | null = null
	private sessions = new Map<string, HostedSession>()
	private seq = 0

	/** Build the shared agent config once (provider discovery + tools). */
	private async getAgent(): Promise<AgentSession | null> {
		if (this.agent) return this.agent
		if (!this.agentInit) {
			this.agentInit = (async () => {
				const probe = await probeAgentSession()
				const prefs: Preferences | null =
					probe.preferences ??
					(probe.detected[0]
						? { version: 2, provider: probe.detected[0].entry.id, subagents: { active: [] } }
						: null)
				if (!prefs) return null
				const s = await createAgentSession(prefs, probe.detected)
				this.agent = s.hasProvider ? s : null
				return this.agent
			})()
		}
		return this.agentInit
	}

	create(input: { title?: string; cwd: string }): HostedView {
		const id = `host_${Date.now().toString(36)}_${(this.seq++).toString(36)}`
		const s: HostedSession = {
			id,
			title: input.title ?? 'hosted session',
			cwd: input.cwd,
			history: [],
			log: [],
			state: 'idle',
			running: false,
		}
		this.sessions.set(id, s)
		return view(s)
	}

	get(id: string): HostedSession | undefined {
		return this.sessions.get(id)
	}

	list(): HostedView[] {
		return [...this.sessions.values()].map(view)
	}

	/** Events at or after `since` (clients poll for the tail). */
	eventsSince(
		id: string,
		since: number,
	): { events: LoggedEvent[]; seq: number; state: HostedState } {
		const s = this.sessions.get(id)
		if (!s) return { events: [], seq: 0, state: 'idle' }
		const start = Math.max(0, since)
		const events: LoggedEvent[] = []
		for (let i = start; i < s.log.length; i++) {
			events.push({ seq: i + 1, event: s.log[i] as AgentEvent })
		}
		return { events, seq: s.log.length, state: s.state }
	}

	/**
	 * Run one user turn in the hosted session, appending every event to its
	 * log. Returns false if the session is missing, busy, or the agent has no
	 * provider. Runs to completion (caller awaits or fires-and-forgets).
	 */
	async runMessage(id: string, text: string): Promise<boolean> {
		const s = this.sessions.get(id)
		if (!s || s.running) return false
		const agent = await this.getAgent()
		if (!agent) return false
		s.running = true
		s.state = 'thinking'
		const userMsg = createUserMessage(text)
		// Log the user input as a delta-less marker the client can render.
		s.log.push({ kind: 'delta', text: '' })
		let assistantText = ''
		try {
			for await (const ev of agent.send([...s.history, userMsg])) {
				s.log.push(ev)
				if (ev.kind === 'delta') assistantText += ev.text
				else if (ev.kind === 'tool-start') s.state = 'tool'
				else if (ev.kind === 'tool-end') s.state = 'thinking'
				else if (ev.kind === 'error') s.state = 'error'
			}
		} catch (err) {
			s.log.push({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
			s.state = 'error'
		}
		s.history.push(userMsg, createAssistantMessage(assistantText))
		s.running = false
		if (s.state !== 'error') s.state = 'idle'
		return true
	}
}

function view(s: HostedSession): HostedView {
	return {
		id: s.id,
		title: s.title,
		cwd: s.cwd,
		state: s.state,
		running: s.running,
		seq: s.log.length,
	}
}
