import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ACTIVITY_LABELS, type TerminalTabView } from '../shared/terminal-tabs.js'
import { HarnessMark } from './harness-picker.js'
import { TerminalIcon } from './icons.js'
import { isTerminalAppChord } from './terminal-keys.js'
import { pressReturnsKeyboard } from './terminal-pane-focus.js'
import { onTerminalFind } from './terminal-registry.js'
import type { TerminalSession } from './terminal-session.js'
import { Button } from './ui/button.js'
import { WordmarkInitial } from './wordmark.js'
import './terminal-pane.css'

/** The mark of a terminal tab: the engine's own for an engine CLI, a prompt for a shell. */
export function TerminalMark({ tab }: { tab: Pick<TerminalTabView, 'kind' | 'engine'> }) {
	return tab.kind === 'engine' && tab.engine === 'namzu' ? (
		<WordmarkInitial />
	) : tab.kind === 'engine' && tab.engine ? (
		<HarnessMark engine={tab.engine} />
	) : (
		<TerminalIcon aria-hidden="true" />
	)
}

/** The badge an engine tab carries: what its program is doing, from its output and its end. */
export function terminalBadgeLabel(tab: TerminalTabView): string | undefined {
	// A shell has no activity to show, but an ended one reads as ended in the strip and the sidebar.
	if (tab.kind === 'shell') return tab.status === 'running' ? undefined : 'Session ended'
	if (tab.kind !== 'engine' || !tab.activity) return undefined
	if (tab.activity === 'exited')
		return tab.exitCode !== undefined && tab.exitCode !== 0
			? `Exited with code ${tab.exitCode}`
			: ACTIVITY_LABELS.exited
	return ACTIVITY_LABELS[tab.activity]
}

/** The tab's name and what its dot means, in words: the tooltip of a tab and of a sidebar row. */
export function terminalStatusText(tab: TerminalTabView): string {
	const badge = terminalBadgeLabel(tab)
	return badge ? `${tab.title} — ${badge}` : tab.title
}

export function TerminalBadge({ tab }: { tab: TerminalTabView }) {
	const label = terminalBadgeLabel(tab)
	if (!label) return null
	const failed =
		tab.kind === 'engine' &&
		tab.activity === 'exited' &&
		tab.exitCode !== undefined &&
		tab.exitCode !== 0
	return (
		<span
			className="terminal-badge"
			data-activity={tab.kind === 'shell' ? 'exited' : tab.activity}
			data-failed={failed || undefined}
			role="img"
			aria-label={label}
			title={label}
		/>
	)
}

function sessionNotice(tab: TerminalTabView, exitCode: number | undefined): string {
	if (tab.status === 'restored')
		return 'Namzu was closed, so this session ended. Its last screen is shown above.'
	return exitCode === undefined
		? 'This session ended.'
		: exitCode === 0
			? 'This session ended.'
			: `This session ended with code ${exitCode}.`
}

/** Matches in a stronger colour than the selection, the current one stronger still. */
const SEARCH_OPTIONS = {
	decorations: {
		matchBackground: '#7a5c00',
		matchBorder: '#d6a700',
		matchOverviewRuler: '#d6a700',
		activeMatchBackground: '#1f6feb',
		activeMatchBorder: '#79b8ff',
		activeMatchColorOverviewRuler: '#79b8ff',
	},
}

