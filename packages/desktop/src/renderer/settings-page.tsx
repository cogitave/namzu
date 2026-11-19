import { Dialog } from '@base-ui/react/dialog'
import {
	Activity,
	Bell,
	Bot,
	Gauge,
	KeyRound,
	Monitor,
	SquareTerminal,
	Volume2,
	Wrench,
} from 'lucide-react'
import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { CODE_FONT_SIZE_DEFAULT, type CodeThemeKey } from '../shared/code-themes.js'
import { newerKernelText } from '../shared/engine-update-protocol.js'
import { type OsState, meteredLine, trayName } from '../shared/os-state.js'
import type { DesktopApi, ProjectView } from '../shared/protocol.js'
import {
	type CatalogueEntry,
	type CatalogueOption,
	FINISHED_NOTICE_AFTER_SECONDS,
	FONT_FAMILY_PREFIX,
	RESPONSE_FONT_MATCH,
	appliesText,
	catalogueEntry,
	isSafeFontName,
	storedFamily,
} from '../shared/settings-catalogue.js'
import type {
	BannerLevel,
	BrowserCookieScope,
	DataFolderKind,
	DesktopInfo,
	DesktopSettings,
	MotionChoice,
	NoticeLevel,
	NoticeSound,
	SettingsSection,
	StartupBehavior,
	TranscriptTextSize,
	TranscriptWidth,
} from '../shared/settings-protocol.js'
import { DICTATION_CHOICES } from '../shared/shortcuts.js'
import type { UpdateInfo, UpdateState } from '../shared/update-protocol.js'
import { CodePreview } from './code-preview.js'
import { OWN_ROW_CONFIG_PATHS, configSearchEntries } from './config-settings-model.js'
import { ConfigSettingsGroup } from './config-settings-section.js'
import { ConnectedBrowsersRow } from './connected-browsers.js'
import { copyPlainText } from './copy-button.js'
import { engineSourceText, engineStatusText, plainVersion } from './engine-delivery-model.js'
import { EngineUpdateRows, type EngineUpdateTarget } from './engine-updates-section.js'
import { ExtensionsSection } from './extensions-section.js'
import { FontChoice } from './font-choice.js'
import { HooksRows } from './hooks-section.js'
import {
	DownloadIcon,
	FoldersIcon,
	type IconComponent,
	InfoIcon,
	MonitorIcon,
	MoonIcon,
	PuzzleIcon,
	SearchIcon,
	SettingsIcon,
	SunIcon,
	XIcon,
} from './icons.js'
import {
	FAMILY_PREFIX,
	INTERFACE_FONT_CHOICES,
	familyOf,
	parseInterfaceFont,
	useInterfaceFont,
} from './interface-font.js'
import { LocalListeningSettingsContent } from './local-listening-settings.js'
import { LocalSpeechSettingsContent } from './local-speech-settings.js'
import { McpServersRows } from './mcp-servers-section.js'
import { MemoryRows } from './memory-section.js'
import { ModelsSection } from './models-section.js'
import { middleEllipsis, tildePath } from './path-display.js'
import { SettingsConfirmDialog } from './settings-confirm-dialog.js'
import {
	DATA_FOLDER_NOTES,
	DESKTOP_ASKS_QUESTIONS,
	SETTINGS_ENTRIES,
	SETTINGS_SEARCH_SUBTITLE,
	SETTINGS_SECTION_APPLY_NOTE,
	SETTINGS_SECTION_SUBTITLES,
	SETTINGS_SECTION_TITLES,
	type SettingsEntry,
	aboutDetailsText,
	entryIsDrawn,
	lastCheckedText,
	platformText,
	projectTrustText,
	searchSettings,
	updateStatusView,
	visibleNavGroups,
} from './settings-model.js'
import { Row, SegmentedControl, SelectControl, Switch } from './settings-row.js'
import { ShortcutBox } from './settings-shortcut.js'
import { StoragePanel, TrustedFoldersPanel } from './settings-storage.js'
import type { Appearance } from './sidebar.js'
import { Button } from './ui/button.js'
import type { UsageLimitsControl } from './usage-limits-popover.js'
import { UsageSection } from './usage-section.js'
import { useClock } from './use-clock.js'
import { type ConfigSettingsControls, useConfigSettings } from './use-config-settings.js'
import type { DesktopSettingsControls } from './use-desktop-settings.js'
import { useEngineDelivery } from './use-engine-delivery.js'
import { useEngineUpdates } from './use-engine-updates.js'
import { useHooksView } from './use-hooks-view.js'
import type { LocalListeningControls } from './use-local-listening.js'
import type { LocalSpeechControls } from './use-local-speech.js'
import { useMcpServers } from './use-mcp-servers.js'
import { useSavedMemories, useStandingInstructions } from './use-memory-controls.js'
import { useOsState } from './use-os-state.js'
import { useProviderConnections } from './use-provider-connections.js'
import { useStorageUsage, useTrustedFolders } from './use-storage-views.js'
import { useUserMcpServers } from './use-user-mcp-servers.js'
import './settings-page.css'

