import type { ProjectView } from '../shared/protocol.js'
import { type SettingsSection, isSettingsSection } from '../shared/settings-protocol.js'
import type { UpdateState } from '../shared/update-protocol.js'

export const SETTINGS_SECTION_TITLES: Record<SettingsSection, string> = {
	general: 'General',
	projects: 'Projects',
	appearance: 'Appearance',
	updates: 'Updates',
	speech: 'Speech',
	about: 'About',
}

/** `settings/<section>`; a bare `settings` means the first section. */
export function settingsRoute(section: SettingsSection): string {
	return `settings/${section}`
}

export function parseSettingsRoute(route: string): SettingsSection | undefined {
	const [head, section, ...rest] = route.split('/')
	if (head !== 'settings' || rest.length > 0) return undefined
	if (section === undefined || section === '') return 'general'
	return isSettingsSection(section) ? section : undefined
}

/** One searchable setting. `id` is the element id suffix the page scrolls to. */
export interface SettingsEntry {
	id: string
	section: SettingsSection
	label: string
	description: string
	keywords?: readonly string[]
}

export const SETTINGS_ENTRIES: readonly SettingsEntry[] = [
	{
		id: 'startup',
		section: 'general',
		label: 'When Namzu starts',
		description: 'Continue where you left off, or start on the home screen.',
		keywords: ['startup', 'launch', 'open', 'restore', 'tabs', 'home', 'restart'],
	},
	{
		id: 'terminal-shell',
		section: 'general',
		label: 'Default terminal shell',
		description:
			'The shell a new terminal tab opens: PowerShell, Command Prompt or WSL on Windows.',
		keywords: ['terminal', 'shell', 'powershell', 'cmd', 'command prompt', 'wsl', 'console'],
	},
	{
		id: 'terminal-restore',
		section: 'general',
		label: 'Bring terminal tabs back',
		description:
			'After a restart, terminal tabs return as ended sessions showing their last screen.',
		keywords: ['terminal', 'restore', 'restart', 'tabs', 'session'],
	},
	{
		id: 'projects',
		section: 'projects',
		label: 'Projects',
		description: 'The folders Namzu knows. Remove one from Namzu without deleting any files.',
		keywords: ['remove', 'folder', 'trusted', 'forget'],
	},
	{
		id: 'retrust',
		section: 'projects',
		label: 'Ask again when a project’s automatic settings change',
		description:
			'Ask before a trusted project loads automatic settings that changed since you trusted it.',
		keywords: ['trust', 'hooks', 'mcp', 'config', 'security'],
	},
	{
		id: 'theme',
		section: 'appearance',
		label: 'Theme',
		description: 'Light, dark, or follow your system.',
		keywords: ['dark', 'light', 'system', 'color', 'colour', 'mode'],
	},
	{
		id: 'version',
		section: 'updates',
		label: 'Check for updates',
		description: 'The version you have, when Namzu last checked, and a button to check now.',
		keywords: ['version', 'upgrade', 'download', 'restart', 'latest'],
	},
	{
		id: 'auto-download',
		section: 'updates',
		label: 'Download updates automatically',
		description: 'When off, a new version is only offered and you choose when to download it.',
		keywords: ['update', 'background', 'badge'],
	},
	{
		id: 'voice',
		section: 'speech',
		label: 'Voice',
		description: 'Turkish speech that runs on this device: download, remove and options.',
		keywords: ['speech', 'tts', 'read aloud', 'install', 'remove', 'turkish', 'language'],
	},
	{
		id: 'about',
		section: 'about',
		label: 'About Namzu',
		description: 'Versions of the app, the command line and the SDK.',
		keywords: ['version', 'cli', 'sdk', 'build'],
	},
	{
		id: 'folders',
		section: 'about',
		label: 'Data folders',
		description: 'Where Namzu keeps its files, and a way to open them.',
		keywords: ['explorer', 'finder', 'logs', 'diagnostics', 'storage', 'open'],
	},
]

function words(value: string): string[] {
	return value
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter(Boolean)
}

