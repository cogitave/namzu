import { useEffect, useId, useRef, useState } from 'react'
import type {
	MarketplaceAvailableView,
	MarketplaceListView,
	MarketplacePluginView,
	MarketplacePreviewView,
	MarketplaceRowView,
	PluginPlanView,
	PluginUpdateView,
	SkillPathChoiceView,
	SkillScope,
} from '../shared/customize-protocol.js'
import type { DesktopApi } from '../shared/protocol.js'
import { Overlay, ScopePicker } from './customize-actions.js'
import { longUpdated } from './customize-model.js'
import { Chip, DetailFrame, EmptyState, GroupHeading, MoreMenu, Tile } from './customize-parts.js'
import {
	type ConsentSection,
	DELETE_DATA_LABEL,
	MARKETPLACE_NOTICE,
	MARKETPLACE_READY_HINT,
	MARKETPLACE_URL_HELP,
	MARKETPLACE_URL_PLACEHOLDER,
	PHASE_WORDS,
	PLUGIN_DROP_TEXT,
	PLUGIN_LOADING_LABEL,
	PLUGIN_PROJECT_UNTRUSTED,
	PLUGIN_RUNS_WARNING,
	PLUGIN_UPLOAD_HELP,
	PLUGIN_UPLOAD_HINT,
	PLUGIN_UPLOAD_NOTICE,
	PLUGIN_UPLOAD_SUBTITLE,
	consentSections,
	marketplaceLetter,
	marketplaceSub,
	marketplaceSubParts,
	newOpId,
	previewLine,
	removeMarketplaceBody,
	removeMarketplaceTitle,
	removePluginBody,
	removePluginTitle,
	shortDigest,
} from './customize-plugins-model.js'
import { CheckIcon, InfoIcon, LoaderCircleIcon, PlusIcon, PuzzleIcon, UploadIcon } from './icons.js'
import { notify } from './notify.js'
import { plainErrorText } from './plain-error.js'
import { PLUGINS_CHANGED_EVENT } from './plugin-create.js'
import { Button } from './ui/button.js'
import { useOpPhase } from './use-marketplaces.js'

/** The pieces behind the Plugins tab's Add menu: marketplaces, the upload page, the consent card and the removals. */

const changed = () => window.dispatchEvent(new Event(PLUGINS_CHANGED_EVENT))

function Notice({ children }: { children: React.ReactNode }) {
	return (
		<p className="customize-notice" role="note">
			<InfoIcon aria-hidden="true" />
			<span>{children}</span>
		</p>
	)
}

function LetterTile({ name }: { name: string }) {
	return (
		<span className="customize-tile" data-letter aria-hidden="true">
			{marketplaceLetter(name)}
		</span>
	)
}

// ---------------------------------------------------------------------------
// The consent card
// ---------------------------------------------------------------------------

/** What a plugin does on this computer, in the three groups of the design, and the digest the yes is given to. */
export function ConsentCard({
	name,
	version,
	sections,
	digest,
	notes,
	changes,
	loading,
}: {
	name: string
	version?: string
	sections: readonly ConsentSection[]
	digest: string
	notes?: readonly string[]
	/** What changed since the installed version: an update shows it first. */
	changes?: readonly string[]
	loading?: { off: boolean; checked: boolean; onChange: (on: boolean) => void }
}) {
	return (
		<div className="customize-consent" data-testid="consent-card">
			<div className="customize-consent-head">
				<Tile icon={PuzzleIcon} />
				<div className="customize-stage-copy">
					<div className="customize-row-title">
						<span className="customize-name" title={name}>
							{name}
						</span>
						{version && <Chip>{version}</Chip>}
					</div>
				</div>
			</div>
			{changes && changes.length > 0 && (
				<section className="customize-consent-section" aria-label="What changed">
					<h4 className="customize-consent-title">What changed</h4>
					<ul>
						{changes.map((line) => (
							<li key={line}>{line}</li>
						))}
					</ul>
				</section>
			)}
			{sections.map((section) => (
				<section
					key={section.id}
					className="customize-consent-section"
					data-muted={section.muted || undefined}
					aria-label={section.title}
				>
					<h4 className="customize-consent-title">{section.title}</h4>
					<ul>
						{section.rows.map((item) => (
							<li key={`${item.text}\u0000${item.code ?? ''}`}>
								{item.text}
								{item.code !== undefined && (
									<>
										{': '}
										<code className="customize-consent-code">{item.code}</code>
									</>
								)}
							</li>
						))}
					</ul>
				</section>
			))}
			{notes && notes.length > 0 && (
				<ul className="customize-stage-lines">
					{notes.map((line) => (
						<li key={line}>{line}</li>
					))}
				</ul>
			)}
			<p className="customize-consent-warning">{PLUGIN_RUNS_WARNING}</p>
			{loading?.off && (
				<label className="customize-check">
					<input
						type="checkbox"
						checked={loading.checked}
						onChange={(event) => loading.onChange(event.target.checked)}
					/>
					<span>{PLUGIN_LOADING_LABEL}</span>
				</label>
			)}
			<p className="customize-digest" title={digest}>
				What it does: {shortDigest(digest)}
			</p>
		</div>
	)
}

