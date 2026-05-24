/**
 * TUI root. Composes the banner, transcript, composer, status bar, and
 * the first-run provider picker overlay.
 *
 * Session lifecycle:
 *   1. Mount → probeAgentSession() (readPreferences + discoverProviders).
 *   2. If a v2 preferences file exists → createAgentSession(prefs, detected) → ready.
 *   3. If preferences missing OR v1 (legacy) → show <Picker/>.
 *      After picker submit, writePreferences + hydrate session.
 *   4. If discovery returned zero providers → show <Picker/> in
 *      empty-state mode (explains where to put credentials).
 */

import type { Message } from '@namzu/sdk'
import { Box, Text, useApp, useInput } from 'ink'
import { useCallback, useEffect, useRef, useState } from 'react'

import {
	type DetectedProvider,
	type Preferences,
	type ProviderId,
	writePreferences,
} from '../integrations/providers/index.js'
import { Composer } from './Composer.js'
import { PermissionOverlay } from './PermissionOverlay.js'
import { Picker } from './Picker.js'
import { StatusBar } from './StatusBar.js'
import { Transcript } from './Transcript.js'
import {
	type AgentSession,
	type PermissionDecision,
	type PermissionRequest,
	createAgentSession,
	probeAgentSession,
} from './agent.js'
import { type SlashContext, runSlash } from './slashCommands.js'
import { theme } from './theme.js'
import type { TranscriptMessage, TuiContext } from './types.js'

export interface AppProps {
	readonly ctx: TuiContext
}

type LifecyclePhase = 'probing' | 'picker' | 'ready' | 'unhealthy'

