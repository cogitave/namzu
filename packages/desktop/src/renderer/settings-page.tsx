import { Dialog } from '@base-ui/react/dialog'
import { Activity, Bot, KeyRound, SquareTerminal, Volume2, Wrench } from 'lucide-react'
import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { newerKernelText } from '../shared/engine-update-protocol.js'
import type { ProjectView } from '../shared/protocol.js'
import {
	type CatalogueEntry,
	type CatalogueOption,
	appliesText,
	catalogueEntry,
} from '../shared/settings-catalogue.js'
import type {
	DataFolderKind,
	DesktopInfo,
	DesktopSettings,
	SettingsSection,
	StartupBehavior,
} from '../shared/settings-protocol.js'
import type { UpdateInfo, UpdateState } from '../shared/update-protocol.js'
import { OWN_ROW_CONFIG_PATHS, configSearchEntries } from './config-settings-model.js'
import { ConfigSettingsGroup } from './config-settings-section.js'
import { copyPlainText } from './copy-button.js'
import { engineSourceText, engineStatusText, plainVersion } from './engine-delivery-model.js'
import { EngineUpdateRows, type EngineUpdateTarget } from './engine-updates-section.js'
import { HooksRows } from './hooks-section.js'
import {
	DownloadIcon,
	FoldersIcon,
	type IconComponent,
	InfoIcon,
	MonitorIcon,
	MoonIcon,
	SearchIcon,
	SettingsIcon,
	SunIcon,
	XIcon,
} from './icons.js'
import { INTERFACE_FONT_CHOICES, useInterfaceFont } from './interface-font.js'
import { LocalListeningSettingsContent } from './local-listening-settings.js'
import { LocalSpeechSettingsContent } from './local-speech-settings.js'
import { McpServersRows } from './mcp-servers-section.js'
import { ModelsSection } from './models-section.js'
import { middleEllipsis, tildePath } from './path-display.js'
import { SettingsConfirmDialog } from './settings-confirm-dialog.js'
import {
	DATA_FOLDER_NOTES,
	SETTINGS_ENTRIES,
	SETTINGS_SEARCH_SUBTITLE,
	SETTINGS_SECTION_SUBTITLES,
	SETTINGS_SECTION_TITLES,
	type SettingsEntry,
	aboutDetailsText,
	lastCheckedText,
	platformText,
	projectTrustText,
	searchSettings,
	updateStatusView,
	visibleNavGroups,
} from './settings-model.js'
import { Row, Switch } from './settings-row.js'
import type { Appearance } from './sidebar.js'
import { Button } from './ui/button.js'
import { useClock } from './use-clock.js'
import { type ConfigSettingsControls, useConfigSettings } from './use-config-settings.js'
import type { DesktopSettingsControls } from './use-desktop-settings.js'
import { useEngineDelivery } from './use-engine-delivery.js'
import { useEngineUpdates } from './use-engine-updates.js'
import { useHooksView } from './use-hooks-view.js'
import type { LocalListeningControls } from './use-local-listening.js'
import type { LocalSpeechControls } from './use-local-speech.js'
import { useMcpServers } from './use-mcp-servers.js'
import { useProviderConnections } from './use-provider-connections.js'
import './settings-page.css'

const SECTION_ICONS: Record<SettingsSection, IconComponent> = {
	general: SettingsIcon,
	models: KeyRound as IconComponent,
	agent: Bot as IconComponent,
	tools: Wrench as IconComponent,
	projects: FoldersIcon,
	appearance: SunIcon,
	terminal: SquareTerminal as IconComponent,
	telemetry: Activity as IconComponent,
	updates: DownloadIcon,
	speech: Volume2 as IconComponent,
	about: InfoIcon,
}

/**
 * The left column: the search field on top, then the sections in groups with a hairline between
 * them. While a search is typed only the sections with a match are listed. It never scrolls.
 */
