import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveNamzuHome } from '@namzu/sdk'

export const SPACES_FILE = 'spaces.json'

/** One session as it is kept between runs. */
export interface SavedSession {
	readonly label: string
	/** The conversation, once it has one; the session resumes it when opened. */
	readonly conversationId?: string
	/** The label of the non-usual account the session was on. */
	readonly account?: string
	/** The account id picked when it started, for a session with no conversation yet. */
	readonly pickedAccount?: string
}

/** A pane tree as kept: a split with its direction, ratio and two children, or one session. */
export type SavedNode =
	| { readonly session: SavedSession }
	| {
			readonly split: 'side' | 'stack'
			readonly ratio: number
			readonly a: SavedNode
			readonly b: SavedNode
	  }

export interface SavedTab {
	/** The name the user gave the tab; without one it shows its number. */
	readonly name?: string
	readonly tree: SavedNode
	/** Which pane has focus, counted left to right and top to bottom. */
	readonly focus?: number
	readonly zoomed?: boolean
}

export interface SavedSpace {
	readonly name: string
	readonly cwd: string
	readonly lastAccount?: string
	readonly tabs: readonly SavedTab[]
	/** The tab shown when the space is opened. */
	readonly activeTab?: number
}

/** The layout `namzu spaces` restores: spaces with their tabs and pane trees, and where focus was. */
export interface SavedLayout {
	readonly version: 2
	readonly spaces: readonly SavedSpace[]
	/** The space that was shown. */
	readonly focus?: { readonly space: number }
}

/** The largest tree read back, so a damaged file cannot ask for an absurd layout. */
const MAX_PANES_PER_TAB = 64
const MAX_DEPTH = 32

export interface SpacesStore {
	load(): SavedLayout | undefined
	save(layout: SavedLayout): void
}

export function spacesFilePath(env: NodeJS.ProcessEnv): string {
	return join(resolveNamzuHome({ env }), SPACES_FILE)
}

function text(value: unknown, max = 512): string | undefined {
	return typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined
}