type ConsentApi = Pick<DesktopApi, 'planPlugin' | 'installPlugin' | 'cancelOp' | 'onEvent'>

/**
 * Reads a plugin for one place and shows what it would do; Install is the consent and sends back
 * the digest of what was shown. One component for the upload page and the Discover sheet.
 */
export function ConsentFlow({
	api,
	source,
	projectId,
	onInstalled,
	onCancel,
	onBusy,
	cancelLabel = 'Cancel',
}: {
	api: ConsentApi
	source: { id: string } | { stageId: string }
	projectId?: string
	onInstalled: (id: string) => void
	onCancel: () => void
	onBusy?: (busy: boolean) => void
	cancelLabel?: string
}) {
	const [scope, setScope] = useState<SkillScope>('user')
	const [plan, setPlan] = useState<PluginPlanView>()
	const [error, setError] = useState<string>()
	const [reading, setReading] = useState(true)
	const [busy, setBusyState] = useState(false)
	const [enableLoading, setEnableLoading] = useState(false)
	const [opId, setOpId] = useState<string>()
	const phase = useOpPhase(api, reading ? opId : undefined)
	const latest = useRef(0)
	const live = useRef(true)
	const running = useRef<string | undefined>(undefined)
	useEffect(() => {
		live.current = true
		return () => {
			live.current = false
			// A read still going holds a staging folder: stop it with the page.
			if (running.current) void apiRef.current.cancelOp?.(running.current, projectIdRef.current)
		}
	}, [])
	const projectIdRef = useRef(projectId)
	projectIdRef.current = projectId
	const apiRef = useRef(api)
	apiRef.current = api
	const setBusy = (value: boolean) => {
		setBusyState(value)
		onBusy?.(value)
	}
	const key = 'id' in source ? `id:${source.id}` : `stage:${source.stageId}`
	// biome-ignore lint/correctness/useExhaustiveDependencies: the key names the source; scope and project are the plan's place
	useEffect(() => {
		if (!api.planPlugin) {
			setError('Update Namzu to add plugins from here.')
			setReading(false)
			return
		}
		const mine = ++latest.current
		// The read of the earlier place is stopped; this one has an id of its own.
		if (running.current) void api.cancelOp?.(running.current, projectIdRef.current)
		const id = newOpId('plan')
		running.current = id
		setOpId(id)
		setPlan(undefined)
		setError(undefined)
		setReading(true)
		void (async () => {
			try {
				const answer = await api.planPlugin?.({ ...source, scope, opId: id }, projectId)
				if (!live.current || latest.current !== mine) return
				if (!answer) setError('Update Namzu to add plugins from here.')
				else setPlan(answer)
			} catch (failure) {
				if (live.current && latest.current === mine)
					setError(plainErrorText(failure, 'read the plugin'))
			} finally {
				if (running.current === id) running.current = undefined
				if (live.current && latest.current === mine) setReading(false)
			}
		})()
	}, [api, key, scope, projectId])

	const install = async () => {
		if (!plan || busy || plan.installed || !api.installPlugin) return
		setBusy(true)
		setError(undefined)
		try {
			const answer = await api.installPlugin(
				{
					planId: plan.planId,
					digest: plan.digest,
					scope,
					consent: true,
					...(plan.loadingOn || !enableLoading ? {} : { enableLoading: true }),
				},
				projectId,
			)
			if (!live.current) return
			if (!answer) {
				setError('Update Namzu to add plugins from here.')
				return
			}
			notify(answer.message, { tone: 'success' })
			changed()
			onInstalled(answer.id)
		} catch (failure) {
			if (live.current) setError(plainErrorText(failure, 'add the plugin'))
		} finally {
			if (live.current) setBusy(false)
		}
	}
	const sections = plan ? consentSections(plan.surface, plan.components, plan.findings) : []
	const hint = plan?.installed
		? `"${plan.name}" is already installed${plan.installed.version ? ` (version ${plan.installed.version})` : ''}.`
		: undefined
	return (
		<div className="customize-consent-flow">
			<ScopePicker
				scope={scope}
				onScope={setScope}
				projectReady={Boolean(projectId)}
				label="Install for"
				untrusted={PLUGIN_PROJECT_UNTRUSTED}
			/>
			{reading && (
				<output className="customize-muted">
					{phase ? PHASE_WORDS[phase] : 'Reading the plugin…'}
				</output>
			)}
			{plan && (
				<ConsentCard
					name={plan.name}
					version={plan.version}
					sections={sections}
					digest={plan.digest}
					notes={plan.warnings}
					loading={{ off: !plan.loadingOn, checked: enableLoading, onChange: setEnableLoading }}
				/>
			)}
			{hint && <p className="customize-hint">{hint}</p>}
			{error && (
				<p className="customize-error" role="alert">
					{error}
				</p>
			)}
			<div className="customize-actions">
				<Button
					className="customize-primary"
					disabled={!plan || busy || Boolean(plan?.installed) || reading}
					onClick={() => void install()}
				>
					{busy ? 'Installing…' : 'Install'}
				</Button>
				<Button variant="outline" onClick={onCancel} disabled={busy}>
					{cancelLabel}
				</Button>
			</div>
		</div>
	)
}