export function SettingsSidebar({
	section,
	onSection,
	query = '',
	onQuery = () => undefined,
	matches,
	searchRef,
}: {
	section: SettingsSection
	onSection: (section: SettingsSection) => void
	query?: string
	onQuery?: (query: string) => void
	/** The search results; their sections are the ones listed. Absent: every section. */
	matches?: readonly SettingsEntry[]
	searchRef?: React.RefObject<HTMLInputElement | null>
}) {
	const groups = visibleNavGroups(matches)
	return (
		<div className="settings-sidebar-content">
			<div className="settings-nav-search">
				<SearchIcon aria-hidden="true" />
				<input
					ref={searchRef}
					type="search"
					aria-label="Search settings"
					placeholder="Search"
					value={query}
					autoComplete="off"
					spellCheck={false}
					onChange={(event) => onQuery(event.target.value)}
				/>
				{query && (
					<Button
						variant="ghost-muted"
						size="icon-xs"
						aria-label="Clear settings search"
						onClick={() => {
							onQuery('')
							searchRef?.current?.focus()
						}}
					>
						<XIcon aria-hidden="true" />
					</Button>
				)}
			</div>
			<nav className="settings-sidebar-navigation" aria-label="Settings sections">
				{groups.map((group, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: the groups are a fixed list
					<div key={index} className="settings-nav-group">
						{group.map((id) => {
							const Icon = SECTION_ICONS[id]
							return (
								<button
									key={id}
									type="button"
									aria-current={section === id ? 'page' : undefined}
									onClick={() => onSection(id)}
								>
									<Icon aria-hidden="true" />
									<span>{SETTINGS_SECTION_TITLES[id]}</span>
								</button>
							)
						})}
					</div>
				))}
				{groups.length === 0 && <p className="settings-nav-empty">No section matches.</p>}
			</nav>
		</div>
	)
}

export interface SettingsPageProps {
	section: SettingsSection
	onSection: (section: SettingsSection, focusId?: string) => void
	/** A setting the page should scroll to and focus after it renders, from a search result. */
	focusId?: string
	/** Changes with every ask to open Settings, so a search typed earlier gives way to the one asked for. */
	request?: number
	settings: DesktopSettingsControls
	appearance: Appearance
	onAppearanceChange: (value: Appearance) => void
	/** Ordinary projects only: no Pal workspace, no chat. */
	projects: ProjectView[]
	onRemoveProject?: (project: ProjectView, trigger: HTMLElement | null) => void
	/** Points a project whose folder is gone at its new place; absent where the window cannot ask. */
	onLocateProject?: (project: ProjectView) => void
	/** Absent in a window that has no updater. */
	update?: {
		state: UpdateState
		info?: UpdateInfo
		onOpen: () => void
		onCheck: () => void
		onDownload?: () => void
	}
	/** Where an engine update's terminal tab opens: this pane and the project in front. */
	engineTarget?: EngineUpdateTarget
	speech: LocalSpeechControls
	/** The downloaded voice input engine (speech to text). */
	listening: LocalListeningControls
	info?: DesktopInfo
	infoError?: string
	onOpenFolder?: (kind: DataFolderKind) => void
	/** The clock is passed in so relative times are deterministic in tests. */
	now: number
}

type ShellChoice = { value: string; label: string }

/** The shells a new terminal tab can open; `undefined` until main answers, `null` where there are no terminals. */
function useTerminalShells(): ShellChoice[] | null | undefined {
	const bridge = typeof window === 'undefined' ? undefined : window.namzu
	const [shells, setShells] = useState<ShellChoice[]>()
	useEffect(() => {
		let live = true
		void bridge?.terminalShells?.().then(
			(list) => live && setShells(list),
			() => undefined,
		)
		return () => {
			live = false
		}
	}, [bridge])
	return bridge?.terminalShells ? shells : null
}

/** What the dialog's search needs from the engine's rows and the machine, and what it found. */
interface SettingsSearch {
	query: string
	results: SettingsEntry[]
	shells: ShellChoice[] | null | undefined
	config: ConfigSettingsControls
	hasAppUpdater: boolean
}

function useSettingsSearch(query: string, update: SettingsPageProps['update']): SettingsSearch {
	const shells = useTerminalShells()
	const config = useConfigSettings(typeof window === 'undefined' ? undefined : window.namzu, true)
	const delivery = useEngineDelivery()
	// A row that does nothing here is neither shown nor found by search.
	const hasShellChoice = (shells?.length ?? 0) > 1
	const hasAppUpdater = update !== undefined && update.state.status !== 'disabled'
	const results = searchSettings(
		query,
		[...SETTINGS_ENTRIES, ...configSearchEntries(config.view)].filter(
			(entry) =>
				// Shown as “Run hooks” in its own place, so the plain setting is not a second result.
				entry.id !== 'cfg-disableHooks' &&
				(entry.id !== 'terminal-shell' || hasShellChoice) &&
				(entry.id !== 'terminal-restore' || shells !== null) &&
				(entry.id !== 'auto-download' || hasAppUpdater) &&
				// Drawn only in a build that can fetch engines.
				((entry.id !== 'engine-delivery' && entry.id !== 'keep-engine') || delivery !== undefined),
		),
	)
	return { query, results, shells, config, hasAppUpdater }
}

/** The page's content on its own: the search is typed elsewhere and passed in as `query`. */
export function SettingsPage(props: SettingsPageProps & { query?: string }) {
	const search = useSettingsSearch(props.query ?? '', props.update)
	return <SettingsContent {...props} search={search} />
}