function index(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

function readSession(raw: unknown): SavedSession | undefined {
	if (typeof raw !== 'object' || raw === null) return undefined
	const session = raw as Record<string, unknown>
	const label = text(session.label, 256)
	if (!label) return undefined
	const conversationId = text(session.conversationId, 128)
	const account = text(session.account, 128)
	const pickedAccount = text(session.pickedAccount, 128)
	return {
		label,
		...(conversationId ? { conversationId } : {}),
		...(account ? { account } : {}),
		...(pickedAccount ? { pickedAccount } : {}),
	}
}

function readNode(raw: unknown, budget: { left: number }, depth: number): SavedNode | undefined {
	if (typeof raw !== 'object' || raw === null || depth > MAX_DEPTH) return undefined
	const node = raw as Record<string, unknown>
	if (node.split === undefined) {
		if (budget.left <= 0) return undefined
		const session = readSession(node.session)
		if (!session) return undefined
		budget.left--
		return { session }
	}
	if (node.split !== 'side' && node.split !== 'stack') return undefined
	const a = readNode(node.a, budget, depth + 1)
	const b = readNode(node.b, budget, depth + 1)
	// A half that cannot be read leaves the other to fill the room.
	if (!a || !b) return a ?? b
	const ratio =
		typeof node.ratio === 'number' && Number.isFinite(node.ratio)
			? Math.max(0.1, Math.min(0.9, node.ratio))
			: 0.5
	return { split: node.split, ratio, a, b }
}

function countPanes(node: SavedNode): number {
	return 'session' in node ? 1 : countPanes(node.a) + countPanes(node.b)
}

/** Version 1 kept a flat list of sessions per space; each becomes a tab of its own, in the same order. */
function migrateV1(body: Record<string, unknown>): SavedLayout | undefined {
	if (!Array.isArray(body.spaces)) return undefined
	const focus =
		typeof body.focus === 'object' && body.focus !== null
			? (body.focus as Record<string, unknown>)
			: undefined
	const oldSpace = index(focus?.space)
	const oldSession = index(focus?.session)
	const spaces: SavedSpace[] = []
	let focused: number | undefined
	body.spaces.forEach((item, spaceIndex) => {
		if (typeof item !== 'object' || item === null) return
		const space = item as Record<string, unknown>
		const cwd = text(space.cwd, 4096)
		const name = text(space.name, 256)
		if (!cwd || !name || !Array.isArray(space.sessions)) return
		const tabs: SavedTab[] = []
		let active: number | undefined
		space.sessions.forEach((entry, at) => {
			const session = readSession(entry)
			if (!session) return
			if (spaceIndex === oldSpace && at === oldSession) active = tabs.length
			tabs.push({ tree: { session } })
		})
		if (tabs.length === 0) return
		if (active !== undefined) focused = spaces.length
		const lastAccount = text(space.lastAccount, 128)
		spaces.push({
			name,
			cwd,
			...(lastAccount ? { lastAccount } : {}),
			tabs,
			...(active !== undefined ? { activeTab: active } : {}),
		})
	})
	if (spaces.length === 0) return undefined
	return { version: 2, spaces, ...(focused !== undefined ? { focus: { space: focused } } : {}) }
}

/**
 * A layout read from disk, keeping what is well formed and dropping the rest.
 * Version 1 files (a flat list of sessions per space) are migrated.
 */
export function parseLayout(raw: unknown): SavedLayout | undefined {
	if (typeof raw !== 'object' || raw === null) return undefined
	const body = raw as Record<string, unknown>
	if (body.version === 1) return migrateV1(body)
	if (body.version !== 2 || !Array.isArray(body.spaces)) return undefined
	const spaces: SavedSpace[] = []
	for (const item of body.spaces) {
		if (typeof item !== 'object' || item === null) continue
		const space = item as Record<string, unknown>
		const cwd = text(space.cwd, 4096)
		const name = text(space.name, 256)
		if (!cwd || !name || !Array.isArray(space.tabs)) continue
		const tabs: SavedTab[] = []
		for (const entry of space.tabs) {
			if (typeof entry !== 'object' || entry === null) continue
			const tab = entry as Record<string, unknown>
			const tree = readNode(tab.tree, { left: MAX_PANES_PER_TAB }, 0)
			if (!tree) continue
			const tabName = text(tab.name, 256)
			const focus = index(tab.focus)
			tabs.push({
				...(tabName ? { name: tabName } : {}),
				tree,
				...(focus !== undefined && focus < countPanes(tree) ? { focus } : {}),
				...(tab.zoomed === true && countPanes(tree) > 1 ? { zoomed: true } : {}),
			})
		}
		if (tabs.length === 0) continue
		const lastAccount = text(space.lastAccount, 128)
		const active = index(space.activeTab)
		spaces.push({
			name,
			cwd,
			...(lastAccount ? { lastAccount } : {}),
			tabs,
			...(active !== undefined && active < tabs.length ? { activeTab: active } : {}),
		})
	}
	if (spaces.length === 0) return undefined
	const focus =
		typeof body.focus === 'object' && body.focus !== null
			? (body.focus as Record<string, unknown>)
			: undefined
	const fs = index(focus?.space)
	return {
		version: 2,
		spaces,
		...(fs !== undefined && spaces[fs] !== undefined ? { focus: { space: fs } } : {}),
	}
}

/** The layout file under the Namzu home: private to the user, replaced whole so a crash never leaves half of it. */
export function fileStore(path: string, say?: (message: string) => void): SpacesStore {
	// A file written by a newer Namzu is never overwritten by this one.
	let foreign = false
	return {
		load() {
			try {
				const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
				if (
					typeof raw === 'object' &&
					raw !== null &&
					typeof (raw as { version?: unknown }).version === 'number' &&
					(raw as { version: number }).version !== 1 &&
					(raw as { version: number }).version !== 2
				) {
					if (!foreign) {
						foreign = true
						say?.(
							`The saved spaces layout at ${path} was written by a newer version of Namzu. It is left as it is, and this run starts with an empty layout that will not be saved.`,
						)
					}
					return undefined
				}
				return parseLayout(raw)
			} catch {
				return undefined
			}
		},
		save(layout) {
			if (foreign) return
			const temp = `${path}.${randomBytes(4).toString('hex')}.tmp`
			try {
				mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
				writeFileSync(temp, `${JSON.stringify(layout, null, '\t')}\n`, { mode: 0o600 })
				chmodSync(temp, 0o600)
				renameSync(temp, path)
			} catch {
				// Not being able to remember the layout must never stop a session.
				try {
					rmSync(temp, { force: true })
				} catch {
					// Nothing left to remove.
				}
			}
		},
	}
}
