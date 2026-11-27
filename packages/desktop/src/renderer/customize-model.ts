import type { InstalledSkillView } from '../shared/config-lists-protocol.js'
import type { SkillCatalogEntryView, SkillCatalogState } from '../shared/customize-protocol.js'
import type { McpServerView, McpServersView } from '../shared/protocol.js'
import { foldedIncludes } from './text-fold.js'

/**
 * What the Customize page shows, as plain data: the groups of the Skills tab, the chips on a row,
 * the words for a time, the rows of the Connectors table and the plugin rows. No React and no
 * engine call, so the rules can be tested alone.
 */

export type CustomizeTab = 'skills' | 'connectors' | 'plugins'
export const CUSTOMIZE_TABS: readonly { id: CustomizeTab; label: string }[] = [
	{ id: 'skills', label: 'Skills' },
	{ id: 'connectors', label: 'Connectors' },
	{ id: 'plugins', label: 'Plugins' },
]

export type SkillSort = 'name' | 'updated'
export const SKILL_SORTS: readonly { id: SkillSort; label: string }[] = [
	{ id: 'name', label: 'Name' },
	{ id: 'updated', label: 'Last updated' },
]

/** One skill as a row: the catalog entry, or, from an engine without a catalog, a name and a place. */
export interface SkillRowModel extends SkillCatalogEntryView {
	/** True when only the name and the place were known; there is no Contents then. */
	basic?: boolean
	/** Why the switch cannot move this skill: its state is set per project, above `skills.disabled`. */
	locked?: string
}

const LOCK_NOTE =
	'Set for this project in its local settings (/skills in the terminal changes it), so the switch here cannot move it'

/**
 * `skills.overrides` wins over `skills.disabled`, and the switch only writes the list. When the
 * state the catalog reports is not the one the list alone would give, an override holds it: the
 * row is locked rather than shown a switch that does nothing.
 */
export function withSwitchLocks(
	rows: readonly SkillRowModel[],
	disabled: unknown,
): SkillRowModel[] {
	const listed = new Set(
		Array.isArray(disabled) ? (disabled as unknown[]).filter((n) => typeof n === 'string') : [],
	)
	return rows.map((row) => {
		if (row.basic || row.plugin || row.tier === 'plugin') return row
		const held =
			row.state === 'name-only' ||
			row.state === 'user-only' ||
			(row.state === 'off') !== listed.has(row.name)
		return held ? { ...row, locked: LOCK_NOTE } : row
	})
}

/** The rows from the installed-skills list an older engine answers: names and places only. */
export function basicSkillRows(
	installed: readonly InstalledSkillView[],
	disabled: unknown,
): SkillRowModel[] {
	const off = new Set(
		Array.isArray(disabled) ? (disabled as unknown[]).filter((n) => typeof n === 'string') : [],
	)
	return installed.map((skill) => ({
		name: skill.name,
		description: '',
		tier: skill.where.startsWith('project')
			? 'project'
			: skill.where === 'built-in'
				? 'system'
				: 'user',
		place: skill.where,
		state: off.has(skill.name) ? 'off' : 'on',
		fileCount: 0,
		removable: false,
		basic: true,
	}))
}

export type SkillGroupId = 'project' | 'user' | 'plugin' | 'builtin'

export function skillGroupOf(skill: SkillCatalogEntryView): SkillGroupId {
	if (skill.plugin || skill.tier === 'plugin') return 'plugin'
	if (skill.place.startsWith('project')) return 'project'
	if (skill.place === 'built-in') return 'builtin'
	return 'user'
}

const GROUPS: readonly { id: SkillGroupId; title: string }[] = [
	{ id: 'project', title: 'This project' },
	{ id: 'user', title: 'Yours' },
	{ id: 'plugin', title: 'From plugins' },
	{ id: 'builtin', title: 'Built-in' },
]

export interface SkillGroupModel {
	id: SkillGroupId
	title: string
	rows: SkillRowModel[]
}

export function skillMatches(skill: SkillCatalogEntryView, query: string): boolean {
	const term = query.trim()
	return !term || foldedIncludes(`${skill.name} ${skill.description}`, term)
}