function SettingsContent(
	props: SettingsPageProps & { search: SettingsSearch; onQuery?: (query: string) => void },
) {
	const { section, focusId, search } = props
	const { query, results, shells, config, hasAppUpdater } = search
	const searching = query.trim().length > 0
	const page = useRef<HTMLElement>(null)
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new target or section is the trigger.
	useEffect(() => {
		if (!focusId || searching) return
		const land = (): boolean => {
			const row = document.getElementById(`setting-${focusId}`)
			if (!row) return false
			row.scrollIntoView?.({ block: 'center' })
			const control = row.querySelector<HTMLElement>(
				'input:not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled), summary, [tabindex]',
			)
			if (control) control.focus({ preventScroll: true })
			else {
				// A row with nothing to press (a list) takes the focus itself.
				row.tabIndex = -1
				row.focus({ preventScroll: true })
			}
			return true
		}
		if (land()) return
		// Some rows are drawn once their facts arrive (About, the engine's list): land when it is there.
		const content = page.current
		if (!content || typeof MutationObserver === 'undefined') return
		const watch = new MutationObserver(() => {
			if (land()) watch.disconnect()
		})
		watch.observe(content, { childList: true, subtree: true })
		return () => watch.disconnect()
	}, [focusId, section, searching, props.request, config.view !== undefined])
	return (
		<section
			ref={page}
			id="settings-content"
			className="settings-page"
			aria-label="Settings"
			tabIndex={-1}
		>
			<div className="settings-page-content">
				<header className="settings-page-header">
					<div>
						<h1>{searching ? 'Search results' : SETTINGS_SECTION_TITLES[section]}</h1>
						<p>{searching ? SETTINGS_SEARCH_SUBTITLE : SETTINGS_SECTION_SUBTITLES[section]}</p>
					</div>
				</header>
				{props.settings.error && (
					<p role="alert" className="settings-error">
						{props.settings.error}
					</p>
				)}
				{searching ? (
					<section aria-label="Search results" className="settings-results">
						<h2 className="settings-section-title">
							{results.length
								? `${results.length} ${results.length === 1 ? 'result' : 'results'}`
								: 'No results'}
						</h2>
						{results.length === 0 && (
							<p className="settings-help">
								No setting matches “{query.trim()}”. Try a shorter word, like “update” or “theme”.
							</p>
						)}
						<ul>
							{results.map((entry) => (
								<li key={entry.id}>
									<button
										type="button"
										onClick={() => {
											props.onQuery?.('')
											props.onSection(entry.section, entry.id)
										}}
									>
										<span className="settings-result-label">{entry.label}</span>
										<span className="settings-result-section">
											{SETTINGS_SECTION_TITLES[entry.section]}
										</span>
										<span className="settings-result-description">{entry.description}</span>
									</button>
								</li>
							))}
						</ul>
					</section>
				) : (
					<SectionBody {...props} shells={shells} hasAppUpdater={hasAppUpdater} config={config} />
				)}
			</div>
		</section>
	)
}

export interface SettingsDialogProps extends SettingsPageProps {
	onClose: () => void
	/** Where the focus goes when the dialog closes: the control that opened it. */
	returnFocus?: () => HTMLElement | null
	/** A confirmation another part of the app asks while Settings is open; it stacks above this dialog. */
	stacked?: ReactNode
}

/**
 * Settings as a dialog over the app: a title band, the sections and their search on the left, the
 * chosen section on the right. The app behind is inert and dimmed. Esc clears a typed search first
 * and then closes; so do the X button and a click on the dimmed area.
 */
export function SettingsDialog({ onClose, returnFocus, stacked, ...props }: SettingsDialogProps) {
	// Set by the layout while it is mounted: clears a typed search and says whether there was one.
	const clearSearch = useRef<() => boolean>(() => false)
	const search = useRef<HTMLInputElement>(null)
	return (
		<Dialog.Root
			open
			onOpenChange={(open, details) => {
				if (open) return
				if (details.reason === 'escape-key' && clearSearch.current()) {
					details.cancel()
					return
				}
				onClose()
			}}
		>
			<Dialog.Portal>
				<Dialog.Backdrop className="settings-dialog-scrim" />
				<Dialog.Viewport className="settings-dialog-viewport">
					<Dialog.Popup
						className="settings-dialog"
						aria-modal="true"
						initialFocus={() => (props.focusId ? false : search.current)}
						finalFocus={returnFocus}
					>
						<header className="settings-dialog-title">
							<Dialog.Title>Settings</Dialog.Title>
							<Dialog.Close
								className="settings-dialog-close"
								aria-label="Close settings"
								render={<Button variant="ghost-muted" size="icon-xs" />}
							>
								<XIcon aria-hidden="true" />
							</Dialog.Close>
						</header>
						<SettingsDialogLayout {...props} clearSearch={clearSearch} searchRef={search} />
						{stacked}
					</Dialog.Popup>
				</Dialog.Viewport>
			</Dialog.Portal>
		</Dialog.Root>
	)
}

