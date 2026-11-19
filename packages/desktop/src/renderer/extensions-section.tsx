import { useEffect, useState } from 'react'
import {
	type ExtensionFailure,
	type ExtensionRow,
	readDisclosure,
	readExtensionRow,
	readFailure,
} from '../shared/extensions-view.js'
import { CollectedPage } from './extension-collected.js'
import {
	AdminDialog,
	type Api,
	Failure,
	InstallDialog,
	KeyDialog,
	LicenceDialog,
	LogDialog,
	MyRecord,
	NoticeScreen,
	type Panel,
	RemoveDialog,
} from './extension-dialogs.js'
import {
	EVENT_HISTORY_SENTENCE,
	EVENT_HISTORY_TITLE,
	EXTENSIONS_EMPTY,
	EXTENSIONS_INTRO,
	backgroundLines,
	formatWhen,
	licenceLines,
	mainAction,
	plainReasons,
	publisherLine,
	stateWord,
} from './extensions-model.js'
import {
	ask,
	openExtensionPage,
	refreshExtensions,
	selectExtension,
	takePanelRequest,
	useExtensionsSnapshot,
} from './extensions-store.js'
import { ArrowLeftIcon, ChevronRightIcon, PlusIcon, PuzzleIcon } from './icons.js'
import { Row, Switch } from './settings-row.js'
import { Button } from './ui/button.js'
import './extensions-section.css'

export const EXTENSIONS_TITLE = 'Extensions'

/** A dot and one word: the extension's state, drawn only here and never in the window's own chrome. */
function StateWord({ row }: { row: ExtensionRow }) {
	const word = stateWord(row)
	return (
		<span className="extension-state" data-tone={word.tone}>
			<span className="extension-dot" aria-hidden="true" />
			{word.text}
		</span>
	)
}

function Tile({ big }: { big?: boolean }) {
	return (
		<span className="extension-tile" data-big={big || undefined} aria-hidden="true">
			<PuzzleIcon />
		</span>
	)
}

/** The list: one row for each extension. The row opens the extension's own screen. */
function ExtensionList({ rows }: { rows: readonly ExtensionRow[] }) {
	return (
		<ul className="extension-list" aria-label="Extensions">
			{rows.map((row) => (
				<li key={row.id}>
					<button
						type="button"
						className="extension-list-row"
						onClick={() => selectExtension(row.id)}
					>
						<Tile />
						<span className="extension-list-name">
							<span className="extension-list-title">{row.name}</span>
							<span className="extension-list-sub">{publisherLine(row)}</span>
						</span>
						<StateWord row={row} />
						<ChevronRightIcon className="extension-chevron" aria-hidden="true" />
					</button>
				</li>
			))}
		</ul>
	)
}

/** A row that opens something: its value, if any, and a chevron button. */
function LinkRow({
	id,
	label,
	description,
	value,
	onOpen,
}: {
	id: string
	label: string
	description?: string
	value?: string
	onOpen: () => void
}) {
	return (
		<Row id={id} label={label} {...(description ? { description } : {})}>
			{value && <span className="settings-value extension-value">{value}</span>}
			<Button variant="ghost-muted" size="icon" aria-label={label} onClick={onOpen}>
				<ChevronRightIcon aria-hidden="true" />
			</Button>
		</Row>
	)
}

/** The sentence under the state word, from the facts only. */
function statusLine(row: ExtensionRow): string {
	if (row.updateWaiting && row.state !== 'failed')
		return `An update asks for more. Review it. ${plainReasons(row.updateWaiting.reasons).join(' ')}`.trim()
	switch (row.state) {
		case 'running':
		case 'license-grace':
			return row.management?.locked
				? 'It is on. Only your administrator can turn it off.'
				: 'It is on. Turn it off to stop it.'
		case 'starting':
			return 'It is starting.'
		case 'not-responding':
			return 'It is not answering. Namzu will try again, or you can turn it off.'
		case 'failed':
			return row.why ?? 'It stopped after repeated failures. Start it again when you are ready.'
		case 'needs-notice':
			return 'Read what it collects and why before it can start.'
		case 'needs-license':
			return row.licenceProblem ?? 'It needs a licence key before it can start.'
		case 'license-expired':
		case 'license-revoked':
			return row.licenceProblem ?? 'Its licence is no longer valid.'
		default:
			return 'It is off. Turn it on to start it.'
	}
}

