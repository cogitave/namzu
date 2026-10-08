import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
	ACTIVITY_LABELS,
	TERMINAL_ENGINE_LABELS,
	type TerminalTabView,
} from '../shared/terminal-tabs.js'
import { HarnessMark } from './harness-picker.js'
import { SearchIcon, TerminalIcon, XIcon } from './icons.js'
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
	if (tab.kind !== 'engine' || !tab.activity) return undefined
	if (tab.activity === 'exited')
		return tab.exitCode !== undefined && tab.exitCode !== 0
			? `Exited with code ${tab.exitCode}`
			: ACTIVITY_LABELS.exited
	return ACTIVITY_LABELS[tab.activity]
}

export function TerminalBadge({ tab }: { tab: TerminalTabView }) {
	const label = terminalBadgeLabel(tab)
	if (!label) return null
	const failed = tab.activity === 'exited' && tab.exitCode !== undefined && tab.exitCode !== 0
	return (
		<span
			className="terminal-badge"
			data-activity={tab.activity}
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
}: {
	tab: TerminalTabView
	session: TerminalSession
	focused: boolean
	onClose: () => void
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
	const label =
		tab.kind === 'engine' && tab.engine ? TERMINAL_ENGINE_LABELS[tab.engine] : 'Terminal'
	const badge = terminalBadgeLabel(tab)
	return (
		<section
			className="terminal-pane"
			aria-label={`${tab.title} terminal`}
			data-terminal-tab={tab.id}
			data-terminal-phase={state.phase}
			data-terminal-status={tab.status}
			// Almost every key belongs to the program in here; only the app's own chord leaves. The
			// emulator has had the key by the time it bubbles here.
			onKeyDown={(event) => {
				const native = event.nativeEvent
				if (
					(native.ctrlKey || native.metaKey) &&
					native.shiftKey &&
					(native.code === 'Backquote' || native.key === '`' || native.key === '~')
				)
					return
				event.stopPropagation()
			}}
		>
			<header className="terminal-pane-bar">
				<span className="terminal-pane-mark" aria-hidden="true">
					<TerminalMark tab={tab} />
				</span>
				<span className="terminal-pane-title" title={tab.title}>
					{tab.title}
				</span>
				{tab.kind === 'shell' && <span className="terminal-pane-kind">{label}</span>}
				{badge && (
					<span className="terminal-pane-status" data-activity={tab.activity}>
						<TerminalBadge tab={tab} />
						{badge}
					</span>
				)}
				<span className="terminal-pane-spacer" />
				<Button
					variant="ghost-muted"
					size="icon-xs"
					aria-label="Find in terminal"
					title="Find in terminal"
					onClick={() => setFinding((value) => !value)}
				>
					<SearchIcon />
				</Button>
				<Button
					variant="ghost-muted"
					size="icon-xs"
					aria-label={ended ? 'Close terminal tab' : 'End session and close tab'}
					title={ended ? 'Close tab' : 'End session and close tab'}
					onClick={onClose}
				>
					<XIcon />
				</Button>
			</header>
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
			<div className="terminal-pane-screen" ref={host} data-terminal-host />
			{state.phase === 'failed' && (
				<p className="terminal-pane-note" role="alert" data-tone="error">
					{state.error ?? 'This terminal could not be opened.'}
				</p>
			)}
			{ended && (
				<output className="terminal-pane-note">
					{sessionNotice(tab, state.exitCode ?? tab.exitCode)}
					<Button type="button" variant="ghost" size="xs" onClick={onClose}>
						Close tab
					</Button>
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