function SettingsDialogLayout({
	clearSearch,
	searchRef,
	...props
}: SettingsPageProps & {
	clearSearch: React.RefObject<() => boolean>
	searchRef: React.RefObject<HTMLInputElement | null>
}) {
	const [query, setQuery] = useState('')
	const search = useSettingsSearch(query, props.update)
	const searching = query.trim().length > 0
	// biome-ignore lint/correctness/useExhaustiveDependencies: an ask from outside is the trigger
	useEffect(() => setQuery(''), [props.section, props.focusId, props.request])
	clearSearch.current = () => {
		if (!query) return false
		setQuery('')
		return true
	}
	return (
		<div className="settings-dialog-body">
			<aside className="settings-dialog-nav" aria-label="Settings navigation">
				<SettingsSidebar
					section={props.section}
					onSection={(section) => {
						setQuery('')
						props.onSection(section)
					}}
					query={query}
					onQuery={setQuery}
					matches={searching ? search.results : undefined}
					searchRef={searchRef}
				/>
			</aside>
			<SettingsContent {...props} search={search} onQuery={setQuery} />
		</div>
	)
}

interface SectionProps extends SettingsPageProps {
	shells: ShellChoice[] | null | undefined
	hasAppUpdater: boolean
	config: ConfigSettingsControls
}

/** The page heading above is the section's name, so the body does not repeat it. */
function SectionBody(props: SectionProps) {
	return (
		<div className="settings-section" data-section={props.section}>
			{props.section === 'general' && <GeneralSection {...props} />}
			{props.section === 'models' && <ModelsContainer />}
			{props.section === 'tools' && <McpServersContainer {...props} />}
			{props.section === 'tools' && <HooksContainer {...props} />}
			{props.section === 'projects' && <ProjectsSection {...props} />}
			{props.section === 'appearance' && <AppearanceSection {...props} />}
			{props.section === 'updates' && <UpdatesSection {...props} />}
			{(props.section === 'general' ||
				props.section === 'models' ||
				props.section === 'agent' ||
				props.section === 'tools' ||
				props.section === 'projects' ||
				props.section === 'terminal' ||
				props.section === 'telemetry' ||
				props.section === 'updates') && (
				<ConfigSettingsGroup
					section={props.section}
					config={props.config}
					omit={props.section === 'tools' ? OWN_ROW_CONFIG_PATHS : undefined}
					heading={
						props.section === 'general' ||
						props.section === 'models' ||
						props.section === 'projects' ||
						props.section === 'updates'
							? 'Namzu settings'
							: undefined
					}
				/>
			)}
			{props.section === 'speech' && <SpeechSection {...props} />}
			{props.section === 'about' && <AboutSection {...props} />}
		</div>
	)
}

function McpServersContainer({ engineTarget, projects }: SectionProps) {
	const bridge = typeof window === 'undefined' ? undefined : window.namzu
	const projectId = engineTarget?.projectId
	const servers = useMcpServers(bridge, projectId)
	return (
		<McpServersRows
			servers={servers}
			projectName={projects.find((project) => project.id === projectId)?.name}
		/>
	)
}

function HooksContainer({ engineTarget, projects, config }: SectionProps) {
	const bridge = typeof window === 'undefined' ? undefined : window.namzu
	const projectId = engineTarget?.projectId
	const hooks = useHooksView(bridge, projectId)
	return (
		<HooksRows
			hooks={hooks}
			config={config}
			projectName={projects.find((project) => project.id === projectId)?.name}
		/>
	)
}

function ModelsContainer() {
	const bridge = typeof window === 'undefined' ? undefined : window.namzu
	return <ModelsSection connections={useProviderConnections(bridge, true)} />
}

const STARTUP_CHOICES = (
	catalogueEntry('startup').control as { options: readonly CatalogueOption[] }
).options.map((option) => ({
	value: option.value as StartupBehavior,
	label: option.label,
	hint: option.help ?? '',
}))

/** The line under a row's description: its default and when a change applies, from the catalogue. */
function catalogueMeta(entry: CatalogueEntry): string {
	const fallback = entry.default
	let defaultLine = ''
	if (typeof fallback === 'boolean') defaultLine = `Default: ${fallback ? 'On' : 'Off'}.`
	else if (typeof fallback === 'string' && entry.control.kind === 'select') {
		const label = entry.control.options.find((option) => option.value === fallback)?.label
		if (label) defaultLine = `Default: ${label}.`
	}
	return [defaultLine, appliesText(entry)].filter(Boolean).join(' ')
}