/** The sheet a Discover card's + opens: the plugin read for the chosen place, then Install. */
export function InstallSheet({
	api,
	plugin,
	projectId,
	returnFocus,
	onClose,
	onInstalled,
}: {
	api: ConsentApi
	plugin: { id: string; name: string }
	projectId?: string
	returnFocus: () => HTMLElement | null
	onClose: () => void
	onInstalled: (id: string) => void
}) {
	const [busy, setBusy] = useState(false)
	return (
		<Overlay
			title={`Add ${plugin.name}`}
			onClose={onClose}
			returnFocus={returnFocus}
			size="wide"
			locked={busy}
		>
			<ConsentFlow
				api={api}
				source={{ id: plugin.id }}
				projectId={projectId}
				onInstalled={onInstalled}
				onCancel={onClose}
				onBusy={setBusy}
			/>
		</Overlay>
	)
}

/** An update that needs a yes: what changed, then the surface it would run. */
export function UpdateSheet({
	api,
	update,
	projectId,
	name,
	returnFocus,
	onClose,
	onUpdated,
}: {
	api: Pick<DesktopApi, 'updatePlugin'>
	update: PluginUpdateView
	projectId?: string
	name: string
	returnFocus: () => HTMLElement | null
	onClose: () => void
	onUpdated: (message: string) => void
}) {
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string>()
	const sections = update.surface ? consentSections(update.surface, undefined, []) : []
	const go = async () => {
		if (!update.digest || busy || !api.updatePlugin) return
		setBusy(true)
		setError(undefined)
		try {
			const answer = await api.updatePlugin(
				{ id: update.id, acceptDigest: update.digest },
				projectId,
			)
			if (!answer) setError('Update Namzu to update plugins from here.')
			else if (answer.outcome === 'needs-consent')
				setError('What it does changed again. Close this and check for updates again.')
			else onUpdated(answer.message ?? `Updated ${name} to ${answer.to}.`)
		} catch (failure) {
			setError(plainErrorText(failure, 'update the plugin'))
		} finally {
			setBusy(false)
		}
	}
	return (
		<Overlay
			title={`Update ${name}`}
			onClose={onClose}
			returnFocus={returnFocus}
			size="wide"
			locked={busy}
		>
			<div className="customize-consent-flow">
				<ConsentCard
					name={name}
					version={update.to}
					sections={sections}
					digest={update.digest ?? ''.padEnd(16, '0')}
					changes={update.changes}
				/>
				{error && (
					<p className="customize-error" role="alert">
						{error}
					</p>
				)}
				<div className="customize-actions">
					<Button className="customize-primary" disabled={busy} onClick={() => void go()}>
						{busy ? 'Updating…' : 'Update'}
					</Button>
					<Button variant="outline" disabled={busy} onClick={onClose}>
						Cancel
					</Button>
				</div>
			</div>
		</Overlay>
	)
}

