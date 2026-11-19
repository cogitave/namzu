import { useEffect, useState } from 'react'
import {
	type ExtensionDisclosure,
	type ExtensionFailure,
	type ExtensionRow,
	readDisclosure,
	readExtensionRow,
	readFailure,
	readNotice,
} from '../shared/extensions-view.js'
import {
	type Api,
	Collected,
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
	EXTENSIONS_EMPTY,
	EXTENSIONS_INTRO,
	backgroundLines,
	clockWords,
	daySummary,
	durationWords,
	formatWhen,
	keptWords,
	licenceLines,
	mainAction,
	neverLine,
	plainReasons,
	publisherLine,
	readDayRows,
	ribbonLayout,
	stateKindOf,
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

/** What the extension recorded today, from its own counts, and drawn only as far as it is understood. */
function useToday(api: Api, row: ExtensionRow) {
	const [summary, setSummary] = useState<ReturnType<typeof daySummary>>()
	useEffect(() => {
		if (!row.running) return setSummary(undefined)
		let live = true
		const read = async () => {
			const counts = await ask(api, 'namzu/extensions/query', { id: row.id, query: 'counts' })
			const kind = counts.ok ? stateKindOf(counts.value) : undefined
			if (!kind) return live && setSummary(undefined)
			const all = await readDayRows(kind, new Date(), async (params) => {
				const r = await ask(api, 'namzu/extensions/query', { id: row.id, query: 'rows', params })
				return r.ok ? r.value : undefined
			})
			if (live && all) setSummary(daySummary(all, new Date()))
		}
		void read()
		const timer = setInterval(() => void read(), 60_000)
		return () => {
			live = false
			clearInterval(timer)
		}
	}, [api, row.id, row.running])
	return summary
}

function TodayGroup({
	api,
	row,
	pageId,
	title,
	onOpen,
}: { api: Api; row: ExtensionRow; pageId: string; title: string; onOpen: () => void }) {
	const day = useToday(api, row)
	const now = new Date()
	const ribbon = day ? ribbonLayout(day.parts, now.getHours() * 60 + now.getMinutes()) : undefined
	const since =
		day?.firstMinute !== undefined
			? `${durationWords(day.atMinutes)} at the computer since ${clockWords(day.firstMinute)}.`
			: undefined
	return (
		<>
			<h2 className="settings-section-title">{title}</h2>
			{day && (
				<div className="extension-today" data-page={pageId}>
					<dl className="extension-totals">
						<div>
							<dt>At the computer</dt>
							<dd>{durationWords(day.atMinutes)}</dd>
						</div>
						<div>
							<dt>Idle</dt>
							<dd>{durationWords(day.idleMinutes)}</dd>
						</div>
						<div>
							<dt>Away</dt>
							<dd>{durationWords(day.awayMinutes)}</dd>
						</div>
					</dl>
					{ribbon && (
						<>
							<div className="extension-ribbon-hold">
								<div className="extension-ribbon" role="img" aria-label="The day so far">
									{ribbon.segments.map((s) => (
										<span
											key={`${s.state}-${s.left}`}
											data-state={s.state}
											style={{ left: `${s.left}%`, width: `${s.width}%` }}
										/>
									))}
								</div>
								<div className="extension-ribbon-now" style={{ left: `${ribbon.now}%` }} />
							</div>
							<div className="extension-ribbon-axis" aria-hidden="true">
								{ribbon.ticks.map((t) => (
									<span key={t.label} style={{ left: `${t.left}%` }}>
										{t.label}
									</span>
								))}
							</div>
						</>
					)}
				</div>
			)}
			<LinkRow
				id={`extension-${row.id}-today`}
				label={`Open ${title.toLowerCase()}`}
				description={since ?? 'The full page, with every app and its time.'}
				onOpen={onOpen}
			/>
		</>
	)
}

/** The sentence under the state word, from the facts only. */
function statusLine(row: ExtensionRow): string {
	if (row.updateWaiting && row.state !== 'failed')
		return `An update asks for more. Review it. ${plainReasons(row.updateWaiting.reasons).join(' ')}`.trim()
	switch (row.state) {
		case 'running':
		case 'license-grace':
			return 'It is on. Turn it off to stop it.'
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

function useDisclosure(api: Api, id: string): ExtensionDisclosure | undefined {
	const [d, setD] = useState<ExtensionDisclosure>()
	useEffect(() => {
		let live = true
		void ask(api, 'namzu/extensions/notice', { id }).then((r) => {
			if (live && r.ok) setD(readNotice(r.value)?.disclosure)
		})
		return () => {
			live = false
		}
	}, [api, id])
	return d
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
	const disclosure = useDisclosure(api, row.id)
	const action = mainAction(row)
	const bg = backgroundLines(row)
	const page = row.ui?.pages.find((p) => p.slot === 'settings') ?? row.ui?.pages[0]
	const toggles =
		action.kind === 'enable' || action.kind === 'disable' || action.kind === 'start-again'
	const runAction = async () => {
		setFailure(undefined)
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
			{page && (
				<TodayGroup
					api={api}
					row={row}
					pageId={page.id}
					title={page.title}
					onOpen={() => openExtensionPage(row.id, page.id, true)}
				/>
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
			<h2 className="settings-section-title">What is collected</h2>
			{disclosure?.dataKinds.map((k) => (
				<Row
					key={k.id}
					id={`extension-${row.id}-kind-${k.id}`}
					label={k.description.replace(/[.]+$/, '')}
				>
					<span className="settings-value extension-value">
						{keptWords(k.retentionDays).replace(/[.]$/, '')}
					</span>
				</Row>
			))}
			{disclosure && disclosure.doesNotCollect.length > 0 && (
				<Row
					id={`extension-${row.id}-never`}
					label="Never collected"
					description={neverLine(disclosure.doesNotCollect)}
				/>
			)}
			<LinkRow
				id={`extension-${row.id}-collected`}
				label="Records on this computer"
				description="See exactly what is stored."
				onOpen={() => setPanel({ kind: 'collected', id: row.id })}
			/>
			<h2 className="settings-section-title">Settings</h2>
			<Row
				id={`extension-${row.id}-model-key`}
				label="Model API key"
				description="A key for a model, entered by hand. Nothing uses it in this version."
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
			<h2 className="settings-section-title">Activity log</h2>
			<LinkRow
				id={`extension-${row.id}-log`}
				label="Open the activity log"
				description="What the extension did on this computer, and when."
				onOpen={() => setPanel({ kind: 'log', id: row.id })}
			/>
			<h2 className="settings-section-title">Remove</h2>
			<Row
				id={`extension-${row.id}-remove`}
				label={`Remove ${row.name}`}
				description="Takes it off this computer. You are asked before anything is deleted."
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
			{current?.kind === 'collected' && (
				<Collected api={api} row={row} onClose={() => setPanel(undefined)} />
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
					<NoticeScreen api={bridge} id={panel.id} staged={panel.staged} onClose={() => close()} />
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
			{snap.rows.length > 0 && (
				<p className="settings-help extension-list-hint">
					Open one to see what it collects, its settings and its licence.
				</p>
			)}
			{panel?.kind === 'install' && (
				<InstallDialog api={bridge} panel={panel} onClose={close} onNext={setPanel} />
			)}
		</>
	)
}
