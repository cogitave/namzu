import { KeyRound, Volume2 } from 'lucide-react'
import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import type { ProjectView } from '../shared/protocol.js'
import {
	type DataFolderKind,
	type DesktopInfo,
	type DesktopSettings,
	SETTINGS_SECTIONS,
	type SettingsSection,
	type StartupBehavior,
} from '../shared/settings-protocol.js'
import type { UpdateInfo, UpdateState } from '../shared/update-protocol.js'
import { copyPlainText } from './copy-button.js'
import { EngineUpdateRows, type EngineUpdateTarget } from './engine-updates-section.js'
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
import { LocalSpeechSettingsContent } from './local-speech-settings.js'
import { ModelsSection } from './models-section.js'
import { SettingsConfirmDialog } from './settings-confirm-dialog.js'
import {
	DATA_FOLDER_NOTES,
	SETTINGS_ENTRIES,
	SETTINGS_SEARCH_SUBTITLE,
	SETTINGS_SECTION_SUBTITLES,
	SETTINGS_SECTION_TITLES,
	aboutDetailsText,
	lastCheckedText,
	platformText,
	projectTrustText,
	searchSettings,
	updateStatusView,
} from './settings-model.js'
import type { Appearance } from './sidebar.js'
import { Button } from './ui/button.js'
import type { DesktopSettingsControls } from './use-desktop-settings.js'
import { useEngineUpdates } from './use-engine-updates.js'
import type { LocalSpeechControls } from './use-local-speech.js'
import { useProviderConnections } from './use-provider-connections.js'
import './settings-page.css'

const SECTION_ICONS: Record<SettingsSection, IconComponent> = {
	general: SettingsIcon,
	models: KeyRound as IconComponent,
	projects: FoldersIcon,
	appearance: SunIcon,
	updates: DownloadIcon,
	speech: Volume2 as IconComponent,
	about: InfoIcon,
}

/** The left column: the sections, as a list of buttons in the Plugins page's style. */
export function SettingsSidebar({
	section,
	onSection,
}: {
	section: SettingsSection
	onSection: (section: SettingsSection) => void
}) {
	return (
		<div className="plugins-sidebar-content settings-sidebar-content">
			<header className="plugins-sidebar-header">
				<span>Settings</span>
			</header>
			<nav className="settings-sidebar-navigation" aria-label="Settings sections">
				{SETTINGS_SECTIONS.map((id) => {
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
			</nav>
		</div>
	)
}

export interface SettingsPageProps {
	section: SettingsSection
	onSection: (section: SettingsSection, focusId?: string) => void
	/** A setting the page should scroll to and focus after it renders, from a search result. */
	focusId?: string
	settings: DesktopSettingsControls
	appearance: Appearance
	onAppearanceChange: (value: Appearance) => void
	/** Ordinary projects only: no Pal workspace, no chat. */
	projects: ProjectView[]
	onRemoveProject?: (project: ProjectView, trigger: HTMLElement | null) => void
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

export function SettingsPage(props: SettingsPageProps) {
	const { section, focusId } = props
	const [query, setQuery] = useState('')
	const searchId = useId()
	const shells = useTerminalShells()
	// A row that does nothing here is neither shown nor found by search.
	const hasShellChoice = (shells?.length ?? 0) > 1
	const hasAppUpdater = props.update !== undefined && props.update.state.status !== 'disabled'
	const results = searchSettings(
		query,
		SETTINGS_ENTRIES.filter(
			(entry) =>
				(entry.id !== 'terminal-shell' || hasShellChoice) &&
				(entry.id !== 'terminal-restore' || shells !== null) &&
				(entry.id !== 'auto-download' || hasAppUpdater),
		),
	)
	const searching = query.trim().length > 0
	const page = useRef<HTMLElement>(null)
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new target or section is the trigger.
	useEffect(() => {
		if (!focusId || searching) return
		const row = document.getElementById(`setting-${focusId}`)
		if (!row) return
		row.scrollIntoView?.({ block: 'center' })
		row.querySelector<HTMLElement>('input, button, summary, [tabindex]')?.focus({
			preventScroll: true,
		})
	}, [focusId, section, searching])
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
					<div className="settings-page-search">
						<SearchIcon aria-hidden="true" />
						<input
							id={searchId}
							type="search"
							aria-label="Search settings"
							placeholder="Search settings"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === 'Escape' && query) {
									event.stopPropagation()
									setQuery('')
								}
							}}
						/>
						{query && (
							<Button
								variant="ghost-muted"
								size="icon-xs"
								aria-label="Clear settings search"
								onClick={() => setQuery('')}
							>
								<XIcon aria-hidden="true" />
							</Button>
						)}
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
											setQuery('')
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
					<SectionBody {...props} shells={shells} hasAppUpdater={hasAppUpdater} />
				)}
			</div>
		</section>
	)
}