/** A row whose label, help, default and apply time all come from the settings catalogue. */
function CatalogueRow({
	id,
	stacked,
	children,
}: { id: string; stacked?: boolean; children?: ReactNode }) {
	const entry = catalogueEntry(id)
	return (
		<Row
			id={id}
			label={entry.label}
			description={entry.description}
			meta={catalogueMeta(entry)}
			stacked={stacked}
		>
			{children}
		</Row>
	)
}

function GeneralSection({ settings, shells }: SectionProps) {
	const group = useId()
	const value = settings.settings?.startup
	return (
		<>
			<CatalogueRow id="startup" stacked>
				<fieldset className="settings-choices" disabled={!settings.settings}>
					<legend className="sr-only">When Namzu starts</legend>
					{STARTUP_CHOICES.map((choice) => (
						<label key={choice.value} className="settings-choice">
							<input
								type="radio"
								name={group}
								value={choice.value}
								checked={value === choice.value}
								onChange={() => void settings.change({ startup: choice.value })}
							/>
							<span>
								<span className="settings-choice-label">{choice.label}</span>
								<span className="settings-choice-hint">{choice.hint}</span>
							</span>
						</label>
					))}
				</fieldset>
			</CatalogueRow>
			<CatalogueRow id="attention-signals">
				<Switch
					label="Show when a conversation needs you"
					checked={settings.settings?.attentionSignals ?? true}
					disabled={!settings.settings}
					onChange={(value) => void settings.change({ attentionSignals: value })}
				/>
			</CatalogueRow>
			<CatalogueRow id="notify-needs-you">
				<Switch
					label="Notify me when a conversation needs my answer"
					checked={settings.settings?.notifyNeedsYou ?? true}
					disabled={!settings.settings}
					onChange={(value) => void settings.change({ notifyNeedsYou: value })}
				/>
			</CatalogueRow>
			<CatalogueRow id="notify-failed">
				<Switch
					label="Notify me when a conversation stops with an error"
					checked={settings.settings?.notifyFailed ?? true}
					disabled={!settings.settings}
					onChange={(value) => void settings.change({ notifyFailed: value })}
				/>
			</CatalogueRow>
			<CatalogueRow id="notify-finished">
				<Switch
					label="Notify me when a long reply finishes"
					checked={settings.settings?.notifyFinished ?? true}
					disabled={!settings.settings}
					onChange={(value) => void settings.change({ notifyFinished: value })}
				/>
			</CatalogueRow>
			<CatalogueRow id="notify-sound">
				<Switch
					label="Play a sound with notifications"
					checked={settings.settings?.notifySound ?? false}
					disabled={!settings.settings}
					onChange={(value) => void settings.change({ notifySound: value })}
				/>
			</CatalogueRow>
			<TerminalSettings settings={settings} shells={shells} />
		</>
	)
}

/**
 * The shell a plain terminal tab opens, and whether terminal tabs come back after a restart. The
 * shell row appears only where there is a real choice; with one shell it would have nothing to click.
 */
export function TerminalSettings({
	settings,
	shells,
}: { settings: DesktopSettingsControls; shells: ShellChoice[] | null | undefined }) {
	const group = useId()
	if (shells === null) return null
	const current = settings.settings?.terminalShell
	const choices = shells ?? []
	return (
		<>
			{choices.length > 1 && (
				<CatalogueRow id="terminal-shell" stacked>
					<fieldset className="settings-choices" disabled={!settings.settings}>
						<legend className="sr-only">Default terminal shell</legend>
						{choices.map((choice) => (
							<label key={choice.value} className="settings-choice">
								<input
									type="radio"
									name={group}
									value={choice.value}
									checked={current === choice.value}
									onChange={() =>
										void settings.change({
											terminalShell: choice.value as DesktopSettings['terminalShell'],
										})
									}
								/>
								<span>
									<span className="settings-choice-label">{choice.label}</span>
									{choice.value === 'powershell' ? (
										<span className="settings-choice-hint">
											Can drop some typed Turkish capitals.
										</span>
									) : null}
								</span>
							</label>
						))}
					</fieldset>
				</CatalogueRow>
			)}
			<CatalogueRow id="terminal-restore">
				<Switch
					label="Bring terminal tabs back"
					checked={settings.settings?.restoreTerminals ?? true}
					disabled={!settings.settings}
					onChange={(value) => void settings.change({ restoreTerminals: value })}
				/>
			</CatalogueRow>
			<CatalogueRow id="hardware-acceleration">
				<Switch
					label="Use the graphics card"
					checked={settings.settings?.hardwareAcceleration ?? true}
					disabled={!settings.settings}
					onChange={(value) => void settings.change({ hardwareAcceleration: value })}
				/>
			</CatalogueRow>
		</>
	)
}