const SECTION_ICONS: Record<SettingsSection, IconComponent> = {
	general: SettingsIcon,
	models: KeyRound as IconComponent,
	usage: Gauge as IconComponent,
	agent: Bot as IconComponent,
	tools: Wrench as IconComponent,
	extensions: PuzzleIcon,
	projects: FoldersIcon,
	appearance: SunIcon,
	notifications: Bell as IconComponent,
	terminal: SquareTerminal as IconComponent,
	desktop: Monitor as IconComponent,
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
	/** Closes Settings and shows the Plugins page; absent where there is no such page. */
	onOpenPlugins?: () => void
	/** The usage limits the Usage section lists; absent where the window has none to show. */
	usage?: UsageLimitsControl
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
	os: OsState | null | undefined
}

function useSettingsSearch(
	query: string,
	update: SettingsPageProps['update'],
	projectId?: string,
): SettingsSearch {
	const shells = useTerminalShells()
	const os = useOsState(typeof window === 'undefined' ? undefined : window.namzu)
	const config = useConfigSettings(
		typeof window === 'undefined' ? undefined : window.namzu,
		true,
		projectId,
	)
	const delivery = useEngineDelivery()
	// A row that does nothing here is neither shown nor found by search.
	const hasAppUpdater = update !== undefined && update.state.status !== 'disabled'
	const facts = {
		shells,
		hasAppUpdater,
		canFetchEngines: delivery !== undefined,
		os,
	}
	const results = searchSettings(
		query,
		[...SETTINGS_ENTRIES, ...configSearchEntries(config.view)].filter((entry) =>
			entryIsDrawn(entry.id, facts),
		),
	)
	return { query, results, shells, config, hasAppUpdater, os }
}

/** The page's content on its own: the search is typed elsewhere and passed in as `query`. */
export function SettingsPage(props: SettingsPageProps & { query?: string }) {
	const search = useSettingsSearch(props.query ?? '', props.update, props.engineTarget?.projectId)
	return <SettingsContent {...props} search={search} />
}