interface SectionProps extends SettingsPageProps {
	shells: ShellChoice[] | null | undefined
	hasAppUpdater: boolean
}

/** The page heading above is the section's name, so the body does not repeat it. */
function SectionBody(props: SectionProps) {
	return (
		<div className="settings-section" data-section={props.section}>
			{props.section === 'general' && <GeneralSection {...props} />}
			{props.section === 'models' && <ModelsContainer />}
			{props.section === 'projects' && <ProjectsSection {...props} />}
			{props.section === 'appearance' && <AppearanceSection {...props} />}
			{props.section === 'updates' && <UpdatesSection {...props} />}
			{props.section === 'speech' && <SpeechSection {...props} />}
			{props.section === 'about' && <AboutSection {...props} />}
		</div>
	)
}

function ModelsContainer() {
	const bridge = typeof window === 'undefined' ? undefined : window.namzu
	return <ModelsSection connections={useProviderConnections(bridge, true)} />
}

function Row({
	id,
	label,
	description,
	children,
	stacked,
}: {
	id: string
	label: string
	description?: string
	children?: ReactNode
	stacked?: boolean
}) {
	const labelId = `setting-${id}-label`
	return (
		<div id={`setting-${id}`} className="settings-row" data-stacked={stacked || undefined}>
			<div className="settings-row-copy">
				<h3 id={labelId}>{label}</h3>
				{description && <p>{description}</p>}
			</div>
			{children && <div className="settings-row-control">{children}</div>}
		</div>
	)
}

function Switch({
	label,
	checked,
	disabled,
	onChange,
}: {
	label: string
	checked: boolean
	disabled?: boolean
	onChange: (value: boolean) => void
}) {
	return (
		<input
			type="checkbox"
			role="switch"
			className="settings-switch"
			aria-label={label}
			aria-checked={checked}
			checked={checked}
			disabled={disabled}
			onChange={(event) => onChange(event.target.checked)}
		/>
	)
}

const STARTUP_CHOICES: { value: StartupBehavior; label: string; hint: string }[] = [
	{
		value: 'continue',
		label: 'Continue where I left off',
		hint: 'Your windows, tabs and drafts come back.',
	},
	{ value: 'home', label: 'Start on the home screen', hint: 'Your tabs are kept but not opened.' },
]

function GeneralSection({ settings, shells }: SectionProps) {
	const group = useId()
	const value = settings.settings?.startup
	return (
		<>
			<Row id="startup" label="When Namzu starts" stacked>
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
			</Row>
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
				<Row
					id="terminal-shell"
					label="Default terminal shell"
					description="Automatic uses PowerShell 7 when it is installed and otherwise Command Prompt, which is set to UTF-8. Windows PowerShell can drop some typed Turkish capitals."
					stacked
				>
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
				</Row>
			)}
			<Row
				id="terminal-restore"
				label="Bring terminal tabs back"
				description="After a restart, terminal tabs return as ended sessions with their last screen. Their programs do not keep running while Namzu is closed."
			>
				<Switch
					label="Bring terminal tabs back"
					checked={settings.settings?.restoreTerminals ?? true}
					disabled={!settings.settings}
					onChange={(value) => void settings.change({ restoreTerminals: value })}
				/>
			</Row>
		</>
	)
}