function ProjectsSection({
	projects,
	onRemoveProject,
	onLocateProject,
	settings,
}: SettingsPageProps) {
	const switchRow = useRef<HTMLDivElement>(null)
	return (
		<>
			{settings.confirmation && (
				<SettingsConfirmDialog
					onConfirm={settings.confirm}
					onCancel={settings.dismiss}
					returnFocus={() =>
						switchRow.current?.querySelector<HTMLElement>('[role="switch"], input') ?? null
					}
				/>
			)}
			<CatalogueRow id="retrust">
				<div ref={switchRow}>
					<Switch
						label="Ask again when a project’s automatic settings change"
						checked={settings.settings?.retrustOnConfigChange ?? true}
						disabled={!settings.settings}
						onChange={(value) => void settings.change({ retrustOnConfigChange: value })}
					/>
				</div>
			</CatalogueRow>
			<div id="setting-projects" className="settings-projects">
				<h3 className="settings-subtitle">Your projects</h3>
				<p className="settings-help">
					Removing a project only takes it out of Namzu. Your files and existing conversations stay
					where they are. Locate points a moved project at its new folder, and asks you to trust
					that folder.
				</p>
				{projects.length === 0 ? (
					<p className="settings-empty">No projects yet. Open a folder to add one.</p>
				) : (
					<ul className="settings-project-list" aria-label="Projects">
						{projects.map((project) => (
							<li key={project.id} className="settings-project">
								<div className="settings-project-copy">
									<span className="settings-project-name">{project.name}</span>
									<SettingsPath path={project.path} />
								</div>
								<span
									className="settings-badge"
									data-tone={project.status === 'ready' && project.trusted ? 'good' : 'quiet'}
								>
									{projectTrustText(project)}
								</span>
								{project.missing && onLocateProject && (
									<Button
										variant="outline"
										size="sm"
										aria-label={`Locate the folder for ${project.name}`}
										onClick={() => onLocateProject(project)}
									>
										Locate folder
									</Button>
								)}
								{onRemoveProject && (
									<Button
										variant="outline"
										size="sm"
										aria-label={`Remove ${project.name}…`}
										onClick={(event) => onRemoveProject(project, event.currentTarget)}
									>
										Remove…
									</Button>
								)}
							</li>
						))}
					</ul>
				)}
			</div>
		</>
	)
}

const APPEARANCE_CHOICES = [
	{ value: 'light', label: 'Light', Icon: SunIcon },
	{ value: 'dark', label: 'Dark', Icon: MoonIcon },
	{ value: 'system', label: 'System', Icon: MonitorIcon },
] as const

function AppearanceSection({ appearance, onAppearanceChange, settings }: SettingsPageProps) {
	const group = useId()
	const fontGroup = useId()
	const [interfaceFont, setInterfaceFont] = useInterfaceFont()
	return (
		<>
			<CatalogueRow id="theme" stacked>
				<fieldset className="settings-choices settings-choices-inline">
					<legend className="sr-only">Theme</legend>
					{APPEARANCE_CHOICES.map(({ value, label, Icon }) => (
						<label key={value} className="settings-choice settings-choice-tile">
							<input
								type="radio"
								name={group}
								value={value}
								checked={appearance === value}
								onChange={() => onAppearanceChange(value)}
							/>
							<Icon aria-hidden="true" />
							<span className="settings-choice-label">{label}</span>
						</label>
					))}
				</fieldset>
			</CatalogueRow>
			<CatalogueRow id="interface-font" stacked>
				<fieldset className="settings-choices">
					<legend className="sr-only">Interface font</legend>
					{INTERFACE_FONT_CHOICES.map((choice) => (
						<label key={choice.value} className="settings-choice">
							<input
								type="radio"
								name={fontGroup}
								value={choice.value}
								checked={interfaceFont === choice.value}
								onChange={() => setInterfaceFont(choice.value)}
							/>
							<span>
								<span className="settings-choice-label">{choice.label}</span>
								<span className="settings-choice-hint">{choice.hint}</span>
							</span>
						</label>
					))}
				</fieldset>
			</CatalogueRow>
			<CatalogueRow id="conversation-tabs">
				<Switch
					label="Show conversation tabs"
					checked={settings.settings?.showConversationTabs ?? false}
					disabled={!settings.settings}
					onChange={(value) => void settings.change({ showConversationTabs: value })}
				/>
			</CatalogueRow>
		</>
	)
}

