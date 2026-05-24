/**
 * TUI root. Composes Transcript + Composer + StatusBar.
 *
 * State at App-level (single source of truth for M3): messages, history,
 * agent-state. Slash commands and (in Phase C) the agent loop mutate
 * these. Smaller subtrees stay pure.
 *
 * Phase A: echo-only — user submits, message lands as `you:` then we
 * push a placeholder `namzu:` reply so the layout exercises both bubbles.
 * Phase C replaces the echo with a real agent.send() loop.
 */

import { Box, useApp, useInput } from 'ink'
import { useCallback, useRef, useState } from 'react'

import { Composer } from './Composer.js'
import { runSlash, type SlashContext } from './slashCommands.js'
import { StatusBar } from './StatusBar.js'
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
	const exitArmedRef = useRef<boolean>(false)
	const idRef = useRef<number>(0)
	const nextId = useCallback(() => {
		idRef.current += 1
		return `m${idRef.current}`
	}, [])

	const pushMessage = useCallback(
		(role: TranscriptMessage['role'], content: string) => {
			setMessages((prev) => [...prev, { id: nextId(), role, content }])
		},
		[nextId],
	)

	// Slash command context — Phase C will wire real provider + tools data.
	const slashCtx: SlashContext = {
		availableTools: [],
		providerSummary: null,
		modelSummary: null,
	}

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
			pushMessage('user', value)
			// Phase C replaces this echo with a real agent call.
			pushMessage(
				'assistant',
				'(Phase A stub) — chat is wired in Phase C of M3 when the provider profile is loaded.',
			)
		},
		[exit, pushMessage, slashCtx],
	)

	// Ctrl+C: first press arms exit + warns; second press exits.
	useInput(
		(_input, key) => {
			if (key.ctrl && key.return === false && (key as { name?: string }).name === undefined) {
				// no-op: useInput's `key` lacks `name`; fall through for Ctrl+C below
			}
			if (key.ctrl && (_input === 'c' || _input === '\x03')) {
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
			<Transcript messages={messages} />
			<Box flexDirection="column" paddingTop={1}>
				<Composer disabled={state !== 'idle'} onSubmit={handleSubmit} history={history} />
				<Box paddingTop={1}>
					<StatusBar
						cwd={ctx.cwd}
						provider={null}
						model={null}
						state={state}
						hint={state === 'idle' ? undefined : 'agent is working — Ctrl+C to interrupt'}
					/>
				</Box>
			</Box>
		</Box>
	)
}