export function sortSkills<T extends SkillCatalogEntryView>(
	rows: readonly T[],
	sort: SkillSort,
): T[] {
	return [...rows].sort((a, b) => {
		if (sort === 'updated') {
			const at = a.updatedAt ? Date.parse(a.updatedAt) : 0
			const bt = b.updatedAt ? Date.parse(b.updatedAt) : 0
			if (at !== bt) return bt - at
		}
		return a.name.localeCompare(b.name)
	})
}

/** The groups in order, each sorted, empty ones left out. */
export function groupSkills(
	rows: readonly SkillRowModel[],
	options: { query: string; sort: SkillSort },
): SkillGroupModel[] {
	const shown = rows.filter((row) => skillMatches(row, options.query))
	return GROUPS.map((group) => ({
		...group,
		rows: sortSkills(
			shown.filter((row) => skillGroupOf(row) === group.id),
			options.sort,
		),
	})).filter((group) => group.rows.length > 0)
}

export const STATE_CHIP: Record<SkillCatalogState, string | undefined> = {
	on: undefined,
	'name-only': 'Name only',
	'user-only': 'You only',
	off: 'Off',
}

/** The small chips after a skill's name: its plugin, then its state when it is not on. */
export function skillChips(skill: SkillCatalogEntryView): string[] {
	const state = STATE_CHIP[skill.state]
	return [...(skill.plugin ? [skill.plugin] : []), ...(state ? [state] : [])]
}

/**
 * When a skill was last changed, for people: a built-in skill is a file of the program itself, so
 * its time says when Namzu was installed, which is no news about the skill.
 */
export const skillUpdatedAt = (skill: SkillCatalogEntryView): string | undefined =>
	skill.place === 'built-in' ? undefined : skill.updatedAt

/** `place · description`, the second line of a row. */
export function skillSubline(skill: SkillCatalogEntryView): string {
	const place = skill.plugin ? 'plugin' : skill.place
	return skill.description ? `${place} · ${skill.description}` : place
}

/** A plugin's skills follow their plugin: no menu of their own. */
export const skillHasMenu = (skill: SkillCatalogEntryView): boolean =>
	skillGroupOf(skill) !== 'plugin' && !(skill as SkillRowModel).locked