// ---------------------------------------------------------------------------
// Upload plugin
// ---------------------------------------------------------------------------

type UploadApi = ConsentApi &
	Pick<DesktopApi, 'choosePluginFile' | 'choosePluginFolder' | 'dropPluginFile' | 'stagePlugin'>

/** The page behind Add, Upload plugin: one file or folder, read aside, then the consent card. */
export function UploadPluginPage({
	api,
	projectId,
	onBack,
	onDone,
}: {
	api: UploadApi
	projectId?: string
	onBack: () => void
	onDone: () => void
}) {
	const [stageId, setStageId] = useState<string>()
	const [picked, setPicked] = useState<SkillPathChoiceView>()
	const [problem, setProblem] = useState<string>()
	const [reading, setReading] = useState(false)
	const [over, setOver] = useState(false)
	const [opId, setOpId] = useState<string>()
	const phase = useOpPhase(api, reading ? opId : undefined)
	const live = useRef(true)
	const latest = useRef(0)
	const running = useRef<string | undefined>(undefined)
	const apiRef = useRef(api)
	apiRef.current = api
	const projectIdRef = useRef(projectId)
	projectIdRef.current = projectId
	useEffect(() => {
		live.current = true
		return () => {
			live.current = false
			// A read still going holds a staging folder: stop it with the page.
			if (running.current) void apiRef.current.cancelOp?.(running.current, projectIdRef.current)
		}
	}, [])

	const take = async (choices: SkillPathChoiceView[]) => {
		setProblem(undefined)
		const choice = choices.find((item) => item.path) ?? choices[0]
		if (!choice) return
		const mine = ++latest.current
		setPicked(choice)
		setStageId(undefined)
		if (!choice.path) {
			setProblem(choice.error ?? 'That file cannot be used.')
			return
		}
		if (!api.stagePlugin) {
			setProblem('Update Namzu to add plugins from here.')
			return
		}
		if (running.current) void api.cancelOp?.(running.current, projectId)
		const id = newOpId('stage')
		running.current = id
		setOpId(id)
		setReading(true)
		try {
			const answer = await api.stagePlugin(choice.path, id, projectId)
			if (!live.current || latest.current !== mine) return
			if (!answer) setProblem('Update Namzu to add plugins from here.')
			else setStageId(answer.stageId)
		} catch (failure) {
			if (live.current && latest.current === mine)
				setProblem(plainErrorText(failure, 'read the plugin'))
		} finally {
			if (running.current === id) running.current = undefined
			if (live.current && latest.current === mine) setReading(false)
		}
	}
	const pick = (choose: (() => Promise<SkillPathChoiceView[]>) | undefined) => async () => {
		if (!choose) return
		try {
			await take(await choose())
		} catch (failure) {
			setProblem(plainErrorText(failure, 'choose the file'))
		}
	}
	const clearPick = () => {
		latest.current += 1
		if (running.current) void api.cancelOp?.(running.current, projectId)
		running.current = undefined
		setPicked(undefined)
		setStageId(undefined)
		setProblem(undefined)
		setReading(false)
	}
	const [before, after] = PLUGIN_DROP_TEXT.split('browse')
	return (
		<DetailFrame
			backLabel="Your plugins"
			onBack={onBack}
			tile={<Tile icon={UploadIcon} size={44} />}
			title="Upload a plugin"
			subtitle={PLUGIN_UPLOAD_SUBTITLE}
		>
			<div className="customize-upload">
				{!stageId && <Notice>{PLUGIN_UPLOAD_NOTICE}</Notice>}
				<h3 className="customize-field-label" id="plugin-file-label">
					Plugin file
				</h3>
				<section
					className="customize-drop"
					aria-labelledby="plugin-file-label"
					data-over={over || undefined}
					data-picked={picked && !problem ? true : undefined}
					onDragOver={(event) => {
						event.preventDefault()
						setOver(true)
					}}
					onDragLeave={() => setOver(false)}
					onDrop={(event) => {
						event.preventDefault()
						setOver(false)
						void (async () => {
							try {
								await take((await api.dropPluginFile?.(Array.from(event.dataTransfer.files))) ?? [])
							} catch (failure) {
								setProblem(plainErrorText(failure, 'read the dropped file'))
							}
						})()
					}}
				>
					<p>
						{before}
						<button
							type="button"
							className="customize-link"
							onClick={() => void pick(api.choosePluginFile)()}
						>
							browse
						</button>
						{after}
					</p>
					<button
						type="button"
						className="customize-link"
						onClick={() => void pick(api.choosePluginFolder)()}
					>
						Choose a folder
					</button>
				</section>
				<p className="customize-hint">{PLUGIN_UPLOAD_HELP}</p>
				{picked && !problem && (
					<div className="customize-picked">
						<output className="customize-chip">
							{reading
								? `${phase ? PHASE_WORDS[phase] : 'Reading'} ${picked.fileName}`
								: picked.fileName}
						</output>
						<button
							type="button"
							className="customize-link"
							aria-label={`Remove ${picked.fileName}`}
							onClick={clearPick}
						>
							Remove
						</button>
					</div>
				)}
				{problem && (
					<p className="customize-error" role="alert">
						{problem}
					</p>
				)}
				{stageId ? (
					<ConsentFlow
						key={stageId}
						api={api}
						source={{ stageId }}
						projectId={projectId}
						onInstalled={onDone}
						onCancel={onBack}
					/>
				) : (
					<div className="customize-actions">
						<Button className="customize-primary" disabled>
							Install
						</Button>
						<Button variant="outline" onClick={onBack}>
							Cancel
						</Button>
						<span className="customize-hint">{PLUGIN_UPLOAD_HINT}</span>
					</div>
				)}
			</div>
		</DetailFrame>
	)
}