function ProjectsSection({ projects, onRemoveProject, settings }: SettingsPageProps) {
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
			<Row
				id="retrust"
				label="Ask again when a project’s automatic settings change"
				description="Before a trusted project loads hooks, servers or plugins that changed since you trusted it, Namzu asks again."
			>
				<div ref={switchRow}>
					<Switch
						label="Ask again when a project’s automatic settings change"
						checked={settings.settings?.retrustOnConfigChange ?? true}
						disabled={!settings.settings}
						onChange={(value) => void settings.change({ retrustOnConfigChange: value })}
					/>
				</div>
			</Row>
			<div id="setting-projects" className="settings-projects">
				<h3 className="settings-subtitle">Your projects</h3>
				<p className="settings-help">
					Removing a project only takes it out of Namzu. Your files and existing conversations stay
					where they are.
				</p>
				{projects.length === 0 ? (
					<p className="settings-empty">No projects yet. Open a folder to add one.</p>
				) : (
					<ul className="settings-project-list" aria-label="Projects">
						{projects.map((project) => (
							<li key={project.id} className="settings-project">
								<div className="settings-project-copy">
									<span className="settings-project-name">{project.name}</span>
									<span className="settings-project-path" title={project.path}>
										{project.path}
									</span>
								</div>
								<span
									className="settings-badge"
									data-tone={project.status === 'ready' && project.trusted ? 'good' : 'quiet'}
								>
									{projectTrustText(project)}
								</span>
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

function AppearanceSection({ appearance, onAppearanceChange }: SettingsPageProps) {
	const group = useId()
	return (
		<Row
			id="theme"
			label="Theme"
			description="System follows your device’s light or dark setting."
			stacked
		>
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
		</Row>
	)
}

function UpdatesSection({ update, settings, now, engineTarget, hasAppUpdater }: SectionProps) {
	const engines = useEngineUpdates()
	if (!update && !engines)
		return <p className="settings-empty">Updates are managed outside this window in this build.</p>
	const view = update ? updateStatusView(update.state) : undefined
	const checking = engines?.state.checking === true
	const canCheck = (view?.canCheck ?? false) || (engines !== undefined && !checking)
	const checkedAt = Math.max(update?.info?.lastCheckedAt ?? 0, engines?.state.checkedAt ?? 0)
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
			{hasAppUpdater && (
				<Row
					id="auto-download"
					label="Download updates automatically"
					description="When off, a new version is only offered with a badge, and nothing is downloaded until you ask."
				>
					<Switch
						label="Download updates automatically"
						checked={settings.settings?.autoDownloadUpdates ?? true}
						disabled={!settings.settings}
						onChange={(value) => void settings.change({ autoDownloadUpdates: value })}
					/>
				</Row>
			)}
		</>
	)
}

function SpeechSection({ speech }: SettingsPageProps) {
	return (
		<div id="setting-voice" className="settings-speech">
			<LocalSpeechSettingsContent speech={speech} embedded />
		</div>
	)
}

/** Copies the versions for a support request; says so only once the copy really happened. */
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

function AboutSection({ info, infoError, onOpenFolder }: SettingsPageProps) {
	if (!info)
		return infoError ? (
			<p role="alert" className="settings-error">
				{infoError}
			</p>
		) : (
			<p className="settings-empty">Loading…</p>
		)
	return (
		<>
			<div id="setting-about" className="settings-row" data-stacked>
				<dl className="settings-facts">
					<div>
						<dt>Namzu Desktop</dt>
						<dd>{info.version}</dd>
					</div>
					<div>
						<dt>Namzu command line (bundled with this app)</dt>
						<dd>{info.cliVersion ?? 'Not found'}</dd>
					</div>
					{info.installedCliVersion && (
						<div>
							<dt>Namzu command line (installed separately)</dt>
							<dd>{info.installedCliVersion}</dd>
						</div>
					)}
					<div>
						<dt>Namzu engine (SDK)</dt>
						<dd>{info.sdkVersion ?? 'Not found'}</dd>
					</div>
					<div>
						<dt>System</dt>
						<dd>{platformText(info.platform)}</dd>
					</div>
				</dl>
				<div className="settings-actions">
					<CopyDetails text={aboutDetailsText(info)} />
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
								<span className="settings-project-path" title={folder.path}>
									{folder.path}
								</span>
								<span
									className="settings-folder-note"
									data-safe={DATA_FOLDER_NOTES[folder.kind].safe}
								>
									{DATA_FOLDER_NOTES[folder.kind].text}
								</span>
							</div>
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
