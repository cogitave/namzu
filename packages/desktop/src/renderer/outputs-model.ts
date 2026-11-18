import { type OutputCardKind, outputCardKind } from '../shared/output-files.js'
import type { ThreadState } from '../shared/projection.js'
import { baseName, turnChanges } from './turn-changes.js'

/**
 * The files a conversation's turns wrote, for the Outputs pane. They come from the same edit
 * receipts the Changes panel and the reply's change card use, so the three always agree on what
 * was written. A file whose turn was undone is no longer an output.
 */

/** How the pane shows a file. */
export type PreviewKind = 'html' | 'markdown' | 'image' | 'code'

export interface OutputFile {
	/** The path as the receipts name it; the host decides whether it may be read. */
	path: string
	name: string
	/** The folder the file sits in, shortened, for the row's tag; empty at the top. */
	folder: string
	kind: PreviewKind
	/** The turn that wrote it last. */
	turn: number
	/** Receipts so far: grows when the file is written again, so a viewer knows to read it again. */
	version: number
	/** The conversation made the file, as opposed to editing one that was there. */
	created: boolean
	/** What a person calls it: a page, a document, a picture. */
	cardKind: OutputCardKind
	/** A command or a tool made it, so no edit receipt names it. */
	made?: true
}

/** A result file the host found a turn made by running something. */
export interface MadeOutput {
	path: string
	turn: number
}

const HTML = /\.html?$/i
const MARKDOWN = /\.(md|markdown)$/i
const IMAGE = /\.(png|jpe?g|gif|webp)$/i

export function previewKind(path: string): PreviewKind {
	return HTML.test(path)
		? 'html'
		: MARKDOWN.test(path)
			? 'markdown'
			: IMAGE.test(path)
				? 'image'
				: 'code'
}

/** Kinds a person is shown without asking: a page or a document the turn wrote or changed. */
export const opensByItself = (kind: PreviewKind): boolean => kind === 'html' || kind === 'markdown'

function folderOf(path: string): string {
	const parts = path.split(/[\\/]/).filter(Boolean)
	parts.pop()
	if (parts.length === 0) return ''
	// An absolute path says its last two folders, which is what tells two files of one name apart.
	return parts.slice(-2).join('/')
}

/**
 * The path the preview's address line shows: relative to the work folder when the file sits
 * inside it, the whole path otherwise. Slashes of either kind and a drive letter's case are
 * compared as written, so a Windows folder works like any other.
 */
export function outputAddress(path: string, workFolder?: string): string {
	if (!workFolder) return path
	const norm = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '')
	const root = norm(workFolder)
	const target = norm(path)
	const windows = /^[a-z]:/i.test(root)
	const same = (a: string, b: string) => (windows ? a.toLowerCase() === b.toLowerCase() : a === b)
	if (root === '' || target.length <= root.length + 1) return path
	if (!same(target.slice(0, root.length), root) || target[root.length] !== '/') return path
	return target.slice(root.length + 1)
}

/** Every output of the conversation, the most recently written first. */
export function outputFiles(
	thread: Pick<ThreadState, 'timeline' | 'tools' | 'turns' | 'undo'>,
	made: readonly MadeOutput[] = [],
): OutputFile[] {
	const byPath = new Map<string, OutputFile>()
	const turns = [...turnChanges(thread).values()].sort((a, b) => a.turn - b.turn)
	for (const changes of turns) {
		const turnId = thread.turns[changes.turn]?.turnId
		const undone = turnId ? thread.undo?.[turnId]?.status === 'undone' : false
		for (const file of changes.files) {
			if (!file.path || file.path === 'File') continue
			if (undone) {
				// A turn put fully back removes what it created and restores what it edited.
				byPath.delete(file.path)
				continue
			}
			const before = byPath.get(file.path)
			byPath.set(file.path, {
				path: file.path,
				name: baseName(file.path),
				folder: folderOf(file.path),
				kind: previewKind(file.path),
				turn: changes.turn,
				version: (before?.version ?? 0) + file.receiptIds.length,
				created: before?.created ?? file.created,
				cardKind: outputCardKind(file.path),
			})
		}
	}
	// A file a command or a tool made is an output too, unless a receipt already names it (the same
	// path, or the same file written as a path from the work folder) or its turn was undone.
	const written = [...byPath.keys()].map((path) => path.replace(/\\/g, '/').replace(/^\.\//, ''))
	for (const file of made) {
		const turnId = thread.turns[file.turn]?.turnId
		if (turnId && thread.undo?.[turnId]?.status === 'undone') continue
		const flat = file.path.replace(/\\/g, '/')
		if (written.some((path) => flat === path || flat.endsWith(`/${path}`))) continue
		const before = byPath.get(file.path)
		byPath.set(file.path, {
			path: file.path,
			name: baseName(file.path),
			folder: folderOf(file.path),
			kind: previewKind(file.path),
			turn: Math.max(before?.turn ?? 0, file.turn),
			version: (before?.version ?? 0) + 1,
			created: true,
			cardKind: outputCardKind(file.path),
			made: true,
		})
	}
	return [...byPath.values()].sort((a, b) => b.turn - a.turn || a.name.localeCompare(b.name))
}

/**
 * The output to open on its own after a change, or `undefined`. Only a page or a document the
 * turn wrote or changed since `seen` counts; with several, the most recently written wins.
 * `seen` maps a path to the version already known; a conversation first loaded from history
 * passes its own current versions, so old files never pop open.
 */
export function outputToOpen(
	outputs: readonly OutputFile[],
	seen: ReadonlyMap<string, number>,
): OutputFile | undefined {
	return outputs.find(
		(file) => opensByItself(file.kind) && (seen.get(file.path) ?? 0) < file.version,
	)
}