function UpdatesSection({
	update,
	settings,
	now: renderedAt,
	engineTarget,
	hasAppUpdater,
}: SectionProps) {
	const engines = useEngineUpdates()
	// The page's own clock, so "Last checked" moves while the section stays open.
	const ticked = useClock(true)
	const opened = useRef({ page: renderedAt, clock: ticked })
	// The time the page gave when this section opened, moved on by the clock since, so it keeps
	// moving while nothing else re-renders the page.
	const now = Math.max(renderedAt, opened.current.page + (ticked - opened.current.clock))
	if (!update && !engines)
		return <p className="settings-empty">Updates are managed outside this window in this build.</p>
	const checkedAt = Math.max(update?.info?.lastCheckedAt ?? 0, engines?.state.checkedAt ?? 0)
	const view = update
		? updateStatusView(update.state, (update.info?.lastCheckedAt ?? 0) > 0)
		: undefined
	const checking = engines?.state.checking === true
	const canCheck = (view?.canCheck ?? false) || (engines !== undefined && !checking)
	const check = () => {
		if (view?.canCheck) update?.onCheck()
		engines?.check()
	}
	return (
		<>
			<Row
				id="version"
				label="Namzu Desktop version"
				// A copy that cannot update itself made no check of its own, so it claims none.
				description={
					hasAppUpdater
						? `Last checked: ${lastCheckedText(checkedAt || undefined, now)}`
						: undefined
				}
			>
				<span className="settings-value">{update?.info?.currentVersion ?? '…'}</span>
			</Row>
			<div className="settings-update-status" aria-live="polite">
				{view && <p>{view.text}</p>}
				<div className="settings-actions">
					{view?.action === 'download' && update?.onDownload && (
						<Button size="sm" onClick={update.onDownload}>
							<DownloadIcon aria-hidden="true" />
							Download update
						</Button>
					)}
					{view?.action === 'restart' && update && (
						<Button size="sm" onClick={update.onOpen}>
							Restart to update…
						</Button>
					)}
					<Button size="sm" variant="outline" disabled={!canCheck} onClick={check}>
						{checking ? 'Checking…' : 'Check for updates'}
					</Button>
				</div>
			</div>
			<EngineUpdateRows target={engineTarget} />
			<EngineDeliveryRows settings={settings} now={now} />
			{hasAppUpdater && (
				<CatalogueRow id="auto-download">
					<Switch
						label="Download updates automatically"
						checked={settings.settings?.autoDownloadUpdates ?? true}
						disabled={!settings.settings}
						onChange={(value) => void settings.change({ autoDownloadUpdates: value })}
					/>
				</CatalogueRow>
			)}
		</>
	)
}

/**
 * The engine the app keeps current by itself: what the check found, the setting that turns it off
 * and the way back to this app's own engine. Draws nothing in a build that has no signing key.
 */
function EngineDeliveryRows({ settings, now }: { settings: DesktopSettingsControls; now: number }) {
	const delivery = useEngineDelivery()
	const [chose, setChose] = useState(false)
	const [failed, setFailed] = useState(false)
	if (!delivery) return null
	const { view } = delivery
	const status = engineStatusText(view.status, (at) => lastCheckedText(at, now), now)
	const enabled = settings.settings?.keepEngineUpToDate ?? true
	return (
		<>
			<Row
				id="engine-delivery"
				label="Namzu engine"
				description={`${
					view.runs.commandLine ? `Running ${plainVersion(view.runs.commandLine)}. ` : ''
				}${engineSourceText(view.runs, now)}`}
			>
				{view.canUseOwn && !chose && (
					<Button
						size="sm"
						variant="outline"
						onClick={() => {
							setFailed(false)
							delivery.chooseOwn().then(
								() => setChose(true),
								() => setFailed(true),
							)
						}}
					>
						Use this app’s own engine
					</Button>
				)}
			</Row>
			<div className="settings-update-status" aria-live="polite">
				<p>{chose ? 'Done. The next project you open starts this app’s own engine.' : status}</p>
				{failed && (
					<p role="alert" className="settings-error">
						Could not change that. Try again.
					</p>
				)}
			</div>
			<CatalogueRow id="keep-engine">
				<Switch
					label="Keep the engine up to date"
					checked={enabled}
					disabled={!settings.settings}
					onChange={(value) => void settings.change({ keepEngineUpToDate: value })}
				/>
			</CatalogueRow>
		</>
	)
}

function SpeechSection({ speech, listening, settings }: SettingsPageProps) {
	return (
		<div className="settings-speech">
			<div id="setting-voice">
				<LocalSpeechSettingsContent speech={speech} embedded />
			</div>
			<LocalListeningSettingsContent
				listening={listening}
				accepted={settings.settings?.voiceInputAccepted}
				onAcceptedChange={(value) => void settings.change({ voiceInputAccepted: value })}
				embedded
			/>
		</div>
	)
}

/** Copies the versions for a support request; says so only once the copy really happened. */
/** A folder as a person reads it: home as `~`, a long middle cut, the whole path on hover. */
function SettingsPath({ path }: { path: string }) {
	return (
		<span className="settings-project-path" title={path}>
			{middleEllipsis(tildePath(path), 56)}
		</span>
	)
}