export function App({ ctx }: AppProps) {
	const { exit } = useApp()
	const [messages, setMessages] = useState<readonly TranscriptMessage[]>([])
	const [history, setHistory] = useState<readonly string[]>([])
	const [state, setState] = useState<'idle' | 'thinking' | 'tool' | 'awaiting-permission'>('idle')
	const [phase, setPhase] = useState<LifecyclePhase>('probing')
	const [session, setSession] = useState<AgentSession | null>(null)
	const [detected, setDetected] = useState<readonly DetectedProvider[]>([])
	const [currentProvider, setCurrentProvider] = useState<ProviderId | null>(null)
	const [permission, setPermission] = useState<PermissionRequest | null>(null)
	const exitArmedRef = useRef<boolean>(false)
	const abortRef = useRef<AbortController | null>(null)
	const permissionResolveRef = useRef<((d: PermissionDecision) => void) | null>(null)
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
		setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, content: m.content + delta } : m)))
	}, [])

	const finalizeMessage = useCallback((id: string, finalContent?: string) => {
		setMessages((prev) =>
			prev.map((m) =>
				m.id === id ? { ...m, content: finalContent ?? m.content, pending: false } : m,
			),
		)
	}, [])

	const hydrateSession = useCallback(
		async (prefs: Preferences, detectedNow: readonly DetectedProvider[]) => {
			const s = await createAgentSession(prefs, detectedNow)
			setSession(s)
			setCurrentProvider(prefs.provider)
			if (s.hasProvider) {
				setPhase('ready')
				pushMessage(
					'system',
					`Connected to ${s.providerSummary}${s.modelSummary ? ` · ${s.modelSummary}` : ''}`,
				)
			} else {
				setPhase('unhealthy')
				if (s.errorHint) pushMessage('system', s.errorHint)
			}
		},
		[pushMessage],
	)

	useEffect(() => {
		let cancelled = false
		void (async () => {
			try {
				const probe = await probeAgentSession()
				if (cancelled) return
				setDetected(probe.detected)
				if (probe.needsRepickReason) {
					pushMessage('system', probe.needsRepickReason)
					setPhase('picker')
					return
				}
				if (probe.preferences) {
					await hydrateSession(probe.preferences, probe.detected)
					return
				}
				setPhase('picker')
			} catch (err) {
				if (cancelled) return
				setPhase('unhealthy')
				pushMessage(
					'system',
					`Failed to probe agents: ${err instanceof Error ? err.message : String(err)}`,
				)
			}
		})()
		return () => {
			cancelled = true
		}
	}, [hydrateSession, pushMessage])

	const slashCtx: SlashContext = {
		availableTools: session?.toolNames ?? [],
		providerSummary: session?.providerSummary ?? null,
		modelSummary: session?.modelSummary ?? null,
	}

	// Resolve a pending permission prompt with the user's decision and tear
	// down the overlay. No-op if nothing is pending.
	const resolvePermission = useCallback((decision: PermissionDecision) => {
		const resolve = permissionResolveRef.current
		permissionResolveRef.current = null
		setPermission(null)
		if (resolve) resolve(decision)
	}, [])

	// Bridge passed into session.send(): the agent calls this before a
	// non-read-only tool batch; it parks until the user presses y/n/a.
	const onPermission = useCallback(
		(req: PermissionRequest) =>
			new Promise<PermissionDecision>((resolve) => {
				permissionResolveRef.current = resolve
				setPermission(req)
				setState('awaiting-permission')
			}),
		[],
	)

	const runTurn = useCallback(
		async (text: string) => {
			if (!session || !session.hasProvider) {
				pushMessage('system', session?.errorHint ?? 'Agent is not ready yet — give it a moment.')
				return
			}
			const priorForSdk: Message[] = messages
				.filter((m) => (m.role === 'user' || m.role === 'assistant') && !m.pending)
				.map((m) => ({
					role: m.role as 'user' | 'assistant',
					content: m.content,
					timestamp: Date.now(),
				}))
			priorForSdk.push({ role: 'user', content: text, timestamp: Date.now() })

			pushMessage('user', text)
			setState('thinking')
			// The model interleaves text → tool → text across iterations.
			// Track the current assistant bubble and finalize it at each tool
			// boundary so later text renders below the tool line, in order.
			let assistantId: string | null = null
			const ensureAssistant = () => {
				if (!assistantId) assistantId = pushMessage('assistant', '', true)
				return assistantId
			}
			const closeAssistant = () => {
				if (assistantId) {
					finalizeMessage(assistantId)
					assistantId = null
				}
			}
			const ac = new AbortController()
			abortRef.current = ac
			try {
				for await (const event of session.send(priorForSdk, {
					signal: ac.signal,
					onPermission,
				})) {
					switch (event.kind) {
						case 'delta':
							setState('thinking')
							appendToMessage(ensureAssistant(), event.text)
							break
						case 'tool-start':
							closeAssistant()
							setState('tool')
							pushMessage('tool', `${event.toolName} › ${event.summary}`)
							break
						case 'tool-end':
							if (event.isError) {
								pushMessage('system', `${event.toolName} failed: ${event.summary}`)
							}
							setState('thinking')
							break
						case 'done':
							closeAssistant()
							break
						case 'error':
							closeAssistant()
							pushMessage('system', `Error: ${event.message}`)
							break
					}
				}
			} catch (err) {
				closeAssistant()
				pushMessage('system', `Error: ${err instanceof Error ? err.message : String(err)}`)
			} finally {
				abortRef.current = null
				permissionResolveRef.current = null
				setPermission(null)
				setState('idle')
			}
		},
		[appendToMessage, finalizeMessage, messages, onPermission, pushMessage, session],
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
					case 'repick':
						setPhase('picker')
						return
					case 'none':
						return
				}
			}
			void runTurn(value)
		},
		[exit, pushMessage, runTurn, slashCtx],
	)

	const handlePickerSubmit = useCallback(
		(selection: { provider: string; model?: string }) => {
			const prefs: Preferences = {
				version: 2,
				provider: selection.provider as ProviderId,
				model: selection.model,
				subagents: { active: [] },
			}
			try {
				writePreferences(prefs)
			} catch (err) {
				pushMessage(
					'system',
					`Could not save preferences: ${err instanceof Error ? err.message : String(err)}`,
				)
				return
			}
			void hydrateSession(prefs, detected)
		},
		[detected, hydrateSession, pushMessage],
	)

	const handlePickerCancel = useCallback(() => {
		setPhase('unhealthy')
		pushMessage(
			'system',
			'Picker cancelled. Set an LLM credential (ANTHROPIC_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY / start Ollama) and restart namzu.',
		)
	}, [pushMessage])

	useInput(
		(input, key) => {
			// A pending permission prompt owns the keyboard: y/n/a decide it.
			if (permissionResolveRef.current) {
				const ch = input.toLowerCase()
				if (key.ctrl && (input === 'c' || input === '\x03')) {
					resolvePermission({ kind: 'reject', feedback: 'User interrupted.' })
					abortRef.current?.abort()
					return
				}
				if (ch === 'y' || key.return) resolvePermission({ kind: 'approve' })
				else if (ch === 'a') resolvePermission({ kind: 'approve-all' })
				else if (ch === 'n' || key.escape) resolvePermission({ kind: 'reject' })
				return
			}
			if (key.ctrl && (input === 'c' || input === '\x03')) {
				// A turn is running → first Ctrl+C interrupts it, not exits.
				if (abortRef.current) {
					abortRef.current.abort()
					pushMessage('system', 'Interrupted.')
					return
				}
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
		{ isActive: phase !== 'picker' },
	)

	return (
		<Box flexDirection="column">
			<Banner version={ctx.version} session={session} />
			<Box flexDirection="column" paddingX={1}>
				{phase === 'picker' ? (
					<Picker
						detected={detected}
						currentProvider={currentProvider}
						onSubmit={handlePickerSubmit}
						onCancel={handlePickerCancel}
					/>
				) : (
					<>
						<TranscriptFrame>
							<Transcript messages={messages} state={state} />
						</TranscriptFrame>
						{permission ? (
							<PermissionOverlay toolCalls={permission.toolCalls} />
						) : (
							<ComposerFrame focus={state === 'idle' && phase === 'ready'}>
								<Composer
									disabled={state !== 'idle' || phase !== 'ready'}
									onSubmit={handleSubmit}
									history={history}
								/>
							</ComposerFrame>
						)}
					</>
				)}
				<Box paddingTop={1}>
					<StatusBar
						cwd={ctx.cwd}
						provider={session?.providerSummary ?? null}
						model={session?.modelSummary ?? null}
						state={state}
						hint={hintForPhase(phase, state)}
					/>
				</Box>
			</Box>
		</Box>
	)
}

function Banner({
	version,
	session,
}: {
	readonly version: string
	readonly session: AgentSession | null
}) {
	const tag = session?.providerSummary ? ` · ${session.providerSummary}` : ''
	return (
		<Box paddingX={1} paddingTop={1} paddingBottom={1}>
			<Text color={theme.accent.system} bold>
				▲ namzu
			</Text>
			<Text color={theme.text.muted}> {version}</Text>
			<Text color={theme.text.secondary}>{tag}</Text>
		</Box>
	)
}

function TranscriptFrame({ children }: { readonly children: React.ReactNode }) {
	return (
		<Box flexDirection="column" borderStyle="round" borderColor={theme.border.default} paddingX={1}>
			{children}
		</Box>
	)
}

function ComposerFrame({
	focus,
	children,
}: {
	readonly focus: boolean
	readonly children: React.ReactNode
}) {
	return (
		<Box
			flexDirection="column"
			borderStyle="round"
			borderColor={focus ? theme.border.focus : theme.border.default}
			paddingX={1}
			marginTop={1}
		>
			{children}
		</Box>
	)
}

function hintForPhase(
	phase: LifecyclePhase,
	state: 'idle' | 'thinking' | 'tool' | 'awaiting-permission',
): string {
	if (phase === 'probing') return 'discovering providers…'
	if (phase === 'picker') return '↑↓ navigate · enter accept · esc cancel'
	if (phase === 'unhealthy') return 'Ctrl+C ×2 to exit'
	if (state === 'awaiting-permission') return 'y approve · n reject · a approve all'
	if (state !== 'idle') return 'agent is working — Ctrl+C to interrupt'
	return '/help · /model · /quit · Ctrl+C ×2 to exit'
}
