import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync } from 'node:fs'

/** The file's text is there but is not what Namzu wrote: unparseable, oversized or the wrong shape. */
export class DamagedFileError extends Error {
	override readonly name = 'DamagedFileError'
}

export interface DamagedFileOps {
	read(file: string): string
	rename(from: string, to: string): void
}

const realOps: DamagedFileOps = {
	read: (file) => readFileSync(file, 'utf8'),
	rename: renameSync,
}

/**
 * Moves a file Namzu cannot read to `<name>.bad`, so the next save does not overwrite the only
 * copy of what the person had. A previous `.bad` is replaced: the newest damage is the one worth
 * keeping. Returns whether the file is out of the way; a failed move leaves it where it was.
 */
export function setAsideDamaged(
	file: string,
	ops: Pick<DamagedFileOps, 'rename'> = realOps,
): boolean {
	try {
		ops.rename(file, `${file}.bad`)
		return true
	} catch {
		return false
	}
}

export interface ReadStoredFileOptions {
	file: string
	/** Throws a `DamagedFileError` (or lets a parse error through) for text of the wrong shape. */
	parse: (text: string) => unknown
	/** The file was damaged. `movedAside` says whether it now sits at `<file>.bad`. */
	onDamaged?: (movedAside: boolean) => void
	/** The file could not be read at all (permissions, a folder in its place); it is left alone. */
	onUnreadable?: (error: unknown) => void
	ops?: DamagedFileOps
}

/**
 * Reads a small stored file for startup. A missing file is the normal first run. A damaged one is
 * set aside and reads as absent, so the app starts on defaults. A file that cannot be opened is
 * not touched: it may be a lock or a permission that clears, and moving it would lose nothing
 * but gain nothing either.
 */
export function readStoredFile(options: ReadStoredFileOptions): unknown {
	const ops = options.ops ?? realOps
	let text: string
	try {
		text = ops.read(options.file)
	} catch (error) {
		if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'))
			options.onUnreadable?.(error)
		return undefined
	}
	try {
		return options.parse(text)
	} catch (error) {
		if (!(error instanceof SyntaxError || error instanceof DamagedFileError)) throw error
		// The move is not an argument of the callback: it must happen when nobody is listening too.
		const movedAside = setAsideDamaged(options.file, ops)
		options.onDamaged?.(movedAside)
		return undefined
	}
}

/** `JSON.parse` that refuses anything but an object (or an array, when allowed). */
export function parseJsonShape(
	text: string,
	shape: 'object' | 'array',
	maxBytes?: number,
): unknown {
	if (maxBytes !== undefined && text.length > maxBytes) throw new DamagedFileError('too large')
	const value: unknown = JSON.parse(text)
	const ok =
		shape === 'array'
			? Array.isArray(value)
			: value !== null && typeof value === 'object' && !Array.isArray(value)
	if (!ok) throw new DamagedFileError('wrong shape')
	return value
}

export type DamagedFileKind = 'settings' | 'layout' | 'projects'

const KIND_WORDS: Record<DamagedFileKind, string> = {
	settings: 'settings',
	layout: 'window layout',
	projects: 'project list',
}

/** What a person is told once, after a start that set damaged files aside. */
export interface DamagedFilesNotice {
	id: string
	text: string
}

function joined(words: string[]): string {
	if (words.length <= 1) return words.join('')
	return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
}

/**
 * Collects the files a start set aside and hands out one plain notice for them. The notice stays
 * until the window that showed it acknowledges it, so a window reloaded after a crash is told
 * again instead of the news being lost with the old page.
 */
export class DamagedFilesNotices {
	private readonly kinds = new Set<DamagedFileKind>()
	private readonly left = new Set<DamagedFileKind>()
	private pending: DamagedFilesNotice | undefined

	constructor(private readonly newId: () => string = randomUUID) {}

	add(kind: DamagedFileKind, movedAside: boolean): void {
		this.kinds.add(kind)
		if (!movedAside) this.left.add(kind)
		this.pending = undefined
	}

	current(): DamagedFilesNotice | undefined {
		if (this.kinds.size === 0) return undefined
		this.pending ??= { id: this.newId(), text: this.text() }
		return { ...this.pending }
	}

	/** True when this was the notice on offer; a stale id changes nothing. */
	acknowledge(id: unknown): boolean {
		if (!this.pending || this.pending.id !== id) return false
		this.kinds.clear()
		this.left.clear()
		this.pending = undefined
		return true
	}

	private text(): string {
		// Always in the same order, whichever file was read first.
		const words = (Object.keys(KIND_WORDS) as DamagedFileKind[])
			.filter((kind) => this.kinds.has(kind))
			.map((kind) => KIND_WORDS[kind])
		const many = words.length > 1
		const subject = `Namzu could not read your saved ${joined(words)}, so it started with ${many ? 'the defaults' : 'the default'}.`
		const kept = this.left.size
			? ' It could not move the damaged file aside, so the next change will replace it.'
			: ` The damaged ${many ? 'files were' : 'file was'} set aside, not deleted.`
		return subject + kept
	}
}
