import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { type TerminalTabView, isTerminalTabId } from '../shared/terminal-tabs.js'

const FILE_VERSION = 1
/** A saved screen is for looking back at. A serialized screen is not cut (it would end mid-sequence), so a larger one is not kept. */
export const MAX_SAVED_SCREEN = 512 * 1024
const MAX_FILE_BYTES = 16 * 1024 * 1024
const MAX_TABS = 64

/** A terminal tab as it is kept between runs: the tab and the last screen it showed. */
export interface SavedTerminalTab {
	view: TerminalTabView
	screen: string
}

const ENGINES = ['namzu', 'codex-cli', 'claude-code']

function text(value: unknown, max: number): string | undefined {
	return typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined
}

function readTab(value: unknown): SavedTerminalTab | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
	const record = value as Record<string, unknown>
	const id = record.id
	const projectId = text(record.projectId, 256)
	const title = text(record.title, 200)
	if (typeof id !== 'string' || !isTerminalTabId(id) || !projectId || !title) return undefined
	if (record.kind !== 'shell' && record.kind !== 'engine') return undefined
	if (record.engine !== undefined && !ENGINES.includes(record.engine as string)) return undefined
	if (record.kind === 'engine' && record.engine === undefined) return undefined
	if (typeof record.createdAt !== 'number' || !Number.isSafeInteger(record.createdAt))
		return undefined
	if (
		record.exitCode !== undefined &&
		(typeof record.exitCode !== 'number' || !Number.isSafeInteger(record.exitCode))
	)
		return undefined
	const screen =
		typeof record.screen === 'string' && record.screen.length <= MAX_SAVED_SCREEN
			? record.screen
			: ''
	const ended = record.status === 'exited'
	const view: TerminalTabView = {
		id,
		projectId,
		kind: record.kind,
		...(record.engine ? { engine: record.engine as TerminalTabView['engine'] } : {}),
		title,
		// Whatever was running when the app closed is gone; its screen is what is left.
		status: ended ? 'exited' : 'restored',
		...(record.exitCode === undefined ? {} : { exitCode: record.exitCode as number }),
		createdAt: record.createdAt,
	}
	if (view.kind === 'engine') view.activity = 'exited'
	return { view, screen }
}

/**
 * The terminal tabs between runs, in a file of their own beside the workspace layout. A missing or
 * damaged file reads as no tabs, and the next save writes it whole.
 */
export class TerminalTabStore {
	constructor(
		private readonly file: string,
		private readonly onError?: (error: unknown, operation: 'read' | 'write') => void,
	) {}

	load(): SavedTerminalTab[] {
		try {
			const source = readFileSync(this.file, 'utf8')
			if (source.length > MAX_FILE_BYTES) throw new Error('Terminal tab file is too large.')
			const parsed = JSON.parse(source) as { version?: unknown; tabs?: unknown }
			if (parsed.version !== FILE_VERSION || !Array.isArray(parsed.tabs)) return []
			const seen = new Set<string>()
			const tabs: SavedTerminalTab[] = []
			for (const entry of parsed.tabs.slice(0, MAX_TABS)) {
				const tab = readTab(entry)
				if (!tab || seen.has(tab.view.id)) continue
				seen.add(tab.view.id)
				tabs.push(tab)
			}
			return tabs
		} catch (error) {
			if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'))
				this.onError?.(error, 'read')
			return []
		}
	}

	save(tabs: readonly SavedTerminalTab[]): void {
		try {
			if (tabs.length === 0) {
				// Nothing to keep: do not leave an earlier run's screens behind.
				rmSync(this.file, { force: true })
				return
			}
			mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
			const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`
			writeFileSync(
				temporary,
				JSON.stringify({
					version: FILE_VERSION,
					tabs: tabs.slice(0, MAX_TABS).map(({ view, screen }) => ({
						id: view.id,
						projectId: view.projectId,
						kind: view.kind,
						...(view.engine ? { engine: view.engine } : {}),
						title: view.title,
						status: view.status,
						...(view.exitCode === undefined ? {} : { exitCode: view.exitCode }),
						createdAt: view.createdAt,
						screen: screen.length <= MAX_SAVED_SCREEN ? screen : '',
					})),
				}),
				{ mode: 0o600 },
			)
			renameSync(temporary, this.file)
		} catch (error) {
			this.onError?.(error, 'write')
		}
	}
}