function CopyPath({ path, label }: { path: string; label: string }) {
	const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
	return (
		<Button
			variant="ghost-muted"
			size="sm"
			aria-label={`Copy the path of ${label}`}
			onClick={() =>
				void copyPlainText(path).then(
					() => setState('copied'),
					() => setState('failed'),
				)
			}
		>
			{state === 'copied' ? 'Copied' : state === 'failed' ? 'Could not copy' : 'Copy path'}
		</Button>
	)
}

function CopyDetails({ text }: { text: string }) {
	const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
	return (
		<Button
			variant="outline"
			size="sm"
			aria-label="Copy version details"
			onClick={() =>
				void copyPlainText(text).then(
					() => setState('copied'),
					() => setState('failed'),
				)
			}
		>
			{state === 'copied' ? 'Copied' : state === 'failed' ? 'Could not copy' : 'Copy details'}
		</Button>
	)
}

function AboutSection({ info, infoError, onOpenFolder, now }: SettingsPageProps) {
	// What the registry knows to be newer than what is bundled: live, since a check may finish after About opens.
	const newer = useEngineUpdates()?.state.kernel ?? {}
	// Which engine runs and where it came from; absent in a build that cannot fetch engines.
	const delivery = useEngineDelivery()?.view
	if (!info)
		return infoError ? (
			<p role="alert" className="settings-error">
				{infoError}
			</p>
		) : (
			<p className="settings-empty">Loading…</p>
		)
	const fetched = delivery?.runs.source === 'managed' ? delivery.runs : undefined
	// Where the app can fetch engines it reads what runs from the engine delivery, not from the installer.
	const cliShown = delivery ? (delivery.runs.commandLine ?? info.cliVersion) : info.cliVersion
	const engineShown = delivery ? (delivery.runs.engine ?? info.sdkVersion) : info.sdkVersion
	const clock = now
	return (
		<>
			<div id="setting-about" className="settings-row" data-stacked>
				<dl className="settings-facts">
					<div>
						<dt>Namzu Desktop</dt>
						<dd>{info.version}</dd>
					</div>
					<div>
						<dt>
							{delivery && delivery.runs.source !== 'bundled'
								? 'Namzu command line'
								: 'Namzu command line (bundled with this app)'}
						</dt>
						<dd>{cliShown ?? 'Not found'}</dd>
						{newer.cli && <dd className="settings-fact-note">{newerKernelText(newer.cli)}</dd>}
					</div>
					{fetched && delivery && (
						<div>
							<dt>Namzu command line (bundled with this app)</dt>
							<dd>{delivery.bundled.commandLine ?? 'Not found'}</dd>
							<dd className="settings-fact-note">Used if the newer engine cannot start.</dd>
						</div>
					)}
					{info.installedCliVersion && (
						<div>
							<dt>Namzu command line (installed separately)</dt>
							<dd>{info.installedCliVersion}</dd>
						</div>
					)}
					<div>
						<dt>Namzu engine</dt>
						<dd>{engineShown ?? 'Not found'}</dd>
						{newer.engine && (
							<dd className="settings-fact-note">{newerKernelText(newer.engine)}</dd>
						)}
						{delivery && (
							<dd className="settings-fact-note">{engineSourceText(delivery.runs, clock)}</dd>
						)}
					</div>
					<div>
						<dt>System</dt>
						<dd>{platformText(info.platform)}</dd>
					</div>
				</dl>
				<div className="settings-actions">
					<CopyDetails
						text={aboutDetailsText(
							info,
							newer,
							delivery ? { view: delivery, now: clock } : undefined,
						)}
					/>
				</div>
			</div>
			<div id="setting-folders" className="settings-folders">
				<h3 className="settings-subtitle">Data folders</h3>
				<p className="settings-help">
					Logs and the downloaded voice are safe to delete. The Namzu home folder holds your work,
					so keep it.
				</p>
				<ul>
					{info.folders.map((folder) => (
						<li key={folder.kind}>
							<div className="settings-project-copy">
								<span className="settings-project-name">{folder.label}</span>
								<SettingsPath path={folder.path} />
								<span
									className="settings-folder-note"
									data-safe={DATA_FOLDER_NOTES[folder.kind].safe}
								>
									{DATA_FOLDER_NOTES[folder.kind].text}
								</span>
							</div>
							<CopyPath path={folder.path} label={folder.label} />
							{onOpenFolder && (
								<Button
									variant="outline"
									size="sm"
									aria-label={`Open ${folder.label}`}
									onClick={() => onOpenFolder(folder.kind)}
								>
									Open
								</Button>
							)}
						</li>
					))}
				</ul>
			</div>
		</>
	)
}
