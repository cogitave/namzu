import { useCallback, useEffect, useRef, useState } from 'react'
import type { EngineBrowserView } from '../shared/config-lists-protocol.js'
import type { DesktopApi } from '../shared/protocol.js'
import { catalogueEntry } from '../shared/settings-catalogue.js'
import { plainErrorText } from './plain-error.js'
import { Row } from './settings-row.js'
import { Button } from './ui/button.js'

type Bridge = Pick<DesktopApi, 'engineBrowser' | 'browserPane'>

/** What was last read about the browser the engine drives. */
export interface EngineBrowserRead {
	loading: boolean
	/** Null when this engine cannot say. */
	view?: EngineBrowserView | null
	error?: string
}

/** One line of the table: a browser, how it stands, and what that means. */
export interface ConnectedBrowserLine {
	id: 'built-in' | 'engine'
	name: string
	state: string
	detail: string
}

const STATE_WORDS: Record<EngineBrowserView['state'], string> = {
	ready: 'Ready',
	warning: 'Ready, with a note',
	unavailable: 'Not available',
	off: 'Switched off',
	missing: 'Not installed',
}

/** The table, from what is known. Pure, so the words are tested without a window. */
export function connectedBrowserLines(
	builtIn: boolean,
	engine: EngineBrowserRead,
): ConnectedBrowserLine[] {
	const lines: ConnectedBrowserLine[] = [
		{
			id: 'built-in',
			name: 'Built-in browser',
			state: builtIn ? 'Ready' : 'Not available here',
			detail: builtIn
				? 'Opens beside a conversation for pages Namzu writes and links in replies.'
				: 'This window has no browser pane.',
		},
	]
	let state = 'Checking'
	let detail = 'Looking at this computer.'
	if (!engine.loading && engine.error) {
		state = 'Not known'
		detail = engine.error
	} else if (!engine.loading && engine.view === null) {
		state = 'Not known'
		detail = 'This version of Namzu cannot say which browser it would use.'
	} else if (!engine.loading && engine.view) {
		state = STATE_WORDS[engine.view.state]
		detail = engine.view.text
	}
	lines.push({ id: 'engine', name: 'Browser Namzu drives', state, detail })
	return lines
}

/** Reads which browser the engine would drive; `recheck` asks again. Only the newest answer counts. */
export function useEngineBrowser(bridge: Pick<DesktopApi, 'engineBrowser'> | undefined): {
	read: EngineBrowserRead
	recheck: () => void
} {
	const ask = bridge?.engineBrowser
	const [read, setRead] = useState<EngineBrowserRead>({ loading: Boolean(ask) })
	const latest = useRef(0)
	const live = useRef(true)
	const recheck = useCallback(() => {
		if (!ask) {
			setRead({ loading: false, view: null })
			return
		}
		const mine = ++latest.current
		setRead((current) => ({ ...current, loading: true, error: undefined }))
		ask().then(
			(view) => live.current && latest.current === mine && setRead({ loading: false, view }),
			(failure) =>
				live.current &&
				latest.current === mine &&
				setRead({ loading: false, error: plainErrorText(failure, 'check the browser') }),
		)
	}, [ask])
	useEffect(() => {
		live.current = true
		recheck()
		return () => {
			live.current = false
		}
	}, [recheck])
	return { read, recheck }
}

/** Settings > Tools > Connected browsers: the two browsers Namzu can use, each with its state, and Recheck. */
export function ConnectedBrowsersRow({ bridge }: { bridge: Bridge | undefined }) {
	const { read, recheck } = useEngineBrowser(bridge)
	const entry = catalogueEntry('connected-browsers')
	const lines = connectedBrowserLines(Boolean(bridge?.browserPane), read)
	return (
		<Row
			id="connected-browsers"
			label={entry.label}
			description={entry.description}
			stacked
			below={
				<table className="settings-table" aria-label={entry.label}>
					<thead>
						<tr>
							<th scope="col">Browser</th>
							<th scope="col">State</th>
						</tr>
					</thead>
					<tbody>
						{lines.map((line) => (
							<tr key={line.id} data-browser={line.id}>
								<th scope="row">{line.name}</th>
								<td>
									<span className="settings-table-state">{line.state}</span>
									<span className="settings-note">{line.detail}</span>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			}
		>
			<Button
				type="button"
				variant="outline"
				size="sm"
				disabled={read.loading}
				onClick={recheck}
				aria-label="Recheck connected browsers"
			>
				Recheck
			</Button>
		</Row>
	)
}