/** One extension's own screen: the same rows and switches as the rest of Settings. */
function ExtensionScreen({
	api,
	row,
	panel,
	setPanel,
}: {
	api: Api
	row: ExtensionRow
	panel: Panel | undefined
	setPanel: (p: Panel | undefined) => void
}) {
	const [failure, setFailure] = useState<ExtensionFailure | string>()
	const locked = row.management?.locked === true
	const lockNote = locked ? ' Needs the administrator password.' : ''
	const action = mainAction(row)
	const bg = backgroundLines(row)
	const page = row.ui?.pages.find((p) => p.slot === 'settings') ?? row.ui?.pages[0]
	const toggles =
		action.kind === 'enable' || action.kind === 'disable' || action.kind === 'start-again'
	const runAction = async () => {
		setFailure(undefined)
		// A locked extension is turned off with the administrator password; one that declares the lock
		// and has none set yet asks for the password it is turned on with.
		if (action.kind === 'disable' && locked)
			return setPanel({ kind: 'admin', id: row.id, action: 'disable' })
		if (action.kind === 'enable' && row.management && !locked)
			return setPanel({ kind: 'admin', id: row.id, action: 'enable' })
		switch (action.kind) {
			case 'license':
				return setPanel({ kind: 'licence', id: row.id })
			case 'notice':
				return setPanel({ kind: 'notice', id: row.id, staged: false })
			case 'review-update':
				return setPanel({ kind: 'notice', id: row.id, staged: true })
			case 'none':
				return
			default: {
				const method =
					action.kind === 'disable' ? 'namzu/extensions/disable' : 'namzu/extensions/enable'
				const r = await ask(api, method, { id: row.id })
				if (!r.ok && r.failure?.code === 'needs-notice')
					return setPanel({ kind: 'notice', id: row.id, staged: false })
				if (!r.ok) return setFailure(r.failure)
				await refreshExtensions(api)
			}
		}
	}
	const toggleBackground = async (on: boolean) => {
		setFailure(undefined)
		if (!on && locked) return setPanel({ kind: 'admin', id: row.id, action: 'background-off' })
		const r = await ask(api, 'namzu/extensions/background/set', { id: row.id, on })
		if (!r.ok) {
			// Not yet acknowledged: the notice is the place to say yes.
			if (r.failure?.code === 'needs-notice')
				return setPanel({ kind: 'notice', id: row.id, staged: false })
			return setFailure(r.failure)
		}
		await refreshExtensions(api)
	}
	const showLicence =
		row.needs.includes('license') ||
		row.licence !== undefined ||
		row.state === 'license-expired' ||
		row.state === 'license-revoked' ||
		row.licenceKind === 'service' ||
		row.licenceKind === 'key'
	const lines = licenceLines(row)
	const current = panel
	return (
		<div className="extension-screen" data-extension={row.id}>
			<header className="settings-page-header extension-screen-header">
				<div>
					<h1>
						<Button
							variant="ghost-muted"
							size="icon"
							className="extension-back"
							aria-label="Back to Extensions"
							onClick={() => selectExtension(undefined)}
						>
							<ArrowLeftIcon aria-hidden="true" />
						</Button>
						{row.name}
					</h1>
					<p className="extension-screen-sub">
						{publisherLine(row)}
						{row.dev && (
							<span
								className="settings-row-badge"
								title="Signed with a developer key, not a publisher's."
							>
								Dev key
							</span>
						)}
					</p>
				</div>
			</header>
			<div className="extension-status">
				<Tile big />
				<div>
					<div className="extension-status-word">
						<StateWord row={row} />
					</div>
					<p>{statusLine(row)}</p>
				</div>
				{toggles ? (
					<Switch
						label={row.name}
						checked={action.kind === 'disable'}
						onChange={() => void runAction()}
					/>
				) : action.kind !== 'none' ? (
					<Button onClick={() => void runAction()}>{action.label}</Button>
				) : null}
			</div>
			<Failure failure={failure} />
			{row.management && (
				<>
					<h2 className="settings-section-title">Administrator lock</h2>
					<Row
						id={`extension-${row.id}-lock`}
						label={locked ? 'Locked by your administrator' : 'Not locked yet'}
						description={[
							row.management.purpose,
							locked
								? 'Only the administrator can turn it off, remove it or change its licence.'
								: 'Turning it on asks for an administrator password. After that only the administrator can turn it off.',
							row.management.waitSeconds
								? `A wrong password was just refused. Try again in ${row.management.waitSeconds} ${row.management.waitSeconds === 1 ? 'second' : 'seconds'}.`
								: '',
						]
							.filter(Boolean)
							.join(' ')}
					/>
					{locked && (
						<Row
							id={`extension-${row.id}-unlock`}
							label="Unlock"
							description="Take the lock off with the administrator password. After that anyone can turn it off."
						>
							<Button
								variant="outline"
								size="sm"
								onClick={() => setPanel({ kind: 'admin', id: row.id, action: 'unlock' })}
							>
								Unlock…
							</Button>
						</Row>
					)}
				</>
			)}
			{bg && (
				<>
					<h2 className="settings-section-title">Background</h2>
					<Row
						id={`extension-${row.id}-background`}
						label={bg.switchLabel}
						description={bg.lines.join(' ')}
					>
						<Switch
							label={bg.switchLabel}
							checked={row.background?.enabled === true}
							disabled={!row.enabled}
							onChange={(on) => void toggleBackground(on)}
						/>
					</Row>
				</>
			)}
			<h2 className="settings-section-title">Data</h2>
			{page && (
				<LinkRow
					id={`extension-${row.id}-records`}
					label="Records"
					description="Every record in time order, newest first, with filters and search."
					onOpen={() => openExtensionPage(row.id, page.id, true)}
				/>
			)}
			<LinkRow
				id={`extension-${row.id}-collected`}
				label="What is collected"
				description="What it records on this computer, and how long it keeps it."
				onOpen={() => setPanel({ kind: 'collected', id: row.id })}
			/>
			<h2 className="settings-section-title">Settings</h2>
			<Row
				id={`extension-${row.id}-model-key`}
				label="Model API key"
				description={`A key for a model, entered by hand. Nothing uses it in this version.${lockNote}`}
			>
				<Button variant="outline" size="sm" onClick={() => setPanel({ kind: 'key', id: row.id })}>
					Set…
				</Button>
			</Row>
			{showLicence && (
				<>
					<h2 className="settings-section-title">Licence</h2>
					{row.licence && (
						<>
							<Row id={`extension-${row.id}-holder`} label="Holder">
								<span className="settings-value">{row.licence.customer}</span>
							</Row>
							<Row id={`extension-${row.id}-seats`} label="Seats">
								<span className="settings-value">{row.licence.seats}</span>
							</Row>
							<Row id={`extension-${row.id}-until`} label="Valid until">
								<span className="settings-value">{formatWhen(row.licence.expires)}</span>
							</Row>
						</>
					)}
					<Row
						id={`extension-${row.id}-licence`}
						label="Licence key"
						description={[
							row.licence
								? 'Paste a new key to replace this one.'
								: 'Paste the key you were given.',
							lockNote.trim(),
							...lines.filter((l) => !l.includes(row.licence?.customer ?? '\u0000')),
						].join(' ')}
					>
						<Button
							variant="outline"
							size="sm"
							onClick={() => setPanel({ kind: 'licence', id: row.id })}
						>
							{row.licence ? 'Change licence…' : 'Add a licence…'}
						</Button>
					</Row>
				</>
			)}
			<h2 className="settings-section-title">Notice and my record</h2>
			<Row id={`extension-${row.id}-notice-version`} label="Notice version">
				<span className="settings-value">{row.record?.noticeVersion ?? 'Not read yet'}</span>
			</Row>
			<Row id={`extension-${row.id}-read-on`} label="You read it on">
				<span className="settings-value">
					{row.record ? formatWhen(row.record.acknowledgedAt) : 'Not yet'}
				</span>
			</Row>
			<Row
				id={`extension-${row.id}-notice`}
				label="Read the notice again"
				description="What it collects, who sees it and how long it is kept."
			>
				<Button
					variant="outline"
					size="sm"
					onClick={() => setPanel({ kind: 'notice', id: row.id, staged: false })}
				>
					{row.record ? 'Read again' : 'Read the notice'}
				</Button>
			</Row>
			<h2 className="settings-section-title">{EVENT_HISTORY_TITLE}</h2>
			<LinkRow
				id={`extension-${row.id}-log`}
				label="Open the event history"
				description={EVENT_HISTORY_SENTENCE}
				onOpen={() => setPanel({ kind: 'log', id: row.id })}
			/>
			<h2 className="settings-section-title">Remove</h2>
			<Row
				id={`extension-${row.id}-remove`}
				label={`Remove ${row.name}`}
				description={`Takes it off this computer. You are asked before anything is deleted.${lockNote}`}
			>
				<Button
					variant="destructive-outline"
					size="sm"
					onClick={() => setPanel({ kind: 'remove', id: row.id })}
				>
					Remove…
				</Button>
			</Row>
			{current?.kind === 'record' && (
				<MyRecord
					api={api}
					row={row}
					onClose={() => setPanel(undefined)}
					onReread={() => setPanel({ kind: 'notice', id: row.id, staged: false })}
				/>
			)}
			{current?.kind === 'admin' && (
				<AdminDialog
					api={api}
					row={row}
					action={current.action}
					onClose={() => setPanel(undefined)}
				/>
			)}
			{current?.kind === 'licence' && (
				<LicenceDialog api={api} row={row} onClose={() => setPanel(undefined)} />
			)}
			{current?.kind === 'key' && (
				<KeyDialog api={api} row={row} onClose={() => setPanel(undefined)} />
			)}
			{current?.kind === 'log' && (
				<LogDialog api={api} row={row} onClose={() => setPanel(undefined)} />
			)}
			{current?.kind === 'remove' && (
				<RemoveDialog
					api={api}
					row={row}
					onClose={() => {
						setPanel(undefined)
						selectExtension(undefined)
					}}
				/>
			)}
		</div>
	)
}