/** A terminal tab's body: the emulator, a slim bar, and a line for whatever the person should know. */
export function TerminalPane({
	tab,
	session,
	focused,
	onClose,
	onRestart,
}: {
	tab: TerminalTabView
	session: TerminalSession
	focused: boolean
	onClose: () => void
	/** Starts the same program again; absent where the tab cannot be restarted. */
	onRestart?: () => void
}) {
	const host = useRef<HTMLDivElement>(null)
	const state = useSyncExternalStore(
		session.subscribe,
		() => session.state,
		() => session.state,
	)
	const [finding, setFinding] = useState(false)
	const [query, setQuery] = useState('')
	const findInput = useRef<HTMLInputElement>(null)

	useEffect(() => {
		const element = host.current
		if (!element) return
		session.mount(element)
		let frame = 0
		const observer = new ResizeObserver(() => {
			cancelAnimationFrame(frame)
			frame = requestAnimationFrame(() => session.refit())
		})
		observer.observe(element)
		return () => {
			cancelAnimationFrame(frame)
			observer.disconnect()
		}
	}, [session])

	useEffect(() => {
		if (focused && !finding) session.focus()
	}, [focused, finding, session])

	useEffect(() => {
		onTerminalFind((tabId) => {
			if (tabId === tab.id) setFinding(true)
		})
		return () => onTerminalFind(undefined)
	}, [tab.id])

	useEffect(() => {
		if (finding) findInput.current?.focus()
	}, [finding])

	const closeFind = () => {
		setFinding(false)
		session.search.clearDecorations()
		session.focus()
	}
	const find = (forward: boolean) => {
		if (!query) return
		if (forward) session.search.findNext(query, SEARCH_OPTIONS)
		else session.search.findPrevious(query, SEARCH_OPTIONS)
	}

	const ended = state.phase === 'ended'
	return (
		<section
			className="terminal-pane"
			aria-label={`${tab.title} terminal`}
			data-terminal-tab={tab.id}
			data-terminal-phase={state.phase}
			data-terminal-status={tab.status}
			// Almost every key belongs to the program in here; only the app's own chord leaves. The
			// emulator has had the key by the time it bubbles here.
			// A click on the pane's own surface (a note, the padding) must not take the keyboard away
			// from the program: only a control or the find box keeps what it was clicked for.
			onMouseDown={(event) => {
				if (pressReturnsKeyboard(event.target as HTMLElement)) {
					event.preventDefault()
					if (!finding) session.focus()
				}
			}}
			// The emulator stops a key it handles from bubbling, so an ended session's own keys are read
			// on the way down, before it can.
			onKeyDownCapture={(event) => {
				if (!ended || finding || event.nativeEvent.isComposing) return
				const bare = !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
				if (!bare || !(event.target as HTMLElement).classList.contains('xterm-helper-textarea'))
					return
				if (event.key === 'Enter') {
					event.preventDefault()
					event.stopPropagation()
					onClose()
				} else if ((event.key === 'r' || event.key === 'R') && onRestart) {
					event.preventDefault()
					event.stopPropagation()
					onRestart()
				}
			}}
			onKeyDown={(event) => {
				// The window's own chords (another terminal, settings, moving between tabs) travel on.
				if (isTerminalAppChord(event.nativeEvent, /Mac/.test(navigator.platform))) return
				event.stopPropagation()
			}}
		>
			<div className="terminal-pane-screen" ref={host} data-terminal-host />
			{finding && (
				<form
					className="terminal-find"
					onSubmit={(event) => {
						event.preventDefault()
						find(true)
					}}
				>
					<input
						ref={findInput}
						type="search"
						aria-label="Find in terminal"
						placeholder="Find"
						value={query}
						onChange={(event) => {
							setQuery(event.target.value)
							if (event.target.value) session.search.findNext(event.target.value, SEARCH_OPTIONS)
						}}
						onKeyDown={(event) => {
							if (event.key === 'Escape') {
								event.preventDefault()
								closeFind()
							} else if (event.key === 'Enter' && event.shiftKey) {
								event.preventDefault()
								find(false)
							}
						}}
					/>
					<Button type="button" variant="ghost-muted" size="xs" onClick={() => find(false)}>
						Previous
					</Button>
					<Button type="submit" variant="ghost-muted" size="xs">
						Next
					</Button>
					<Button type="button" variant="ghost-muted" size="xs" onClick={closeFind}>
						Done
					</Button>
				</form>
			)}
			{/* Announced when the bar opens or closes, since focus moves without a word. */}
			<output className="sr-only" aria-live="polite">
				{finding ? 'Find in terminal. Press Escape to return to the terminal.' : ''}
			</output>
			{state.pendingPaste && (
				<div className="terminal-pane-note" role="alert" data-tone="warning">
					<span>
						Paste {state.pendingPaste.lines} lines? This program does not hold pasted text back, so
						each line runs as soon as it arrives.
					</span>
					<Button type="button" variant="ghost" size="xs" onClick={() => session.answerPaste(true)}>
						Paste
					</Button>
					<Button
						type="button"
						variant="ghost"
						size="xs"
						autoFocus
						onClick={() => session.answerPaste(false)}
					>
						Cancel
					</Button>
				</div>
			)}
			{state.phase === 'failed' && (
				<p className="terminal-pane-note" role="alert" data-tone="error">
					{state.error ?? 'This terminal could not be opened.'}
				</p>
			)}
			{ended && (
				<output className="terminal-pane-note" data-terminal-ended-note>
					<span>
						{sessionNotice(tab, state.exitCode ?? tab.exitCode)}{' '}
						{onRestart ? 'Press Enter to close, or R to restart.' : 'Press Enter to close.'}
					</span>
					<Button type="button" variant="ghost" size="xs" onClick={onClose}>
						Close tab
					</Button>
					{onRestart && (
						<Button type="button" variant="ghost" size="xs" onClick={onRestart}>
							Restart
						</Button>
					)}
				</output>
			)}
			{state.keyboardTaken && !ended && (
				<output className="terminal-pane-note">
					Another window is typing in this terminal.
					<Button type="button" variant="ghost" size="xs" onClick={() => session.takeKeyboard()}>
						Take over
					</Button>
				</output>
			)}
			{state.error && state.phase === 'live' && (
				<p className="terminal-pane-note" role="alert" data-tone="error">
					{state.error}
				</p>
			)}
		</section>
	)
}
