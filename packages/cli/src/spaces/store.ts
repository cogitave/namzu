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

export interface SavedSpace {
	readonly name: string
	readonly cwd: string
	readonly lastAccount?: string
	readonly sessions: readonly SavedSession[]
}

/** The layout `namzu spaces` restores: spaces and sessions in order, and where focus was. */
export interface SavedLayout {
	readonly version: 1
	readonly spaces: readonly SavedSpace[]
	readonly focus?: { readonly space: number; readonly session: number }
}

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

/** A layout read from disk, keeping what is well formed and dropping the rest. */
export function parseLayout(raw: unknown): SavedLayout | undefined {
	if (typeof raw !== 'object' || raw === null) return undefined
	const body = raw as Record<string, unknown>
	if (body.version !== 1 || !Array.isArray(body.spaces)) return undefined
	const spaces: SavedSpace[] = []
	for (const item of body.spaces) {
		if (typeof item !== 'object' || item === null) continue
		const space = item as Record<string, unknown>
		const cwd = text(space.cwd, 4096)
		const name = text(space.name, 256)
		if (!cwd || !name || !Array.isArray(space.sessions)) continue
		const sessions: SavedSession[] = []
		for (const entry of space.sessions) {
			if (typeof entry !== 'object' || entry === null) continue
			const session = entry as Record<string, unknown>
			const label = text(session.label, 256)
			if (!label) continue
			const conversationId = text(session.conversationId, 128)
			const account = text(session.account, 128)
			const pickedAccount = text(session.pickedAccount, 128)
			sessions.push({
				label,
				...(conversationId ? { conversationId } : {}),
				...(account ? { account } : {}),
				...(pickedAccount ? { pickedAccount } : {}),
			})
		}
		if (sessions.length === 0) continue
		const lastAccount = text(space.lastAccount, 128)
		spaces.push({ name, cwd, ...(lastAccount ? { lastAccount } : {}), sessions })
	}
	if (spaces.length === 0) return undefined
	const focus =
		typeof body.focus === 'object' && body.focus !== null
			? (body.focus as Record<string, unknown>)
			: undefined
	const fs = index(focus?.space)
	const fe = index(focus?.session)
	const valid = fs !== undefined && fe !== undefined && spaces[fs]?.sessions[fe] !== undefined
	return {
		version: 1,
		spaces,
		...(valid ? { focus: { space: fs, session: fe } } : {}),
	}
}

/** The layout file under the Namzu home: private to the user, replaced whole so a crash never leaves half of it. */
export function fileStore(path: string): SpacesStore {
	return {
		load() {
			try {
				return parseLayout(JSON.parse(readFileSync(path, 'utf8')))
			} catch {
				return undefined
			}
		},
		save(layout) {
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