/**
 * Entries whose label, description, keywords or section name contain every word typed (as a
 * word prefix). A label match ranks above a description match; the registry order breaks ties.
 */
export function searchSettings(
	query: string,
	entries: readonly SettingsEntry[] = SETTINGS_ENTRIES,
): SettingsEntry[] {
	const wanted = words(query)
	if (!wanted.length) return []
	const scored: { entry: SettingsEntry; score: number; index: number }[] = []
	entries.forEach((entry, index) => {
		const label = words(entry.label)
		const rest = [
			...words(entry.description),
			...(entry.keywords ?? []).flatMap(words),
			...words(SETTINGS_SECTION_TITLES[entry.section]),
		]
		let score = 0
		for (const word of wanted) {
			if (label.some((item) => item.startsWith(word))) score += 2
			else if (rest.some((item) => item.startsWith(word))) score += 1
			else return
		}
		scored.push({ entry, score, index })
	})
	return scored.sort((a, b) => b.score - a.score || a.index - b.index).map((item) => item.entry)
}

/** A person-readable time since `at`, from an injected clock. */
export function lastCheckedText(at: number | undefined, now: number): string {
	if (at === undefined) return 'Not checked yet'
	const seconds = Math.max(0, Math.round((now - at) / 1000))
	if (seconds < 60) return 'Just now'
	const minutes = Math.round(seconds / 60)
	if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`
	const hours = Math.round(minutes / 60)
	if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`
	const days = Math.round(hours / 24)
	return `${days} ${days === 1 ? 'day' : 'days'} ago`
}

export interface UpdateStatusView {
	text: string
	/** The one button the state calls for, if any. */
	action?: 'check' | 'download' | 'restart'
	/** A check cannot start while one is running or an update is in flight. */
	canCheck: boolean
}

export function updateStatusView(state: UpdateState): UpdateStatusView {
	switch (state.status) {
		case 'disabled':
			return {
				text: 'This copy can’t update itself. Install the latest version once to turn updates on.',
				canCheck: false,
			}
		case 'idle':
			return { text: 'Up to date.', action: 'check', canCheck: true }
		case 'checking':
			return { text: 'Checking for updates…', canCheck: false }
		case 'available':
			return {
				text: `Update available: version ${state.version}.`,
				action: 'download',
				canCheck: false,
			}
		case 'downloading':
			return { text: `Downloading the update (${state.percent}%).`, canCheck: false }
		case 'ready':
			return {
				text: `Version ${state.version} is ready. Restart Namzu to install it.`,
				action: 'restart',
				canCheck: false,
			}
		case 'installing':
			return { text: 'Installing the update…', canCheck: false }
		case 'error':
			return { text: 'The last update check failed.', action: 'check', canCheck: true }
	}
}

export function projectTrustText(project: ProjectView): string {
	if (project.status === 'connecting') return 'Connecting'
	if (project.status === 'error') return 'Needs reconnecting'
	return project.trusted ? 'Trusted' : 'Not trusted yet'
}

/** The confirmation the spec words exactly. */
export function projectRemovalCopy(project: Pick<ProjectView, 'name'>): {
	title: string
	description: string
	actionLabel: string
	pendingLabel: string
} {
	return {
		title: `Remove ${project.name}?`,
		description:
			'This only removes the project from Namzu. Files on your computer and existing conversations won’t be deleted.',
		actionLabel: 'Remove project',
		pendingLabel: 'Removing…',
	}
}

/** What to tell a person after a removal, honest about a folder that stays trusted. */
export function removalNotice(
	name: string,
	trust: import('../shared/protocol.js').ProjectUntrust,
): string {
	if (trust.state === 'still-trusted')
		return trust.by
			? `Removed ${name}. The folder is still trusted through ${trust.by}.`
			: `Removed ${name}. The folder is still trusted through a parent folder.`
	if (trust.state === 'not-connected')
		return `Removed ${name}. It wasn’t connected, so its trust entry was left as it was.`
	if (trust.state === 'unsupported')
		return `Removed ${name}. This Namzu runtime can’t update its trust list, so the folder stays trusted.`
	return `Removed ${name}.`
}