// ---------------------------------------------------------------------------
// Add marketplace
// ---------------------------------------------------------------------------

type MarketApi = Pick<
	DesktopApi,
	'previewMarketplace' | 'addMarketplace' | 'choosePluginFolder' | 'cancelOp' | 'onEvent'
>

export function AddMarketplaceForm({
	api,
	projectId,
	onClose,
	onAdded,
	onPending,
}: {
	api: MarketApi
	projectId?: string
	onClose: () => void
	onAdded: (name: string) => void
	onPending?: (pending: boolean) => void
}) {
	const uid = useId()
	const [source, setSource] = useState('')
	const [preview, setPreview] = useState<MarketplacePreviewView | null>()
	const [error, setError] = useState<string>()
	const [pending, setPendingState] = useState(false)
	const [opId, setOpId] = useState<string>()
	const phase = useOpPhase(api, opId)
	const latest = useRef(0)
	const live = useRef(true)
	useEffect(() => {
		live.current = true
		return () => {
			live.current = false
		}
	}, [])
	const setPending = (value: boolean) => {
		setPendingState(value)
		onPending?.(value)
	}
	// What the address would be is read from its text alone, as the person types: no network.
	useEffect(() => {
		const text = source.trim()
		const mine = ++latest.current
		if (!text || !api.previewMarketplace) {
			setPreview(undefined)
			return
		}
		void (async () => {
			try {
				const read = await api.previewMarketplace?.(text, projectId)
				if (live.current && latest.current === mine) setPreview(read)
			} catch (failure) {
				if (live.current && latest.current === mine)
					setPreview({ error: plainErrorText(failure, 'read the address') })
			}
		})()
	}, [api, source, projectId])
	const line = previewLine(preview)
	const ready = Boolean(source.trim()) && line?.tone === 'ok'
	const submit = async () => {
		if (!ready || pending || !api.addMarketplace) return
		const id = newOpId('market')
		setOpId(id)
		setPending(true)
		setError(undefined)
		try {
			const answer = await api.addMarketplace(
				{ source: source.trim(), scope: 'user', accepted: 'marketplace-v1', opId: id },
				projectId,
			)
			if (!live.current) return
			if (!answer) setError('Update Namzu to add marketplaces from here.')
			else {
				notify(
					answer.outcome === 'already-added'
						? `Marketplace "${answer.name}" is already added.`
						: `Marketplace "${answer.name}" added (${answer.plugins} ${answer.plugins === 1 ? 'plugin' : 'plugins'}).`,
					{ tone: 'success' },
				)
				changed()
				onAdded(answer.name)
			}
		} catch (failure) {
			if (live.current) setError(plainErrorText(failure, 'add the marketplace'))
		} finally {
			if (live.current) {
				setPending(false)
				setOpId(undefined)
			}
		}
	}
	const cancel = () => {
		if (pending && opId) void api.cancelOp?.(opId, projectId)
		else onClose()
	}
	const folder = async () => {
		try {
			const choice = (await api.choosePluginFolder?.())?.find((item) => item.path)
			if (choice?.path) setSource(choice.path)
		} catch (failure) {
			setError(plainErrorText(failure, 'choose the folder'))
		}
	}
	return (
		<form
			className="customize-form"
			onSubmit={(event) => {
				event.preventDefault()
				void submit()
			}}
		>
			<Notice>{MARKETPLACE_NOTICE}</Notice>
			<div className="customize-field">
				<label className="customize-field-label" htmlFor={`${uid}-url`}>
					URL
				</label>
				<input
					id={`${uid}-url`}
					data-autofocus
					className="customize-input"
					value={source}
					placeholder={MARKETPLACE_URL_PLACEHOLDER}
					autoComplete="off"
					spellCheck={false}
					disabled={pending}
					aria-describedby={`${uid}-help${line ? ` ${uid}-line` : ''}`}
					onChange={(event) => setSource(event.target.value)}
				/>
				<span className="customize-hint" id={`${uid}-help`}>
					{MARKETPLACE_URL_HELP}{' '}
					{api.choosePluginFolder && (
						<button
							type="button"
							className="customize-link"
							disabled={pending}
							onClick={() => void folder()}
						>
							Choose a folder
						</button>
					)}
				</span>
				{line && (
					<span
						id={`${uid}-line`}
						className={line.tone === 'error' ? 'customize-error' : 'customize-hint'}
						role={line.tone === 'error' ? 'alert' : 'status'}
					>
						{line.text}
					</span>
				)}
			</div>
			{pending && (
				<output className="customize-muted">
					{phase ? PHASE_WORDS[phase] : PHASE_WORDS.checking}
				</output>
			)}
			{error && (
				<p className="customize-error" role="alert">
					{error}
				</p>
			)}
			<div className="dialog-actions customize-dialog-actions">
				<Button type="button" variant="outline" onClick={cancel}>
					Cancel
				</Button>
				{!ready && !pending && (
					<span className="customize-hint customize-dialog-hint">{MARKETPLACE_READY_HINT}</span>
				)}
				<Button type="submit" className="customize-primary" disabled={!ready || pending}>
					{pending ? 'Adding…' : 'Add'}
				</Button>
			</div>
		</form>
	)
}

