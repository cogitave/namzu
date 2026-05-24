/**
 * TUI root. Composes Transcript + Composer + StatusBar and drives the
 * agent loop (M3 Phase C). State at App-level: messages, history,
 * agent-state, agent session. Smaller subtrees stay pure.
 */

import type { Message } from '@namzu/sdk'
import { Box, Text, useApp, useInput } from 'ink'
import { useCallback, useEffect, useRef, useState } from 'react'

import { type AgentSession, createAgentSession } from './agent.js'
import { Composer } from './Composer.js'
import { runSlash, type SlashContext } from './slashCommands.js'
import { StatusBar } from './StatusBar.js'
import { theme } from './theme.js'
import { Transcript } from './Transcript.js'
import type { TranscriptMessage, TuiContext } from './types.js'

export interface AppProps {
	readonly ctx: TuiContext
}

export function App({ ctx }: AppProps) {
	const { exit } = useApp()
	const [messages, setMessages] = useState<readonly TranscriptMessage[]>([])
	const [history, setHistory] = useState<readonly string[]>([])
	const [state, setState] = useState<'idle' | 'thinking' | 'tool' | 'awaiting-permission'>('idle')
	const [session, setSession] = useState<AgentSession | null>(null)
	const exitArmedRef = useRef<boolean>(false)
	const idRef = useRef<number>(0)
	const nextId = useCallback(() => {
		idRef.current += 1
		return `m${idRef.current}`
	}, [])

	const pushMessage = useCallback(
		(role: TranscriptMessage['role'], content: string, pending = false) => {
			const id = nextId()
			setMessages((prev) => [...prev, { id, role, content, pending }])
			return id
		},
		[nextId],
	)

	const appendToMessage = useCallback((id: string, delta: string) => {
		setMessages((prev) =>
			prev.map((m) => (m.id === id ? { ...m, content: m.content + delta } : m)),
		)
	}, [])

	const finalizeMessage = useCallback((id: string, finalContent?: string) => {
		setMessages((prev) =>
			prev.map((m) =>
				m.id === id
					? { ...m, content: finalContent ?? m.content, pending: false }
					: m,
			),
		)
	}, [])

	// Bootstrap the agent session on first render. `createAgentSession()` is
	// sync but we still call it inside an effect to avoid blocking the very
	// first paint.
	useEffect(() => {
		try {
			const s = createAgentSession()
			setSession(s)
			if (!s.hasProvider && s.errorHint) {
				pushMessage('system', s.errorHint)
			} else {
				pushMessage(
					'system',
					`Connected to ${s.providerSummary}${s.modelSummary ? ` · ${s.modelSummary}` : ''}.`,
				)
			}
		} catch (err) {
			pushMessage(
				'system',
				`Failed to start agent: ${err instanceof Error ? err.message : String(err)}`,
			)
		}
	}, [pushMessage])

	const slashCtx: SlashContext = {
		availableTools: [], // wired in Phase D
		providerSummary: session?.providerSummary ?? null,
		modelSummary: session?.modelSummary ?? null,
	}

	const runTurn = useCallback(
		async (text: string) => {
			if (!session || !session.hasProvider) {
				pushMessage(
					'system',
					session?.errorHint ?? 'Agent is not ready yet — give it a moment.',
				)
				return
			}
			// Build the SDK message array from the transcript snapshot at the
			// time of submission. `messages` is the closure value (last render);
			// pushMessage queues a state update that lands on the next render,
			// so it isn't visible to this snapshot — that's why we append the
			// new user message explicitly to the SDK payload.
			const priorForSdk: Message[] = messages
				.filter((m) => (m.role === 'user' || m.role === 'assistant') && !m.pending)
				.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content, timestamp: Date.now() }))
			priorForSdk.push({ role: 'user', content: text, timestamp: Date.now() })

			pushMessage('user', text)
			const assistantId = pushMessage('assistant', '', true)
			setState('thinking')
			try {
				for await (const event of session.send(priorForSdk)) {
					if (event.kind === 'delta') {
						appendToMessage(assistantId, event.text)
					} else if (event.kind === 'done') {
						finalizeMessage(assistantId)
					} else if (event.kind === 'error') {
						finalizeMessage(assistantId)
						pushMessage('system', `Error: ${event.message}`)
					}
				}
			} catch (err) {
				finalizeMessage(assistantId)
				pushMessage(
					'system',
					`Error: ${err instanceof Error ? err.message : String(err)}`,
				)
			} finally {
				setState('idle')
			}
		},
		[appendToMessage, finalizeMessage, messages, pushMessage, session],
	)

	const handleSubmit = useCallback(
		(value: string) => {
			setHistory((prev) => [...prev, value])
			const slash = runSlash(value, slashCtx)
			if (slash) {
				switch (slash.kind) {
					case 'message':
						pushMessage(slash.role, slash.content)
						return
					case 'clear':
						setMessages([])
						return
					case 'exit':
						exit()
						return
					case 'none':
						return
				}
			}
			void runTurn(value)
		},
		[exit, pushMessage, runTurn, slashCtx],
	)

	// Ctrl+C: first press arms exit + warns; second press exits. Ink's
	// `useInput` reports Ctrl+C as the literal `\x03` char with `key.ctrl`.
	useInput(
		(input, key) => {
			if (key.ctrl && (input === 'c' || input === '\x03')) {
				if (exitArmedRef.current) {
					exit()
					return
				}
				exitArmedRef.current = true
				pushMessage('system', 'Press Ctrl+C again to exit.')
				setTimeout(() => {
					exitArmedRef.current = false
				}, 2000)
			}
		},
		{ isActive: true },
	)

	return (
		<Box flexDirection="column" paddingX={1}>
			<Box flexDirection="column" paddingTop={1}>
				<Text color={theme.accent.system} bold>
					namzu {ctx.version}
				</Text>
			</Box>
			<Box flexDirection="column" paddingTop={1}>
				<Transcript messages={messages} />
			</Box>
			<Box flexDirection="column" paddingTop={1}>
				<Composer
					disabled={state !== 'idle'}
					onSubmit={handleSubmit}
					history={history}
				/>
				<Box paddingTop={1}>
					<StatusBar
						cwd={ctx.cwd}
						provider={session?.providerSummary ?? null}
						model={session?.modelSummary ?? null}
						state={state}
						hint={
							state === 'idle'
								? '/help · /quit · Ctrl+C ×2 to exit'
								: 'agent is working — Ctrl+C to interrupt'
						}
					/>
				</Box>
			</Box>
		</Box>
	)
}