function SettingsContent(
	props: SettingsPageProps & { search: SettingsSearch; onQuery?: (query: string) => void },
) {
	const { section, focusId, search } = props
	const { query, results, shells, config, hasAppUpdater, os } = search
	const searching = query.trim().length > 0
	const page = useRef<HTMLElement>(null)
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new target or section is the trigger.
	useEffect(() => {
		if (!focusId || searching) return
		const land = (): boolean => {
			const row = document.getElementById(`setting-${focusId}`)
			if (!row) return false
			// Only the content column scrolls. scrollIntoView would also move the dialog's own frame
			// when the row sits near the end and the column cannot centre it, cutting off the title.
			const column = page.current
			if (column) {
				const box = column.getBoundingClientRect()
				const at = row.getBoundingClientRect()
				column.scrollTop += at.top - box.top - Math.max(0, (box.height - at.height) / 2)
			}
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
		// A row can lose the focus to the dialog a moment after it took it (About does, as the dialog
		// settles): look again shortly, and take it back only when it fell to the dialog itself, never
		// from a control the person chose.
		const lostToDialog = (): boolean => {
			const at = document.activeElement
			return !at || at === document.body || at.classList.contains('settings-dialog')
		}
		const timers: number[] = []
		const settle = () => {
			for (const delay of [60, 200, 600])
				timers.push(
					window.setTimeout(() => {
						if (lostToDialog()) land()
					}, delay),
				)
		}
		const clear = () => {
			for (const timer of timers) window.clearTimeout(timer)
		}
		if (land()) {
			settle()
			return clear
		}
		// Some rows are drawn once their facts arrive (About, the engine's list): land when it is there.
		const content = page.current
		if (!content || typeof MutationObserver === 'undefined') return
		const watch = new MutationObserver(() => {
			if (!land()) return
			watch.disconnect()
			settle()
		})
		watch.observe(content, { childList: true, subtree: true })
		return () => {
			watch.disconnect()
			clear()
		}
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
				{/* The Extensions section draws its own header: it carries Add from file, and an extension's
				    screen names the extension. */}
				{(searching || section !== 'extensions') && (
					<header className="settings-page-header">
						<div>
							<h1>{searching ? 'Search results' : SETTINGS_SECTION_TITLES[section]}</h1>
							<p>{searching ? SETTINGS_SEARCH_SUBTITLE : SETTINGS_SECTION_SUBTITLES[section]}</p>
						</div>
					</header>
				)}
				{!searching && SETTINGS_SECTION_APPLY_NOTE[section] && (
					<p className="settings-note settings-section-note">
						{SETTINGS_SECTION_APPLY_NOTE[section]}
					</p>
				)}
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
					<SectionBody
						{...props}
						shells={shells}
						hasAppUpdater={hasAppUpdater}
						config={config}
						os={os}
					/>
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
	const search = useSettingsSearch(query, props.update, props.engineTarget?.projectId)
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

/**
 * The sections that draw the engine's own rows under the app's. A section the engine files a row
 * under but that is missing here shows nothing: the row exists and no one can reach it.
 */
export const ENGINE_ROW_SECTIONS: readonly SettingsSection[] = [
	'general',
	'models',
	'agent',
	'tools',
	'projects',
	'appearance',
	'terminal',
	'telemetry',
	'updates',
]

interface SectionProps extends SettingsPageProps {
	shells: ShellChoice[] | null | undefined
	hasAppUpdater: boolean
	config: ConfigSettingsControls
	os: OsState | null | undefined
}

/** The page heading above is the section's name, so the body does not repeat it. */
function SectionBody(props: SectionProps) {
	return (
		<div className="settings-section" data-section={props.section}>
			{props.section === 'general' && <GeneralSection {...props} />}
			{props.section === 'models' && (
				<>
					<h2 className="settings-section-title">Providers</h2>
					<ModelsContainer />
				</>
			)}
			{props.section === 'tools' && (
				<>
					<h2 className="settings-section-title">Tool servers and hooks</h2>
					<McpServersContainer {...props} />
					<HooksContainer {...props} />
				</>
			)}
			{props.section === 'usage' && <UsageSection control={props.usage} />}
			{props.section === 'extensions' && (
				<ExtensionsSection api={typeof window === 'undefined' ? undefined : window.namzu} />
			)}
			{props.section === 'projects' && <ProjectsSection {...props} />}
			{props.section === 'appearance' && <AppearanceSection {...props} />}
			{props.section === 'notifications' && <NotificationsSection {...props} />}
			{props.section === 'updates' && <UpdatesSection {...props} />}
			{props.section === 'desktop' && <DesktopSection {...props} />}
			{props.section === 'terminal' && <TerminalSettings {...props} />}
			{props.section === 'agent' && <AgentRows {...props} />}
			{props.section !== 'agent' && ENGINE_ROW_SECTIONS.includes(props.section) && (
				<ConfigSettingsGroup
					section={props.section}
					config={props.config}
					omit={props.section === 'tools' ? OWN_ROW_CONFIG_PATHS : undefined}
					after={
						props.section === 'tools'
							? {
									heading: 'Browser',
									title: 'Built-in browser',
									rows: <BuiltInBrowserRows {...props} />,
								}
							: undefined
					}
					fallbackHeading={
						props.section === 'terminal'
							? 'Terminal app'
							: props.section === 'updates'
								? 'Command line'
								: undefined
					}
					heading={
						props.section === 'general' ||
						props.section === 'models' ||
						props.section === 'projects'
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

/**
 * The browser beside a conversation: what opens in it, how long its sign-ins last, where a link in a
 * reply goes, and the table of the browsers Namzu can use. They sit in Tools after the engine's own
 * Browser rows, because they are about the same thing from the app's side; the engine's Site
 * permissions do not govern this pane, which opens any web address a person or a link gives it.
 */
function BuiltInBrowserRows({ settings }: SectionProps) {
	const saved = settings.settings
	const cookies = catalogueEntry('browser-cookies').control as {
		options: readonly CatalogueOption[]
	}
	const bridge = typeof window === 'undefined' ? undefined : window.namzu
	return (
		<>
			<CatalogueRow id="browser-auto-open">
				<Switch
					label={labelOf('browser-auto-open')}
					checked={saved?.autoOpenFiles ?? true}
					disabled={!saved}
					onChange={(value) => void settings.change({ autoOpenFiles: value })}
				/>
			</CatalogueRow>
			<CatalogueRow id="browser-cookies">
				<SelectControl
					label={labelOf('browser-cookies')}
					value={saved?.browserCookies ?? 'conversation'}
					disabled={!saved}
					onChange={(value) =>
						void settings.change({ browserCookies: value as BrowserCookieScope })
					}
				>
					{cookies.options.map((option) => (
						<option key={option.value} value={option.value}>
							{defaultMarked('browser-cookies', option.value, option.label)}
						</option>
					))}
				</SelectControl>
			</CatalogueRow>
			<CatalogueRow id="open-links-in-browser">
				<Switch
					label={labelOf('open-links-in-browser')}
					checked={saved?.openLinksInBrowser ?? true}
					disabled={!saved}
					onChange={(value) => void settings.change({ openLinksInBrowser: value })}
				/>
			</CatalogueRow>
			<ConnectedBrowsersRow bridge={bridge} />
		</>
	)
}

function McpServersContainer({ engineTarget, projects }: SectionProps) {
	const bridge = typeof window === 'undefined' ? undefined : window.namzu
	const projectId = engineTarget?.projectId
	const servers = useMcpServers(bridge, projectId)
	const own = useUserMcpServers(bridge, servers.reload)
	return (
		<McpServersRows
			servers={servers}
			own={own}
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

/** Agent: the engine's rows, with the app's own sleep rows and the memory rows drawn under their headings. */
function AgentRows(props: SectionProps) {
	const { engineTarget, projects, config } = props
	const bridge = typeof window === 'undefined' ? undefined : window.namzu
	const projectId = engineTarget?.projectId
	const [open, setOpen] = useState(false)
	const instructions = useStandingInstructions(bridge)
	const memory = useSavedMemories(bridge, projectId, open)
	// The Memory heading is drawn only when there is a row to put under it.
	const memoryRows = instructions.supported || memory.supported
	return (
		<ConfigSettingsGroup
			section="agent"
			config={config}
			lead={[
				{ heading: 'While Namzu works', rows: <AgentSleepRows {...props} /> },
				...(memoryRows
					? [
							{
								heading: 'Memory',
								rows: (
									<MemoryRows
										instructions={instructions}
										memory={{ ...memory, open, setOpen }}
										hasProject={projectId !== undefined}
										projectName={projects.find((project) => project.id === projectId)?.name}
									/>
								),
							},
						]
					: []),
			]}
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

/** Whether a change to this row waits for a restart, which the row's badge says. */
function waitsForRestart(entry: CatalogueEntry): boolean {
	return entry.appliesWhen === 'next-start' || entry.appliesWhen === 'next-launch'
}

/**
 * The short line under a row's description. The default is marked inside the control and the
 * section note covers the common apply time, so only a row whose apply differs from its section
 * says so here; a row that waits for a restart carries a badge instead.
 */
function catalogueMeta(entry: CatalogueEntry): string {
	return waitsForRestart(entry) ? '' : (entry.appliesNote ?? '')
}

/** A catalogue row's name, so a control's accessible name is the row's label. */
function labelOf(id: string): string {
	return catalogueEntry(id).label
}

/** A drop-down choice's text with its default mark: the default reads "Default · X". */
export function defaultMarked(id: string, value: string, text: string): string {
	if (String(catalogueEntry(id).default) !== value) return text
	// A choice already called Default (the code colours) is not marked twice: "Default · Default".
	return /^default$/i.test(text.trim()) ? text : `Default · ${text}`
}

/** A row whose label, help, default and apply time all come from the settings catalogue. */
function CatalogueRow({
	id,
	stacked,
	below,
	children,
	label,
	child,
}: {
	id: string
	stacked?: boolean
	below?: ReactNode
	children?: ReactNode
	/** The name this system calls it, when it differs from the catalogue's. */
	label?: string
	child?: boolean
}) {
	const entry = catalogueEntry(id)
	return (
		<Row
			id={id}
			label={label ?? entry.label}
			child={child}
			description={entry.description}
			meta={catalogueMeta(entry)}
			badge={
				waitsForRestart(entry) ? { text: 'After restart', sentence: appliesText(entry) } : undefined
			}
			stacked={stacked}
			below={below}
		>
			{children}
		</Row>
	)
}

function GeneralSection({ settings }: SectionProps) {
	const group = useId()
	const value = settings.settings?.startup
	return (
		<>
			<CatalogueRow id="startup" stacked>
				<fieldset className="settings-choices" disabled={!settings.settings}>
					<legend className="sr-only">{labelOf('startup')}</legend>
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
		</>
	)
}

/** What each notification level lists, from the catalogue so the page and the validator agree. */
const NOTICE_LEVEL_OPTIONS = (id: string) =>
	(catalogueEntry(id).control as { options: readonly CatalogueOption[] }).options

/** Every row here is about this computer: the icon count, the banners and their sound. */
export function NotificationsSection({ settings }: { settings: DesktopSettingsControls }) {
	const saved = settings.settings
	const ready = saved !== undefined
	const levelRow = (
		id: string,
		value: string,
		onChange: (value: string) => void,
		child?: boolean,
		badgeNeedsAttention?: boolean,
	) => (
		<CatalogueRow id={id} child={child}>
			<SelectControl label={labelOf(id)} value={value} disabled={!ready} onChange={onChange}>
				{NOTICE_LEVEL_OPTIONS(id).map((option) => (
					<option
						key={option.value}
						value={option.value}
						// The icon count belongs to Draw attention, so Badge only does nothing while that is off.
						disabled={
							badgeNeedsAttention === true &&
							option.value === 'badge' &&
							value !== 'badge' &&
							saved?.attentionSignals === false
						}
					>
						{defaultMarked(id, option.value, option.label)}
					</option>
				))}
			</SelectControl>
		</CatalogueRow>
	)
	return (
		<>
			<h2 className="settings-section-title">On this computer</h2>
			<CatalogueRow id="attention-signals">
				<Switch
					label={labelOf('attention-signals')}
					checked={saved?.attentionSignals ?? true}
					disabled={!ready}
					onChange={(value) => void settings.change({ attentionSignals: value })}
				/>
			</CatalogueRow>
			{levelRow(
				'notify-permission',
				saved?.notifyPermission ?? 'banner',
				(value) => void settings.change({ notifyPermission: value as NoticeLevel }),
				undefined,
				true,
			)}
			{/* Questions: kept in the settings, drawn once a conversation in this app can ask one. */}
			{DESKTOP_ASKS_QUESTIONS &&
				levelRow(
					'notify-question',
					saved?.notifyQuestion ?? 'banner',
					(value) => void settings.change({ notifyQuestion: value as NoticeLevel }),
					undefined,
					true,
				)}
			{levelRow(
				'notify-task-complete',
				saved?.notifyTaskComplete ?? 'banner',
				(value) => void settings.change({ notifyTaskComplete: value as BannerLevel }),
			)}
			<CatalogueRow id="notify-long-reply" child>
				<SecondsInput
					value={saved?.notifyLongReplySeconds ?? FINISHED_NOTICE_AFTER_SECONDS}
					disabled={!ready || saved?.notifyTaskComplete === 'off'}
					onCommit={(value) => void settings.change({ notifyLongReplySeconds: value })}
				/>
			</CatalogueRow>
			{levelRow(
				'notify-error',
				saved?.notifyError ?? 'banner',
				(value) => void settings.change({ notifyError: value as BannerLevel }),
			)}
			{levelRow(
				'notify-sound',
				saved?.notificationSound ?? 'none',
				(value) => void settings.change({ notificationSound: value as NoticeSound }),
			)}
		</>
	)
}

/** The seconds a reply must take before its end notifies. An empty box is the default. */
export function SecondsInput({
	value,
	disabled,
	onCommit,
}: { value: number; disabled?: boolean; onCommit: (value: number) => void }) {
	const control = catalogueEntry('notify-long-reply').control as {
		min: number
		max: number
		unit: string
	}
	const shown = value === FINISHED_NOTICE_AFTER_SECONDS ? '' : String(value)
	const [draft, setDraft] = useState(shown)
	useEffect(() => setDraft(shown), [shown])
	const text = draft.trim()
	const parsed = text === '' ? FINISHED_NOTICE_AFTER_SECONDS : Number(text)
	const invalid =
		!Number.isInteger(parsed) || /\D/.test(text) || parsed < control.min || parsed > control.max
	const messageId = useId()
	const commit = () => {
		if (invalid) return
		if (parsed !== value) onCommit(parsed)
		setDraft(parsed === FINISHED_NOTICE_AFTER_SECONDS ? '' : String(parsed))
	}
	return (
		<div className="settings-seconds">
			<input
				type="text"
				inputMode="numeric"
				className="settings-config-input"
				aria-label={labelOf('notify-long-reply')}
				aria-invalid={invalid || undefined}
				aria-describedby={invalid ? messageId : undefined}
				placeholder={String(FINISHED_NOTICE_AFTER_SECONDS)}
				maxLength={4}
				value={draft}
				disabled={disabled}
				onChange={(event) => setDraft(event.target.value)}
				onBlur={commit}
				onKeyDown={(event) => {
					if (event.key === 'Enter') commit()
					if (escapeRevertsDraft(event.key, draft, shown)) {
						event.stopPropagation()
						setDraft(shown)
					}
				}}
			/>
			<span className="settings-note">{control.unit}</span>
			{invalid && (
				<span id={messageId} data-invalid role="alert">
					{`Enter a whole number from ${control.min} to ${control.max}. Escape goes back to the saved one.`}
				</span>
			)}
		</div>
	)
}

/**
 * The terminal tabs in this window: the shell a plain tab opens and whether tabs come back after a
 * restart. The rows that follow in the section (the terminal app, the command line) are the
 * engine's own. The shell row appears only where there is a real choice, which is Windows; with one
 * shell it would have nothing to click. Where there are no terminals the heading goes too.
 */
export function TerminalSettings({
	settings,
	shells,
	onSection,
}: {
	settings: DesktopSettingsControls
	shells: ShellChoice[] | null | undefined
	onSection?: SettingsPageProps['onSection']
}) {
	const group = useId()
	if (shells === null) return null
	const current = settings.settings?.terminalShell
	const choices = shells ?? []
	return (
		<>
			<h2 className="settings-section-title">Terminal tabs</h2>
			{choices.length > 1 && (
				<CatalogueRow id="terminal-shell" stacked>
					<fieldset className="settings-choices" disabled={!settings.settings}>
						<legend className="sr-only">{labelOf('terminal-shell')}</legend>
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
									<span className="settings-choice-label">
										{defaultMarked('terminal-shell', choice.value, choice.label)}
									</span>
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
					label={labelOf('terminal-restore')}
					checked={settings.settings?.restoreTerminals ?? true}
					disabled={!settings.settings}
					onChange={(value) => void settings.change({ restoreTerminals: value })}
				/>
			</CatalogueRow>
			{onSection && (
				<CatalogueRow id="terminal-code-link">
					<button
						type="button"
						className="settings-row-button"
						onClick={() => onSection('appearance', 'code-theme-light')}
					>
						Open Appearance
					</button>
				</CatalogueRow>
			)}
		</>
	)
}

/** Escape puts the saved name back while the box holds something else; otherwise it is left to close Settings. */
export function escapeRevertsDraft(key: string, draft: string, saved: string): boolean {
	return key === 'Escape' && draft !== saved
}

/**
 * A font name typed into a box. The value is saved when the box loses the focus or Enter is
 * pressed, and only if it is empty or a name a font-family can carry; otherwise the box says why.
 */
const codeFontPlaceholder = (catalogueEntry('code-font').control as { placeholder?: string })
	.placeholder

export function CodeFontInput({
	value,
	disabled,
	onCommit,
}: { value: string; disabled?: boolean; onCommit: (value: string) => void }) {
	const [draft, setDraft] = useState(value)
	useEffect(() => setDraft(value), [value])
	const text = draft.trim()
	const invalid = text !== '' && !isSafeFontName(text)
	const messageId = useId()
	const commit = () => {
		if (invalid) return
		if (text !== value) onCommit(text)
		setDraft(text)
	}
	return (
		<div className="settings-code-font">
			<input
				type="text"
				className="settings-config-input"
				aria-label={labelOf('code-font')}
				aria-invalid={invalid || undefined}
				aria-describedby={invalid ? messageId : undefined}
				placeholder={codeFontPlaceholder}
				maxLength={80}
				spellCheck={false}
				value={draft}
				disabled={disabled}
				onChange={(event) => setDraft(event.target.value)}
				onBlur={commit}
				onKeyDown={(event) => {
					if (event.key === 'Enter') commit()
					// Escape first puts the saved name back; with nothing to put back it closes Settings as usual.
					if (escapeRevertsDraft(event.key, draft, value)) {
						event.stopPropagation()
						setDraft(value)
					}
				}}
			/>
			{invalid && (
				<span id={messageId} data-invalid role="alert">
					{draft.includes(',')
						? 'Enter one font name, without commas. Escape goes back to the saved one.'
						: 'Use letters, numbers, spaces and . _ ( ) + & - only. Escape goes back to the saved one.'}
				</span>
			)}
		</div>
	)
}

/** A quiet line under a row: what the system did or said about it. */
function RowLine({ children }: { children: ReactNode }) {
	return (
		<p className="settings-note" aria-live="polite">
			{children}
		</p>
	)
}

/** How the app itself runs on this computer, as against what happens inside a conversation. */
export function DesktopSection({
	settings,
	os,
	onOpenPlugins,
}: Pick<SectionProps, 'settings' | 'os' | 'onOpenPlugins'>) {
	const saved = settings.settings
	const off = !saved
	return (
		<>
			<CatalogueRow id="hardware-acceleration">
				<Switch
					label={labelOf('hardware-acceleration')}
					checked={saved?.hardwareAcceleration ?? true}
					disabled={off}
					onChange={(value) => void settings.change({ hardwareAcceleration: value })}
				/>
			</CatalogueRow>
			{os?.loginItem && (
				<CatalogueRow
					id="run-on-startup"
					below={os.loginItem.problem ? <RowLine>{os.loginItem.problem}</RowLine> : undefined}
				>
					<Switch
						label={labelOf('run-on-startup')}
						checked={os.loginItem.enabled}
						disabled={off}
						onChange={(value) => void settings.change({ runOnStartup: value })}
					/>
				</CatalogueRow>
			)}
			<CatalogueRow
				id="quick-entry-shortcut"
				below={
					saved?.quickEntryShortcut && os?.shortcuts?.quickEntry.problem ? (
						<RowLine>{os.shortcuts.quickEntry.problem}</RowLine>
					) : undefined
				}
			>
				<ShortcutBox
					label={labelOf('quick-entry-shortcut')}
					value={saved?.quickEntryShortcut ?? ''}
					emptyText="Off"
					disabled={off}
					onChange={(value) => void settings.change({ quickEntryShortcut: value })}
				/>
			</CatalogueRow>
			<CatalogueRow id="dictation-shortcut">
				<SelectControl
					label={labelOf('dictation-shortcut')}
					value={saved?.dictationShortcut ?? 'ctrl-d'}
					disabled={off}
					onChange={(value) => void settings.change({ dictationShortcut: value })}
				>
					{DICTATION_CHOICES.map((choice) => (
						<option key={choice.value} value={choice.value}>
							{defaultMarked('dictation-shortcut', choice.value, choice.label)}
						</option>
					))}
				</SelectControl>
			</CatalogueRow>
			<CatalogueRow
				id="voice-shortcut"
				below={
					saved?.voiceShortcut && os?.shortcuts?.voice.problem ? (
						<RowLine>{os.shortcuts.voice.problem}</RowLine>
					) : undefined
				}
			>
				<ShortcutBox
					label={labelOf('voice-shortcut')}
					value={saved?.voiceShortcut ?? ''}
					emptyText="Off"
					disabled={off}
					onChange={(value) => void settings.change({ voiceShortcut: value })}
				/>
			</CatalogueRow>
			{os && (
				<CatalogueRow
					id="system-tray"
					label={trayName(os.platform)}
					below={
						os.tray.problem && saved?.systemTray ? <RowLine>{os.tray.problem}</RowLine> : undefined
					}
				>
					<Switch
						label={trayName(os.platform)}
						checked={saved?.systemTray ?? true}
						disabled={off}
						onChange={(value) => void settings.change({ systemTray: value })}
					/>
				</CatalogueRow>
			)}
			<CatalogueRow id="keep-awake">
				<Switch
					label={labelOf('keep-awake')}
					checked={saved?.keepAwakeAppOpen ?? false}
					disabled={off}
					onChange={(value) => void settings.change({ keepAwakeAppOpen: value })}
				/>
			</CatalogueRow>
			{os?.metered && (
				<CatalogueRow
					id="pause-on-metered"
					below={<RowLine>{meteredLine(os.metered.state)}</RowLine>}
				>
					<Switch
						label={labelOf('pause-on-metered')}
						checked={saved?.pauseOnMetered ?? true}
						disabled={off}
						onChange={(value) => void settings.change({ pauseOnMetered: value })}
					/>
				</CatalogueRow>
			)}
			<StorageRow />
			<TrustedFoldersRow />
			<CatalogueRow id="extensions-manage">
				<Button
					variant="outline"
					size="sm"
					aria-label={`Manage ${labelOf('extensions-manage').toLowerCase()}`}
					disabled={!onOpenPlugins}
					onClick={() => onOpenPlugins?.()}
				>
					Manage
				</Button>
			</CatalogueRow>
		</>
	)
}

/** A button that opens a view under its row. The view measures or reads only while it is open. */
function ManageRow({
	id,
	label,
	available,
	children,
}: {
	id: string
	label: string
	available: boolean
	children: ReactNode
}) {
	const [open, setOpen] = useState(false)
	return (
		<CatalogueRow id={id} below={open && available ? children : undefined}>
			<Button
				variant="outline"
				size="sm"
				aria-label={`${open ? 'Hide' : 'Manage'} ${label}`}
				aria-expanded={open}
				disabled={!available}
				onClick={() => setOpen((value) => !value)}
			>
				{open ? 'Hide' : 'Manage'}
			</Button>
		</CatalogueRow>
	)
}

function StorageRow() {
	const bridge = typeof window === 'undefined' ? undefined : window.namzu
	return (
		<ManageRow id="storage" label="storage" available={!!bridge?.storageUsage}>
			<StoragePanelContainer bridge={bridge} />
		</ManageRow>
	)
}

function StoragePanelContainer({ bridge }: { bridge: DesktopApi | undefined }) {
	return <StoragePanel storage={useStorageUsage(bridge, true)} />
}

function TrustedFoldersRow() {
	const bridge = typeof window === 'undefined' ? undefined : window.namzu
	return (
		<ManageRow id="trusted-folders" label="trusted folders" available={!!bridge?.trustedFolders}>
			<TrustedFoldersContainer bridge={bridge} />
		</ManageRow>
	)
}

function TrustedFoldersContainer({ bridge }: { bridge: DesktopApi | undefined }) {
	return <TrustedFoldersPanel trusted={useTrustedFolders(bridge, true)} />
}

/**
 * Staying awake while a conversation works lives with the agent, not with the app: it follows the
 * work, and the app's own "keep computer awake" (Desktop app) follows the window being open.
 */
export function AgentSleepRows({ settings }: Pick<SectionProps, 'settings'>) {
	const saved = settings.settings
	return (
		<>
			<CatalogueRow id="keep-awake-working">
				<Switch
					label={labelOf('keep-awake-working')}
					checked={saved?.keepAwakeWhileWorking ?? false}
					disabled={!saved}
					onChange={(value) => void settings.change({ keepAwakeWhileWorking: value })}
				/>
			</CatalogueRow>
			<CatalogueRow id="keep-awake-battery" child>
				<Switch
					label={labelOf('keep-awake-battery')}
					checked={saved?.keepAwakeOnBattery ?? false}
					disabled={!saved || !saved.keepAwakeWhileWorking}
					onChange={(value) => void settings.change({ keepAwakeOnBattery: value })}
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
			<h2 className="settings-section-title">Your projects</h2>
			<CatalogueRow id="retrust">
				<div ref={switchRow}>
					<Switch
						label={labelOf('retrust')}
						checked={settings.settings?.retrustOnConfigChange ?? true}
						disabled={!settings.settings}
						onChange={(value) => void settings.change({ retrustOnConfigChange: value })}
					/>
				</div>
			</CatalogueRow>
			<div id="setting-projects" className="settings-projects">
				{/* The sub-heading above already says "Your projects"; the panel keeps its name for assistive technology. */}
				<h3 className="settings-subtitle sr-only">{labelOf('projects')}</h3>
				<p className="settings-help">{catalogueEntry('projects').description}</p>
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
	{ value: 'system', label: 'System', Icon: MonitorIcon },
	{ value: 'light', label: 'Light', Icon: SunIcon },
	{ value: 'dark', label: 'Dark', Icon: MoonIcon },
] as const

/**
 * The options of a catalogue select, as a segmented control wants them. A segmented control shows
 * every choice side by side, so it carries no default mark; only a drop-down list does.
 */
function catalogueChoices<T extends string>(id: string): { value: T; label: string }[] {
	return (catalogueEntry(id).control as { options: readonly CatalogueOption[] }).options.map(
		(option) => ({ value: option.value as T, label: option.label }),
	)
}

const CODE_THEME_CHOICES = (
	catalogueEntry('code-theme-light').control as { options: readonly CatalogueOption[] }
).options
const CODE_SIZE_CHOICES = (() => {
	const control = catalogueEntry('code-font-size').control as { min: number; max: number }
	return Array.from({ length: control.max - control.min + 1 }, (_, index) => control.min + index)
})()

const TEXT_SIZE_CHOICES = catalogueChoices<TranscriptTextSize>('transcript-text-size')
const WIDTH_CHOICES = catalogueChoices<TranscriptWidth>('transcript-width')
const MOTION_CHOICES = catalogueChoices<MotionChoice>('motion')

function AppearanceSection({ appearance, onAppearanceChange, settings }: SettingsPageProps) {
	const [interfaceFont, setInterfaceFont] = useInterfaceFont()
	const saved = settings.settings
	const ready = saved !== undefined
	return (
		<>
			<CatalogueRow id="theme">
				<SegmentedControl
					label={labelOf('theme')}
					value={appearance}
					options={APPEARANCE_CHOICES}
					onChange={onAppearanceChange}
				/>
			</CatalogueRow>
			<CatalogueRow id="interface-font">
				<FontChoice
					label={labelOf('interface-font')}
					value={interfaceFont}
					named={INTERFACE_FONT_CHOICES.map((choice) => ({
						value: choice.value,
						label: defaultMarked('interface-font', choice.value, choice.label),
					}))}
					familyValue={(family) => `${FAMILY_PREFIX}${family}`}
					familyOf={(value) => familyOf(parseInterfaceFont(value))}
					onChange={(value) => setInterfaceFont(parseInterfaceFont(value))}
				/>
			</CatalogueRow>
			<CatalogueRow id="response-font">
				<FontChoice
					label={labelOf('response-font')}
					value={saved?.responseFont ?? RESPONSE_FONT_MATCH}
					named={[
						{
							value: RESPONSE_FONT_MATCH,
							label: defaultMarked('response-font', RESPONSE_FONT_MATCH, 'Match interface'),
						},
						{ value: 'app', label: 'Namzu’s own' },
						{ value: 'system', label: 'Your device’s' },
					]}
					familyValue={(family) => `${FONT_FAMILY_PREFIX}${family}`}
					familyOf={storedFamily}
					onChange={(value) => void settings.change({ responseFont: value })}
				/>
			</CatalogueRow>
			<CatalogueRow id="transcript-text-size">
				<SegmentedControl
					label={labelOf('transcript-text-size')}
					value={saved?.transcriptTextSize ?? 'medium'}
					options={TEXT_SIZE_CHOICES}
					disabled={!ready}
					onChange={(value) => void settings.change({ transcriptTextSize: value })}
				/>
			</CatalogueRow>
			<CatalogueRow id="transcript-width">
				<SegmentedControl
					label={labelOf('transcript-width')}
					value={saved?.transcriptWidth ?? 'narrow'}
					options={WIDTH_CHOICES}
					disabled={!ready}
					onChange={(value) => void settings.change({ transcriptWidth: value })}
				/>
			</CatalogueRow>
			<CatalogueRow id="motion">
				<SegmentedControl
					label={labelOf('motion')}
					value={saved?.motion ?? 'system'}
					options={MOTION_CHOICES}
					disabled={!ready}
					onChange={(value) => void settings.change({ motion: value })}
				/>
			</CatalogueRow>
			<CatalogueRow id="conversation-tabs">
				<Switch
					label={labelOf('conversation-tabs')}
					checked={saved?.showConversationTabs ?? false}
					disabled={!ready}
					onChange={(value) => void settings.change({ showConversationTabs: value })}
				/>
			</CatalogueRow>
			<h2 className="settings-section-title">Code</h2>
			<CatalogueRow
				id="code-theme-light"
				below={<CodePreview mode="light" value={saved?.lightCodeTheme ?? 'default'} />}
			>
				<SelectControl
					label={labelOf('code-theme-light')}
					value={saved?.lightCodeTheme ?? 'default'}
					disabled={!ready}
					onChange={(value) => void settings.change({ lightCodeTheme: value as CodeThemeKey })}
				>
					{CODE_THEME_CHOICES.map((option) => (
						<option key={option.value} value={option.value}>
							{defaultMarked('code-theme-light', option.value, option.label)}
						</option>
					))}
				</SelectControl>
			</CatalogueRow>
			<CatalogueRow
				id="code-theme-dark"
				below={<CodePreview mode="dark" value={saved?.darkCodeTheme ?? 'default'} />}
			>
				<SelectControl
					label={labelOf('code-theme-dark')}
					value={saved?.darkCodeTheme ?? 'default'}
					disabled={!ready}
					onChange={(value) => void settings.change({ darkCodeTheme: value as CodeThemeKey })}
				>
					{CODE_THEME_CHOICES.map((option) => (
						<option key={option.value} value={option.value}>
							{defaultMarked('code-theme-dark', option.value, option.label)}
						</option>
					))}
				</SelectControl>
			</CatalogueRow>
			<CatalogueRow id="code-font">
				<CodeFontInput
					value={saved?.codeFont ?? ''}
					disabled={!ready}
					onCommit={(value) => void settings.change({ codeFont: value })}
				/>
			</CatalogueRow>
			<CatalogueRow id="code-font-size">
				<SelectControl
					label={labelOf('code-font-size')}
					value={String(saved?.codeFontSize ?? CODE_FONT_SIZE_DEFAULT)}
					disabled={!ready}
					onChange={(value) => void settings.change({ codeFontSize: Number(value) })}
				>
					{CODE_SIZE_CHOICES.map((size) => (
						<option key={size} value={size}>
							{defaultMarked('code-font-size', String(size), `${size} px`)}
						</option>
					))}
				</SelectControl>
			</CatalogueRow>
			<h2 className="settings-section-title">Accessibility</h2>
			<CatalogueRow id="auto-dismiss-popups">
				<Switch
					label={labelOf('auto-dismiss-popups')}
					checked={saved?.autoDismissPopups ?? true}
					disabled={!ready}
					onChange={(value) => void settings.change({ autoDismissPopups: value })}
				/>
			</CatalogueRow>
			<CatalogueRow id="virtualize-conversations">
				<Switch
					label={labelOf('virtualize-conversations')}
					checked={saved?.virtualizeConversations ?? true}
					disabled={!ready}
					onChange={(value) => void settings.change({ virtualizeConversations: value })}
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
		return (
			<p className="settings-empty">
				This app's own updates are managed outside this window in this build.
			</p>
		)
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
			<h2 className="settings-section-title">Namzu Desktop</h2>
			<Row
				id="version"
				label={labelOf('version')}
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
			{hasAppUpdater && (
				<CatalogueRow id="auto-download">
					<Switch
						label={labelOf('auto-download')}
						checked={settings.settings?.autoDownloadUpdates ?? true}
						disabled={!settings.settings}
						onChange={(value) => void settings.change({ autoDownloadUpdates: value })}
					/>
				</CatalogueRow>
			)}
			<EngineUpdateRows target={engineTarget} />
			<EngineDeliveryRows settings={settings} now={now} />
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
				label={labelOf('engine-delivery')}
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
					label={labelOf('keep-engine')}
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
				<h3 className="settings-subtitle">{labelOf('folders')}</h3>
				<p className="settings-help">{catalogueEntry('folders').description}</p>
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