export function AddMarketplaceDialog({
	returnFocus,
	onClose,
	...form
}: Parameters<typeof AddMarketplaceForm>[0] & { returnFocus: () => HTMLElement | null }) {
	const [busy, setBusy] = useState(false)
	return (
		<Overlay title="Add marketplace" onClose={onClose} returnFocus={returnFocus} locked={busy}>
			<AddMarketplaceForm onClose={onClose} {...form} onPending={setBusy} />
		</Overlay>
	)
}

// ---------------------------------------------------------------------------
// Removing
// ---------------------------------------------------------------------------

export function RemovePluginDialog({
	name,
	returnFocus,
	onClose,
	onRemove,
}: {
	name: string
	returnFocus: () => HTMLElement | null
	onClose: () => void
	onRemove: (deleteData: boolean) => Promise<void>
}) {
	const [deleteData, setDeleteData] = useState(false)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string>()
	const go = async () => {
		setBusy(true)
		setError(undefined)
		try {
			await onRemove(deleteData)
			onClose()
		} catch (failure) {
			setError(plainErrorText(failure, 'remove the plugin'))
			setBusy(false)
		}
	}
	return (
		<Overlay title={removePluginTitle} onClose={onClose} returnFocus={returnFocus} locked={busy}>
			<div className="customize-form">
				<p className="dialog-body">{removePluginBody(name)}</p>
				<label className="customize-check">
					<input
						type="checkbox"
						checked={deleteData}
						disabled={busy}
						onChange={(event) => setDeleteData(event.target.checked)}
					/>
					<span>{DELETE_DATA_LABEL}</span>
				</label>
				{error && (
					<p className="customize-error" role="alert">
						{error}
					</p>
				)}
				<div className="dialog-actions customize-dialog-actions">
					<Button variant="outline" disabled={busy} onClick={onClose} data-autofocus>
						Cancel
					</Button>
					<Button variant="destructive" disabled={busy} onClick={() => void go()}>
						{busy ? 'Removing…' : 'Remove'}
					</Button>
				</div>
			</div>
		</Overlay>
	)
}

