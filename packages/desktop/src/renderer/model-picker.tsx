import { Radio } from '@base-ui/react/radio'
import { RadioGroup } from '@base-ui/react/radio-group'
import { Tabs } from '@base-ui/react/tabs'
import type { ReasoningEffort } from '@namzu/sdk'
import { ChevronLeft } from 'lucide-react'
import {
	type CSSProperties,
	type KeyboardEvent,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from 'react'
import type {
	ComposerModelSettings,
	HarnessView,
	ModelCatalogueView,
	ProviderView,
} from '../shared/protocol.js'
import { ComposerControl, ComposerControlChevron } from './composer-control.js'
import { ComposerEffortPanel } from './composer-effort-panel.js'
import { EngineChip, EnginePanel, HarnessMark, engineLabel } from './harness-picker.js'
import {
	CheckIcon,
	CloudIcon,
	LoaderCircleIcon,
	ProviderIcons,
	SearchIcon,
	ServerIcon,
	XIcon,
} from './icons.js'
import {
	ModelCatalogueDisplayCache,
	modelCatalogueDisplayCacheForApi,
} from './model-catalogue-display-cache.js'
import {
	type ModelChoice,
	defaultModelRow,
	effortLabel,
	followCatalogue,
	modelDisplayLabel,
	resolveEffort,
} from './model-choice.js'
import { isNewModel } from './model-freshness.js'
import { commitsOnKey } from './picker-commit.js'
import { Button } from './ui/button.js'
import { Input } from './ui/input.js'
import { Popover, PopoverPopup, PopoverTrigger } from './ui/popover.js'
import { Tooltip, TooltipPopup, TooltipTrigger } from './ui/tooltip.js'
import './model-picker.css'

export type { ModelChoice }
type Provider = ProviderView['available'][number]
type Catalogue = {
	loading: boolean
	value?: ModelCatalogueView
	error?: string
	scopeKey?: string
}
type View = 'effort' | 'models' | 'engine'
/** The engine choice the popup offers, with the state that gates it. */
export type EngineControl = {
	view?: HarnessView
	selected?: HarnessView['selected']
	busy: boolean
	disabled: boolean
	onSelect: (engine: HarnessView['selected']) => void
}
const DEFAULT_KEY = 'default'
const LOAD_FAILED = "Couldn't load the model list. It will try again next time you open this."

function ProviderMark({ provider }: { provider: Provider }) {
	const Icon =
		ProviderIcons.get(
			provider.id === 'codex' || provider.id === 'codex-cli'
				? 'openai'
				: provider.id === 'claude-code'
					? 'anthropic'
					: provider.id,
		) ?? (['ollama', 'lmstudio'].includes(provider.id) ? ServerIcon : CloudIcon)
	return (
		<span className="model-provider-mark" aria-hidden="true">
			<Icon />
		</span>
	)
}

export function ModelPicker({
	providers,
	choice,
	disabled,
	onChange,
	projectId,
	sessionId,
	loadCatalogue,
	catalogueHarnessScope,
	catalogueEnabled = true,
	positionerClassName,
	settings,
	effort,
	onEffortChange,
	engineControl,
}: {
	providers: ProviderView
	choice: ModelChoice
	disabled: boolean
	onChange: (choice: ModelChoice) => void
	projectId: string
	sessionId?: string
	loadCatalogue?: (provider: string) => Promise<ModelCatalogueView>
	/** The authoritative engine identity, independent of selected model. */
	catalogueHarnessScope?: string
	/** The trigger reads the current catalogue as soon as this is true, even while the menu is closed. */
	catalogueEnabled?: boolean
	positionerClassName?: string
	/** Null while this model's settings load; undefined when the picker offers no effort. */
	settings?: ComposerModelSettings | null
	effort?: ReasoningEffort
	onEffortChange?: (effort: ReasoningEffort | undefined) => void
	/** Absent where engines are not offered, such as the Pal composer. */
	engineControl?: EngineControl
}) {
	const [open, setOpen] = useState(false)
	const [view, setView] = useState<View>('models')
	// The view the engine view returns to.
	const [engineFrom, setEngineFrom] = useState<'effort' | 'models'>('models')
	const engine = engineControl?.view?.selected ?? engineControl?.selected ?? 'namzu'
	const engineName = engineLabel(engineControl?.view, engine)
	const openEngine = (from: 'effort' | 'models') => {
		setEngineFrom(from)
		setView('engine')
	}
	// The model list opened from the effort panel returns there once a model is chosen.
	const [fromEffort, setFromEffort] = useState(false)
	// A model picked from the effort panel is saved asynchronously; the panel waits for it so it
	// never shows the previous model's name or levels.
	const [awaiting, setAwaiting] = useState<ModelChoice | null>(null)
	const localCache = useRef<{
		loader?: typeof loadCatalogue
		cache: ModelCatalogueDisplayCache
	}>(null)
	if (!localCache.current || localCache.current.loader !== loadCatalogue)
		localCache.current = { loader: loadCatalogue, cache: new ModelCatalogueDisplayCache() }
	const displayCache =
		!loadCatalogue && typeof window !== 'undefined' && window.namzu
			? modelCatalogueDisplayCacheForApi(window.namzu)
			: localCache.current.cache
	const provider = providers.available.find((item) => item.id === choice.provider)
	const modelId = choice.model || provider?.defaultModel || ''
	const rows = useChoiceCatalogue({
		displayCache,
		provider,
		providers,
		projectId,
		sessionId,
		loadCatalogue,
		harnessScope: catalogueHarnessScope,
		enabled: catalogueEnabled,
	})
	const label = modelId ? modelDisplayLabel({ model: modelId, label: choice.label }, rows) : ''
	const shownEffort = onEffortChange ? resolveEffort(settings, effort) : undefined
	const effortChoices = shownEffort?.levels.length ?? 0
	useEffect(() => {
		if (disabled) setOpen(false)
	}, [disabled])
	// A choice that follows the engine's default, or whose saved label went stale, is brought up to
	// date once the catalogue is known. Each correction is sent once, however often it re-renders.
	const corrected = useRef('')
	useEffect(() => {
		if (disabled) return
		const next = followCatalogue({ ...choice, model: modelId }, rows, provider?.defaultModel)
		if (!next) {
			corrected.current = ''
			return
		}
		const key = JSON.stringify(next)
		if (corrected.current === key) return
		corrected.current = key
		onChange(next)
	}, [disabled, choice, modelId, rows, provider?.defaultModel, onChange])
	const scope = `${projectId}:${sessionId ?? ''}`
	const previousScope = useRef(scope)
	useEffect(() => {
		if (previousScope.current !== scope) {
			previousScope.current = scope
			setOpen(false)
		}
	}, [scope])
	const accessibleName = label
		? `Model: ${label}${shownEffort?.value ? `, effort: ${effortLabel(shownEffort.value)}` : ''}`
		: 'Select model'
	const choose = (next: ModelChoice) => {
		if (disabled) return
		onChange(next)
		if (fromEffort) {
			setFromEffort(false)
			setAwaiting(next)
		} else setOpen(false)
	}
	useEffect(() => {
		if (awaiting && choice.provider === awaiting.provider && choice.model === awaiting.model) {
			setAwaiting(null)
			setView('effort')
		}
	}, [awaiting, choice.provider, choice.model])
	const engineOf = (from: 'effort' | 'models') =>
		engineControl
			? {
					id: engine,
					label: engineName,
					disabled: engineControl.disabled || engineControl.busy || !engineControl.view,
					onOpen: () => openEngine(from),
				}
			: undefined
	const { resize, measured, resizeStyle } = useAnimatedHeight(open)
	const closeUnavailable = useCallback(() => setOpen(false), [])
	return (
		<Popover
			open={open && previousScope.current === scope && !disabled}
			onOpenChange={(next) => {
				if (next) {
					setFromEffort(false)
					setAwaiting(null)
					setView(effortChoices >= 2 ? 'effort' : 'models')
				}
				setOpen(next)
			}}
		>
			<PopoverTrigger
				render={
					<ComposerControl
						className="model-picker-trigger"
						disabled={disabled || providers.available.length === 0}
						aria-label={accessibleName}
					/>
				}
			>
				{engine !== 'namzu' && (
					<span className="model-picker-trigger-engine">
						<HarnessMark engine={engine} />
					</span>
				)}
				<span className="model-picker-trigger-model truncate">{label || 'Select model'}</span>
				{shownEffort?.value && (
					<span className="model-picker-trigger-effort" aria-hidden="true">
						{effortLabel(shownEffort.value)}
					</span>
				)}
				<ComposerControlChevron />
			</PopoverTrigger>
			<PopoverPopup
				side="top"
				align="end"
				sideOffset={8}
				padding="none"
				aria-label={
					view === 'effort' ? 'Reasoning effort' : view === 'engine' ? 'Engine' : 'Model picker'
				}
				className="model-picker-popup"
				data-view={view}
				data-wide={providers.available.length > 1 || undefined}
				positionerClassName={positionerClassName}
			>
				<div
					className="model-picker-resize"
					ref={resize}
					style={{
						...resizeStyle,
						width: `min(${view === 'engine' || (view === 'effort' && onEffortChange) ? 264 : providers.available.length > 1 ? 360 : 300}px, calc(100vw - 16px))`,
					}}
				>
					<div className="model-picker-body" ref={measured}>
						{view === 'engine' && engineControl ? (
							<EnginePanel
								view={engineControl.view}
								selectedEngine={engineControl.selected}
								backLabel={engineFrom === 'effort' ? 'Effort' : 'Models'}
								busy={engineControl.busy}
								disabled={engineControl.disabled}
								onBack={() =>
									setView(engineFrom === 'effort' && onEffortChange ? 'effort' : 'models')
								}
								onSelect={(next) => {
									setOpen(false)
									engineControl.onSelect(next)
								}}
							/>
						) : view === 'effort' && onEffortChange ? (
							<ComposerEffortPanel
								scope={JSON.stringify([projectId, sessionId, choice.provider, modelId])}
								modelLabel={label}
								levels={shownEffort?.levels ?? []}
								value={shownEffort?.value}
								defaultValue={settings?.effortDefault}
								loading={settings === null}
								disabled={disabled}
								onChange={onEffortChange}
								onShowModels={() => {
									setFromEffort(true)
									setView('models')
								}}
								onUnavailable={closeUnavailable}
								engine={engineOf('effort')}
							/>
						) : (
							<ModelBrowser
								key={`${projectId}:${sessionId ?? ''}`}
								providers={providers}
								choice={choice}
								projectId={projectId}
								sessionId={sessionId}
								loadCatalogue={loadCatalogue}
								catalogueHarnessScope={catalogueHarnessScope}
								displayCache={displayCache}
								settingsNotice={settings?.notice}
								onBack={
									fromEffort
										? () => {
												setFromEffort(false)
												setView('effort')
											}
										: undefined
								}
								onChoose={choose}
								engine={engineOf('models')}
							/>
						)}
					</div>
				</div>
			</PopoverPopup>
		</Popover>
	)
}

/**
 * Swapping the popover between the effort panel and the model list changes its height; the
 * wrapper follows the content's measured height so the change eases instead of jumping. The first
 * measurement sets the height without a transition.
 */
function useAnimatedHeight(open: boolean) {
	const resize = useRef<HTMLDivElement>(null)
	const [height, setHeight] = useState<number>()
	const observer = useRef<ResizeObserver>(null)
	const measured = useCallback((node: HTMLDivElement | null) => {
		observer.current?.disconnect()
		observer.current = null
		if (!node || typeof ResizeObserver === 'undefined') return
		const next = new ResizeObserver(() => setHeight(node.offsetHeight))
		next.observe(node)
		observer.current = next
		setHeight(node.offsetHeight)
	}, [])
	useEffect(() => {
		if (!open) setHeight(undefined)
	}, [open])
	const resizeStyle: CSSProperties | undefined =
		height === undefined ? undefined : { height: `${height}px` }
	return { resize, measured, resizeStyle }
}

type CatalogueRows = ModelCatalogueView['models']

/**
 * The current provider's catalogue rows, read as soon as selection is ready. The shared display
 * cache deduplicates the request, so the open menu and every composer reuse one read. The last
 * rows seen stay in use while the cache re-reads, so the trigger never flickers back to an id.
 */
function useChoiceCatalogue({
	displayCache,
	provider,
	providers,
	projectId,
	sessionId,
	loadCatalogue,
	harnessScope,
	enabled,
}: {
	displayCache: ModelCatalogueDisplayCache
	provider: Provider | undefined
	providers: ProviderView
	projectId: string
	sessionId?: string
	loadCatalogue?: (provider: string) => Promise<ModelCatalogueView>
	harnessScope?: string
	enabled: boolean
}): CatalogueRows | undefined {
	const version = useSyncExternalStore(
		displayCache.subscribe,
		displayCache.version,
		displayCache.version,
	)
	const scope = provider
		? displayCache.scope({
				projectId,
				sessionId,
				provider,
				available: providers.available,
				harnessScope,
			})
		: undefined
	const snapshot = scope ? displayCache.peek(scope) : { state: 'idle' as const }
	const identity = JSON.stringify([projectId, sessionId, harnessScope, provider?.id])
	const last = useRef<{ identity: string; rows: CatalogueRows }>(null)
	if (snapshot.state === 'ready') last.current = { identity, rows: snapshot.value.models }
	const rows = snapshot.state === 'ready' ? snapshot.value.models : undefined
	useEffect(() => {
		void version
		if (!enabled || !provider || !scope || !projectId) return
		if (displayCache.peek(scope).state !== 'idle') return
		const read = () =>
			loadCatalogue
				? loadCatalogue(provider.id)
				: window.namzu.models(projectId, provider.id, sessionId)
		// The shared cache publishes the error; the menu retries once per opening.
		displayCache.load(scope, read).catch(() => {})
	}, [enabled, provider, scope, projectId, sessionId, loadCatalogue, displayCache, version])
	return rows ?? (last.current?.identity === identity ? last.current.rows : undefined)
}

function ModelBrowser({
	providers,
	choice,
	projectId,
	sessionId,
	onChoose,
	loadCatalogue,
	catalogueHarnessScope,
	displayCache,
	onBack,
	settingsNotice,
	engine,
}: {
	providers: ProviderView
	choice: ModelChoice
	projectId: string
	sessionId?: string
	loadCatalogue?: (provider: string) => Promise<ModelCatalogueView>
	catalogueHarnessScope?: string
	displayCache: ModelCatalogueDisplayCache
	onChoose: (choice: ModelChoice) => void
	/** Present when the list was opened from the effort panel. */
	onBack?: () => void
	settingsNotice?: string
	/** The engine chip for the heading, when engines are offered. */
	engine?: { id: HarnessView['selected']; label: string; disabled: boolean; onOpen: () => void }
}) {
	const [providerId, setProviderId] = useState(choice.provider)
	const [catalogues, setCatalogues] = useState<Record<string, Catalogue>>({})
	const inFlight = useRef(new Set<string>())
	const uncachedScopes = useRef(new Map<string, string>())
	const currentScopes = useRef(new Map<string, string>())
	const mounted = useRef(true)
	const cacheVersion = useSyncExternalStore(
		displayCache.subscribe,
		displayCache.version,
		displayCache.version,
	)
	const [searching, setSearching] = useState(false)
	const [query, setQuery] = useState('')
	const search = useRef<HTMLInputElement>(null)
	const results = useRef<HTMLDivElement>(null)
	// A failure left by an earlier opening is re-read once; the next opening starts afresh.
	const retried = useRef(new Set<string>())
	const active =
		providers.available.find((provider) => provider.id === providerId) ?? providers.available[0]
	const multipleProviders = providers.available.length > 1
	useEffect(() => {
		mounted.current = true
		return () => {
			mounted.current = false
		}
	}, [])
	const scopeFor = useCallback(
		(provider: Provider) =>
			displayCache.scope({
				projectId,
				sessionId,
				provider,
				available: providers.available,
				harnessScope: catalogueHarnessScope,
			}),
		[displayCache, projectId, sessionId, providers.available, catalogueHarnessScope],
	)
	useLayoutEffect(() => {
		void cacheVersion
		currentScopes.current = new Map(
			providers.available.map((provider) => [provider.id, scopeFor(provider).key]),
		)
	}, [providers.available, scopeFor, cacheVersion])
	const read = useCallback(
		(provider: Provider) =>
			loadCatalogue
				? loadCatalogue(provider.id)
				: window.namzu.models(projectId, provider.id, sessionId),
		[loadCatalogue, projectId, sessionId],
	)
	const load = useCallback(
		(provider: Provider, refresh = false) => {
			const scope = scopeFor(provider)
			if (
				!refresh &&
				(inFlight.current.has(scope.key) || uncachedScopes.current.get(provider.id) === scope.key)
			)
				return
			if (!refresh && displayCache.peek(scope).state !== 'idle') return
			inFlight.current.add(scope.key)
			uncachedScopes.current.delete(provider.id)
			setCatalogues((all) => {
				const next = { ...all }
				delete next[provider.id]
				return next
			})
			void displayCache
				.load(scope, () => read(provider), refresh)
				.then((result) => {
					if (
						mounted.current &&
						result.current &&
						!result.retained &&
						currentScopes.current.get(provider.id) === scope.key
					) {
						uncachedScopes.current.set(provider.id, scope.key)
						setCatalogues((all) => ({
							...all,
							[provider.id]: { scopeKey: scope.key, loading: false, value: result.value },
						}))
					}
				})
				.catch(() => {
					/* The shared cache publishes the retryable generic error. */
				})
				.finally(() => {
					inFlight.current.delete(scope.key)
				})
		},
		[displayCache, read, scopeFor],
	)
	useEffect(() => {
		// A project or engine rebind invalidates the cache without remounting this popup.
		void cacheVersion
		const targets = searching ? providers.available : active ? [active] : []
		for (const provider of targets) load(provider)
	}, [active, providers.available, searching, load, cacheVersion])
	useEffect(() => {
		void cacheVersion
		const targets = searching ? providers.available : active ? [active] : []
		for (const provider of targets) {
			if (retried.current.has(provider.id)) continue
			// Only a failure that predates this opening is retried; a read started by this
			// opening that fails is left alone, so one opening never reads twice in a row.
			retried.current.add(provider.id)
			if (displayCache.peek(scopeFor(provider)).state === 'error') load(provider, true)
		}
	}, [active, providers.available, searching, load, cacheVersion, displayCache, scopeFor])
	useEffect(() => {
		if (searching) search.current?.focus({ preventScroll: true })
	}, [searching])
	const shownProviders = searching ? providers.available : active ? [active] : []
	const catalogueFor = (provider: Provider): Catalogue | undefined => {
		const scope = scopeFor(provider)
		const snapshot = displayCache.peek(scope)
		if (snapshot.state === 'ready') return { loading: false, value: snapshot.value }
		// The last good list stays on screen while a re-read runs or after one fails.
		const known = displayCache.lastKnown(scope)
		if (snapshot.state === 'loading')
			return known ? { loading: false, value: known } : { loading: true }
		if (snapshot.state === 'error') return { loading: false, value: known, error: LOAD_FAILED }
		const local = catalogues[provider.id]
		if (local && (local.scopeKey === undefined || local.scopeKey === scope.key)) return local
		// An expired or updated scope reads again; its previous rows stay up meanwhile.
		return known ? { loading: false, value: known } : undefined
	}
	const shownCatalogues = new Map(
		shownProviders.map((provider) => [provider.id, catalogueFor(provider)]),
	)
	const models = shownProviders.flatMap((provider) =>
		(shownCatalogues.get(provider.id)?.value?.models ?? []).map((model) => ({
			...model,
			provider,
		})),
	)
	const filtered = models.filter((model) =>
		`${model.label} ${model.id} ${model.provider.label}`
			.toLowerCase()
			.includes(query.trim().toLowerCase()),
	)
	const loading = shownProviders.some(
		(provider) => !shownCatalogues.get(provider.id) || shownCatalogues.get(provider.id)?.loading,
	)
	// A short single-engine list needs no search; it appears with a long list.
	const showTools = multipleProviders || searching || models.length > 12
	const errors = shownProviders.filter((provider) => shownCatalogues.get(provider.id)?.error)
	const notices = shownProviders.flatMap((provider) => {
		const notice = shownCatalogues.get(provider.id)?.value?.notice
		return notice ? [{ provider, notice }] : []
	})
	const sharedNotes = new Map<string, string>()
	for (const provider of shownProviders) {
		const listed = shownCatalogues.get(provider.id)?.value?.models ?? []
		const note = listed[0]?.note?.trim()
		if (note && listed.length > 1 && listed.every((model) => model.note?.trim() === note))
			sharedNotes.set(provider.id, note)
	}
	const groups = shownProviders.flatMap((provider) => {
		const rows = filtered.filter((model) => model.provider.id === provider.id)
		return rows.length ? [{ provider, rows }] : []
	})
	const modelKey = (provider: string, model: string) => JSON.stringify([provider, model])
	const toChoice = (model: (typeof models)[number]): ModelChoice => ({
		provider: model.provider.id,
		model: model.id,
		label: model.label,
	})
	// The engine's own recommendation leads the list, but only for the provider on screen.
	const recommended = searching
		? undefined
		: defaultModelRow(shownCatalogues.get(active?.id ?? '')?.value?.models, active?.defaultModel)
	const followsDefault = !searching && choice.preset === 'default' && choice.provider === active?.id
	const selectedKey = followsDefault
		? DEFAULT_KEY
		: modelKey(
				choice.provider,
				choice.model ||
					providers.available.find((provider) => provider.id === choice.provider)?.defaultModel ||
					'',
			)
	const chooseDefault = () => {
		if (active && recommended)
			onChoose({
				provider: active.id,
				model: recommended.id,
				label: recommended.label,
				preset: 'default',
			})
	}
	// Opening the list puts the keyboard on the checked row, so arrows start from the current model.
	// The popup reclaims focus when the control that was clicked to get here unmounts, so focus is
	// placed again once that has settled.
	const focused = useRef(false)
	const settled = !loading && filtered.length > 0
	useEffect(() => {
		if (focused.current || !settled) return
		focused.current = true
		const place = () => {
			const root = results.current
			if (!root || root.contains(document.activeElement)) return
			if (document.activeElement instanceof HTMLInputElement) return
			;(
				root.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]') ??
				root.querySelector<HTMLElement>('[role="radio"]')
			)?.focus({ preventScroll: true })
		}
		place()
		const frame = requestAnimationFrame(place)
		return () => cancelAnimationFrame(frame)
	}, [settled])
	const lineUp = (
		<div className="model-lineup">
			<header className="model-picker-heading">
				{searching ? (
					<div className="model-search">
						<SearchIcon aria-hidden="true" />
						<Input
							nativeInput
							unstyled
							ref={search}
							type="search"
							aria-label="Search models"
							placeholder="Search all models…"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							onKeyDown={(event) => {
								if (event.nativeEvent.isComposing) return
								if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
									const rows = results.current?.querySelectorAll<HTMLElement>('[role="radio"]')
									const row = event.key === 'ArrowDown' ? rows?.[0] : rows?.[rows.length - 1]
									if (row) {
										event.preventDefault()
										row.focus()
									}
								} else if (event.key === 'Enter' && filtered[0]) {
									event.preventDefault()
									onChoose(toChoice(filtered[0]))
								}
							}}
						/>
						<Button
							size="icon-xs"
							variant="ghost-muted"
							aria-label="Close model search"
							onClick={() => {
								setSearching(false)
								setQuery('')
							}}
						>
							<XIcon />
						</Button>
					</div>
				) : (
					<>
						<div className="model-picker-heading-copy">
							{onBack && (
								<button type="button" className="model-picker-back" onClick={onBack}>
									<ChevronLeft aria-hidden="true" />
									Effort
								</button>
							)}
							<h2 className="model-picker-title">Choose a model</h2>
							{multipleProviders && !onBack && (
								<span className="model-picker-provider-label" title={active?.label}>
									{active?.label}
								</span>
							)}
						</div>
						{(showTools || engine) && (
							<div className="model-picker-heading-actions">
								{engine && (
									<EngineChip
										engine={engine.id}
										label={engine.label}
										disabled={engine.disabled}
										onClick={engine.onOpen}
									/>
								)}
								{showTools && (
									<Button
										variant="ghost-muted"
										size="icon-xs"
										aria-label="Search models"
										title="Search models (/)"
										onClick={() => setSearching(true)}
									>
										<SearchIcon aria-hidden="true" />
									</Button>
								)}
							</div>
						)}
					</>
				)}
			</header>
			<div ref={results} className="model-picker-list">
				<RadioGroup
					aria-label={searching ? 'Search results' : `${active?.label ?? ''} models`}
					value={selectedKey}
					// Arrow keys only move the highlight; a choice is made by click, Enter or Space.
					onValueChange={() => {}}
				>
					{groups.map(({ provider, rows }, groupIndex) => (
						<fieldset
							key={provider.id}
							className="model-picker-section"
							aria-label={provider.label}
						>
							{searching && (
								<legend className="model-picker-section-title">{provider.label}</legend>
							)}
							{groupIndex === 0 && recommended && (
								<Radio.Root
									value={DEFAULT_KEY}
									nativeButton
									render={<button type="button" />}
									className="model-picker-row"
									aria-label={`Default, recommended: ${recommended.label}`}
									onClick={(event) => {
										event.preventDefault()
										chooseDefault()
									}}
									onKeyDown={(event) => {
										if (commitsOnKey(event.key)) {
											event.preventDefault()
											chooseDefault()
										}
									}}
								>
									<span className="model-picker-name">
										<span>Default</span>
										<small>Recommended · {recommended.label}</small>
									</span>
									<span className="model-picker-selection" aria-hidden="true">
										<Radio.Indicator className="model-picker-checked">
											<CheckIcon aria-hidden="true" />
										</Radio.Indicator>
									</span>
								</Radio.Root>
							)}
							{rows.map((model) => (
								<Radio.Root
									key={modelKey(model.provider.id, model.id)}
									value={modelKey(model.provider.id, model.id)}
									nativeButton
									render={<button type="button" />}
									className="model-picker-row"
									aria-label={[
										model.provider.label,
										model.label,
										model.note?.trim(),
										isNewModel(model.firstSeen, Date.now()) ? 'New' : undefined,
									]
										.filter(Boolean)
										.join(' ')}
									onClick={(event) => {
										event.preventDefault()
										onChoose(toChoice(model))
									}}
									onKeyDown={(event) => {
										if (commitsOnKey(event.key)) {
											event.preventDefault()
											onChoose(toChoice(model))
										}
									}}
								>
									<span className="model-picker-name">
										<span title={`${model.label} · ${model.id}`}>{model.label}</span>
										{model.note && sharedNotes.get(model.provider.id) !== model.note.trim() && (
											<small>{model.note}</small>
										)}
									</span>
									{isNewModel(model.firstSeen, Date.now()) && (
										<span className="model-picker-new" aria-hidden="true">
											New
										</span>
									)}
									<span className="model-picker-selection" aria-hidden="true">
										<Radio.Indicator className="model-picker-checked">
											<CheckIcon aria-hidden="true" />
										</Radio.Indicator>
									</span>
								</Radio.Root>
							))}
						</fieldset>
					))}
				</RadioGroup>
				{loading && (
					<output className="model-picker-status">
						<LoaderCircleIcon className="model-picker-loading" aria-hidden="true" />
						Loading models…
					</output>
				)}
				{!loading && filtered.length === 0 && errors.length === 0 && (
					<output className="model-picker-status">
						{query ? 'No matching listed models.' : 'No models listed.'}
					</output>
				)}
			</div>
			{(errors.length > 0 || notices.length > 0 || sharedNotes.size > 0 || settingsNotice) && (
				<div className="model-picker-feedback" aria-label="Model catalogue information">
					{settingsNotice && <p className="model-picker-settings-notice">{settingsNotice}</p>}
					{errors.length > 0 && <p className="model-picker-quiet">{LOAD_FAILED}</p>}
					{shownProviders.map((provider) => {
						const note = sharedNotes.get(provider.id)
						if (!note || note === shownCatalogues.get(provider.id)?.value?.notice?.trim())
							return null
						return (
							<p key={provider.id} className="model-picker-shared-note" title={note}>
								{searching && `${provider.label}: `}
								{note}
							</p>
						)
					})}
					{notices.map(({ provider, notice }) => (
						<div key={provider.id} className="model-picker-notice">
							<span>
								{searching && `${provider.label}: `}
								{notice}
							</span>
						</div>
					))}
				</div>
			)}
		</div>
	)
	const searchShortcut = (event: KeyboardEvent) => {
		if (showTools && event.key === '/' && !(event.target instanceof HTMLInputElement)) {
			event.preventDefault()
			setSearching(true)
		}
	}
	if (!multipleProviders)
		return (
			<div className="model-provider-single" onKeyDown={searchShortcut}>
				{lineUp}
			</div>
		)
	return (
		<Tabs.Root
			orientation="vertical"
			value={active?.id ?? null}
			onValueChange={(value) => {
				setProviderId(String(value))
				setQuery('')
				setSearching(false)
			}}
			className="model-provider-tabs"
			onKeyDown={searchShortcut}
		>
			<Tabs.List aria-label="Model providers" className="model-provider-list">
				{providers.available.map((provider) => (
					<Tooltip key={provider.id}>
						<TooltipTrigger
							render={
								<Tabs.Tab
									value={provider.id}
									aria-label={provider.label}
									className="model-provider-tab"
									data-in-use={provider.id === choice.provider ? '' : undefined}
								/>
							}
						>
							<ProviderMark provider={provider} />
						</TooltipTrigger>
						<TooltipPopup side="left">
							{provider.id === choice.provider ? `${provider.label} (in use)` : provider.label}
						</TooltipPopup>
					</Tooltip>
				))}
			</Tabs.List>
			{active && (
				<Tabs.Panel key={active.id} value={active.id} className="model-provider-panel">
					{lineUp}
				</Tabs.Panel>
			)}
		</Tabs.Root>
	)
}