const NO_API: Api = {} as Api

/**
 * Settings, Extensions: a row for each extension, and inside a row the extension's own screen. Namzu's
 * own words and Namzu's own rows, switches and buttons throughout; an extension draws only its pages.
 */
export function ExtensionsSection({ api }: { api?: Api | undefined }) {
	const bridge = api ?? NO_API
	const snap = useExtensionsSnapshot()
	const [panel, setPanel] = useState<Panel>()
	const [failure, setFailure] = useState<ExtensionFailure | string>()
	const [adding, setAdding] = useState(false)
	const selected = snap.rows.find((r) => r.id === snap.selected)
	// Another part of the window asked for a dialog on this extension (a page's strip).
	const wanted = snap.panelRequest
	useEffect(() => {
		if (!wanted || wanted.id !== snap.selected) return
		setPanel(
			wanted.kind === 'notice'
				? { kind: 'notice', id: wanted.id, staged: false }
				: { kind: wanted.kind, id: wanted.id },
		)
		takePanelRequest()
	}, [wanted, snap.selected])
	const add = async () => {
		setFailure(undefined)
		setAdding(true)
		try {
			const answer = await bridge.extensionsAddFromFile?.(
				typeof navigator === 'undefined' ? undefined : navigator.language,
			)
			if (answer === null || answer === undefined) return
			const f = readFailure(answer)
			if (f) return setFailure(f)
			const a = answer as {
				view?: unknown
				disclosure?: unknown
				update?: { waiting?: boolean; reasons?: string[] }
			}
			const view = readExtensionRow(a.view)
			const disclosure = readDisclosure(a.disclosure)
			await refreshExtensions(bridge)
			if (view && disclosure)
				setPanel({
					kind: 'install',
					id: view.id,
					disclosure,
					...(a.update
						? {
								update: {
									waiting: a.update.waiting === true,
									reasons: Array.isArray(a.update.reasons)
										? a.update.reasons.filter((x): x is string => typeof x === 'string')
										: [],
								},
							}
						: {}),
				})
		} catch (error) {
			setFailure(error instanceof Error ? error.message : 'Could not add the file.')
		} finally {
			setAdding(false)
		}
	}
	const close = () => {
		setPanel(undefined)
		void refreshExtensions(bridge)
	}
	// The screen of a removed extension is gone; the list takes its place.
	useEffect(() => {
		if (snap.loadedOnce && snap.selected && !selected) selectExtension(undefined)
	}, [snap.loadedOnce, snap.selected, selected])
	if (selected && panel?.kind === 'collected')
		return <CollectedPage api={bridge} row={selected} onBack={() => setPanel(undefined)} />
	if (selected)
		return (
			<>
				<ExtensionScreen
					api={bridge}
					row={selected}
					panel={panel?.kind === 'install' || panel?.kind === 'notice' ? undefined : panel}
					setPanel={setPanel}
				/>
				{panel?.kind === 'notice' && (
					<NoticeScreen
						api={bridge}
						id={panel.id}
						staged={panel.staged}
						setPassword={selected.management?.locked !== true}
						onClose={() => close()}
					/>
				)}
				{panel?.kind === 'install' && (
					<InstallDialog api={bridge} panel={panel} onClose={close} onNext={setPanel} />
				)}
			</>
		)
	return (
		<>
			<header className="settings-page-header">
				<div>
					<h1>{EXTENSIONS_TITLE}</h1>
					<p>{EXTENSIONS_INTRO}</p>
				</div>
				<Button
					variant="outline"
					size="sm"
					className="extension-add"
					onClick={() => void add()}
					disabled={adding}
				>
					<PlusIcon aria-hidden="true" />
					Add from file
				</Button>
			</header>
			<Failure failure={failure ?? snap.error} />
			<div id="setting-extensions-list">
				{snap.supported === false && (
					<p className="extension-empty-line">
						This version of Namzu does not support extensions yet. Update Namzu to use them.
					</p>
				)}
				{snap.supported !== false && snap.rows.length === 0 && snap.loadedOnce && (
					<div className="extension-empty">
						<Tile big />
						<h2>No extensions yet</h2>
						<p>{EXTENSIONS_EMPTY}</p>
					</div>
				)}
				{snap.rows.length > 0 && <ExtensionList rows={snap.rows} />}
			</div>
			{panel?.kind === 'install' && (
				<InstallDialog api={bridge} panel={panel} onClose={close} onNext={setPanel} />
			)}
		</>
	)
}