export function RemoveMarketplaceDialog({
	name,
	installed,
	returnFocus,
	onClose,
	onRemove,
}: {
	name: string
	installed: readonly string[]
	returnFocus: () => HTMLElement | null
	onClose: () => void
	onRemove: () => Promise<void>
}) {
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string>()
	const go = async () => {
		setBusy(true)
		setError(undefined)
		try {
			await onRemove()
			onClose()
		} catch (failure) {
			setError(plainErrorText(failure, 'remove the marketplace'))
			setBusy(false)
		}
	}
	return (
		<Overlay
			title={removeMarketplaceTitle}
			onClose={onClose}
			returnFocus={returnFocus}
			locked={busy}
		>
			<div className="customize-form">
				<p className="dialog-body">{removeMarketplaceBody(name, installed)}</p>
				{installed.length > 0 && (
					<ul className="customize-stage-lines" aria-label="Plugins that go with it">
						{installed.map((item) => (
							<li key={item}>{item}</li>
						))}
					</ul>
				)}
				{error && (
					<p className="customize-error" role="alert">
						{error}
					</p>
				)}
				<div className="dialog-actions customize-dialog-actions">
					<Button variant="outline" disabled={busy} onClick={onClose} data-autofocus>
						Cancel
					</Button>
					<Button variant="destructive" disabled={busy} onClick={() => void go()}>
						{busy ? 'Removing…' : 'Remove'}
					</Button>
				</div>
			</div>
		</Overlay>
	)
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

/** `2 plugins · /path · updated today`: the address gives way first when the row is narrow. */
function MarketSub({ market, updated }: { market: MarketplaceRowView; updated: string }) {
	const parts = marketplaceSubParts(market, updated)
	return (
		<span
			className="customize-row-sub customize-market-sub"
			title={marketplaceSub(market, updated)}
		>
			<span className="customize-market-count">{parts.count}</span>
			<span className="customize-market-source">{parts.source}</span>
			{parts.updated && <span className="customize-market-count">{parts.updated}</span>}
		</span>
	)
}

/** The small Marketplaces list below the installed plugins. */
export function MarketplacesList({
	view,
	now,
	updating,
	onUpdate,
	onRemove,
}: {
	view: MarketplaceListView
	now: number
	updating: string | undefined
	onUpdate: (name: string) => void
	onRemove: (name: string) => void
}) {
	return (
		<section className="customize-group" aria-label="Marketplaces">
			<GroupHeading title="Marketplaces" count={view.marketplaces.length} />
			<ul className="customize-list">
				{view.marketplaces.map((market) => (
					<li key={market.name} className="customize-row">
						<span className="customize-row-main customize-row-static-main">
							<LetterTile name={market.name} />
							<span className="customize-row-copy">
								<span className="customize-row-title">
									<span className="customize-name" title={market.name}>
										{market.name}
									</span>
									{market.installed > 0 && <Chip>{`${market.installed} installed`}</Chip>}
									{market.problem && <Chip tone="off">Needs attention</Chip>}
								</span>
								{market.problem ? (
									<span className="customize-row-sub" title={market.source}>
										{market.problem}
									</span>
								) : (
									<MarketSub market={market} updated={longUpdated(market.lastUpdated, now)} />
								)}
							</span>
							{updating === market.name && (
								<LoaderCircleIcon className="animate-spin" aria-label="Updating" />
							)}
						</span>
						<MoreMenu
							label={`Actions for marketplace ${market.name}`}
							items={[
								{
									label: 'Update now',
									disabled: updating !== undefined,
									onSelect: () => onUpdate(market.name),
								},
								{ label: 'Remove', danger: true, onSelect: () => onRemove(market.name) },
							]}
						/>
					</li>
				))}
			</ul>
		</section>
	)
}

/** Discover: a card per plugin the marketplaces offer; the + opens the consent sheet. */
export function DiscoverGrid({
	view,
	available,
	query,
	onAdd,
}: {
	view: MarketplaceListView
	available: Readonly<Record<string, MarketplaceAvailableView | { error: string }>>
	query: string
	onAdd: (plugin: MarketplacePluginView) => void
}) {
	const needle = query.trim().toLowerCase()
	const groups = view.marketplaces.map((market) => {
		const read = available[market.name]
		const plugins =
			read && 'plugins' in read
				? read.plugins.filter(
						(plugin) =>
							!needle ||
							`${plugin.name} ${plugin.description ?? ''}`.toLowerCase().includes(needle),
					)
				: []
		return { market, read, plugins }
	})
	if (groups.every((g) => g.read && 'plugins' in g.read && g.plugins.length === 0))
		return (
			<EmptyState>
				{needle ? 'No plugins match your search.' : 'These marketplaces offer no plugins yet.'}
			</EmptyState>
		)
	return (
		<>
			{groups.map(({ market, read, plugins }) => (
				<section key={market.name} className="customize-group" aria-label={`From ${market.name}`}>
					<GroupHeading title={`From ${market.name}`} count={plugins.length} />
					{!read && <p className="customize-muted">Reading {market.name}…</p>}
					{read && 'error' in read && <p className="customize-error">{read.error}</p>}
					{plugins.length > 0 && (
						<ul className="customize-cards">
							{plugins.map((plugin) => {
								const here = plugin.installedAt.length > 0
								return (
									<li key={plugin.id} className="customize-card-item">
										<LetterTile name={plugin.name} />
										<span className="customize-card-copy">
											<span className="customize-name" title={plugin.name}>
												{plugin.name}
											</span>
											<span className="customize-card-text">{plugin.description ?? ''}</span>
											<span className="customize-card-from">
												from {market.name}
												{plugin.version ? ` · ${plugin.version}` : ''}
											</span>
										</span>
										{here ? (
											<span
												className="customize-card-done"
												role="img"
												aria-label={`${plugin.name} is installed`}
											>
												<CheckIcon aria-hidden="true" />
											</span>
										) : (
											<Button
												variant="outline"
												size="icon-sm"
												className="customize-card-add"
												aria-label={`Add ${plugin.name}`}
												disabled={!plugin.installable}
												title={plugin.installable ? undefined : plugin.reason}
												onClick={() => onAdd(plugin)}
											>
												<PlusIcon aria-hidden="true" />
											</Button>
										)}
									</li>
								)
							})}
						</ul>
					)}
				</section>
			))}
		</>
	)
}