/** The note under the header when the state is more than on or off. */
export function skillStateNote(state: SkillCatalogState): string | undefined {
	return state === 'name-only' || state === 'user-only'
		? 'Set to name only in this project’s local settings (/skills in the terminal changes it)'
		: undefined
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAY = 86_400_000

/** "today", "3d ago", or "Nov 19" once it is more than a week old. Empty when there is no time. */
export function shortUpdated(iso: string | undefined, now: number): string {
	const time = iso ? Date.parse(iso) : Number.NaN
	if (!Number.isFinite(time)) return ''
	const age = Math.max(0, now - time)
	if (age < DAY) return 'today'
	const days = Math.floor(age / DAY)
	if (days <= 7) return `${days}d ago`
	const date = new Date(time)
	return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`
}

/** "today", "yesterday", "4 days ago" or "on Nov 19": for a sentence. */
export function longUpdated(iso: string | undefined, now: number): string {
	const time = iso ? Date.parse(iso) : Number.NaN
	if (!Number.isFinite(time)) return ''
	const age = Math.max(0, now - time)
	if (age < DAY) return 'today'
	const days = Math.floor(age / DAY)
	if (days === 1) return 'yesterday'
	if (days <= 7) return `${days} days ago`
	const date = new Date(time)
	return `on ${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`
}

/** "Last used" in the detail: a relative word, or a dash. */
export function lastUsedWords(iso: string | undefined, now: number): string {
	return longUpdated(iso, now) || '—'
}

/** The folder a skill lives in, in the words of a path; `~` for the person's home. */
export function skillLocation(skill: SkillCatalogEntryView): string {
	if (skill.plugin || skill.tier === 'plugin')
		return `Shipped with the ${skill.plugin ?? 'plugin'} plugin`
	switch (skill.tier) {
		case 'system':
			return 'Built into Namzu'
		case 'user':
			return `~/.namzu/skills/${skill.name}`
		case 'agents-user':
			return `~/.agents/skills/${skill.name}`
		case 'project':
			return `.namzu/skills/${skill.name}`
		case 'agents-project':
			return `.agents/skills/${skill.name}`
		case 'legacy-project':
			return `skills/${skill.name}`
		default:
			return skill.place
	}
}

export const NO_SKILLS = 'No skills yet. Create skills in .namzu/skills/ or ~/.namzu/skills/.'
export const NO_PLUGINS =
	'No plugins installed. Plugins live in .namzu/plugins/ or ~/.namzu/plugins/.'
export const NO_CONNECTORS = 'No connectors yet.'
export const USE_SKILLS_NOTE =
	'Use them by typing / in chat, or let Namzu use them when a task fits.'

/** A file's place in the tree of a skill's folder. */
export interface FileTreeNode {
	name: string
	path: string
	folder: boolean
	children: FileTreeNode[]
}

/** Folders first, then files, each by name. */
export function fileTree(files: readonly { path: string }[]): FileTreeNode[] {
	const root: FileTreeNode = { name: '', path: '', folder: true, children: [] }
	for (const file of files) {
		const parts = file.path.split('/').filter(Boolean)
		let at = root
		parts.forEach((part, index) => {
			const path = parts.slice(0, index + 1).join('/')
			const last = index === parts.length - 1
			let next = at.children.find((child) => child.name === part && child.folder === !last)
			if (!next) {
				next = { name: part, path, folder: !last, children: [] }
				at.children.push(next)
			}
			at = next
		})
	}
	const order = (nodes: FileTreeNode[]) => {
		nodes.sort((a, b) => Number(b.folder) - Number(a.folder) || a.name.localeCompare(b.name))
		for (const node of nodes) order(node.children)
	}
	order(root.children)
	return root.children
}

/** The file opened first: SKILL.md when there is one, otherwise the first file. */
export function firstFile(files: readonly { path: string }[]): string | undefined {
	return (files.find((file) => file.path === 'SKILL.md') ?? files[0])?.path
}

/** A file's text without the settings block at its top (`---` to `---`), which reads as noise once rendered. */
export function withoutFrontMatter(text: string): string {
	const match = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
	return match ? text.slice(match[0].length).replace(/^\s*\n/, '') : text
}

export const isMarkdownPath = (path: string): boolean => /\.(md|markdown)$/i.test(path)

export type ConnectorStatus =
	| { kind: 'connected' }
	| { kind: 'approve' }
	| { kind: 'failed'; reason?: string }
	| { kind: 'idle' }

export interface ConnectorRowModel {
	name: string
	type: 'Local' | 'Remote'
	source: string
	status: ConnectorStatus
	/** What the row says to a screen reader and in its tooltip. */
	title: string
}

const SOURCE: Record<McpServerView['origin'], string> = {
	'your-config': 'Your own settings',
	'this-project': 'This project’s settings',
	'project-file': '.mcp.json in this project',
}

const isAddress = (detail: string | undefined): boolean =>
	/^[a-z][a-z0-9+.-]*:\/\//i.test(detail ?? '')

/** A server of the project's list as a table row. */
export function connectorRow(server: McpServerView): ConnectorRowModel {
	const status: ConnectorStatus =
		server.state === 'connected'
			? { kind: 'connected' }
			: server.state === 'waiting' && server.fingerprint
				? { kind: 'approve' }
				: server.state === 'failed'
					? { kind: 'failed', ...(server.reason ? { reason: server.reason } : {}) }
					: { kind: 'idle' }
	return {
		name: server.name,
		type: isAddress(server.detail) ? 'Remote' : 'Local',
		source: SOURCE[server.origin],
		status,
		title:
			status.kind === 'failed' && status.reason ? `${server.name}: ${status.reason}` : server.name,
	}
}

/** The table's rows: the open project's servers (which hold the person's own), else the person's own alone. */
export function connectorRows(
	view: McpServersView | undefined,
	own: readonly { name: string; kind: string }[] | undefined,
): ConnectorRowModel[] {
	if (view) return view.servers.map(connectorRow)
	return (own ?? []).map((server) => ({
		name: server.name,
		type: server.kind === 'address' ? ('Remote' as const) : ('Local' as const),
		source: SOURCE['your-config'],
		status: { kind: 'idle' as const },
		title: server.name,
	}))
}

export const CONNECTOR_COLUMNS = ['Connector', 'Type', 'Source', 'Status'] as const
