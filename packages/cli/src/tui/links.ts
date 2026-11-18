/**
 * Web addresses and project files in the text on screen, and what a click on one does.
 *
 * Pure where it can be: finding the links in a line is a function of the text and of which paths
 * exist; opening one goes through a host object, so a test can say what the machine has. A
 * plain click only explains how to open a link; ctrl-click (or alt-click, which some terminals
 * report where they take command-click) opens it. Nothing is ever run through a shell: a browser
 * gets its own opener (`open-browser.ts`) and an editor is started with an argument list.
 */

import { spawn } from 'node:child_process'
import { constants, accessSync, statSync } from 'node:fs'
import { basename, delimiter, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { parseExternalEditorCommand } from './external-editor.js'
import { openInBrowser } from './open-browser.js'

export interface WebLink {
	readonly kind: 'url'
	/** The address, as written. */
	readonly target: string
}

export interface FileLink {
	readonly kind: 'path'
	/** The file, absolute, and inside the project. */
	readonly target: string
	/** The path as written, for the words that name it. */
	readonly written: string
	readonly line?: number
	readonly column?: number
}

export type FoundLink = WebLink | FileLink

/** A link and where it stands in a line of text, in UTF-16 units: `[from, to)`. */
export interface LinkSpan {
	readonly link: FoundLink
	readonly from: number
	readonly to: number
}

const URL_PATTERN = /https?:\/\/[^\s<>"'` ]+/giu
/** A file name with an extension, or a path with folders, then an optional `:line[:column]`. */
const PATH_PATTERN =
	/(?<![\w/.@~:-])((?:\.{1,2}\/|\/)?(?:[\w@+.-]+\/)*[\w@+-][\w@+.-]*\.[A-Za-z][A-Za-z0-9]{0,7})(?::(\d{1,6})(?::(\d{1,6}))?)?(?![\w/@-])/gu

/** Punctuation that ends a sentence and not the address before it. */
function trimUrl(raw: string): string {
	let url = raw
	for (;;) {
		const last = url.at(-1)
		if (last === undefined) return url
		if (/[.,;:!?'"*_]/u.test(last)) {
			url = url.slice(0, -1)
			continue
		}
		// A closing bracket belongs to the address only when it opens one inside it.
		const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{', '>': '<' }
		const open = pairs[last]
		if (open !== undefined) {
			const opens = url.split(open).length - 1
			const closes = url.split(last).length - 1
			if (closes > opens) {
				url = url.slice(0, -1)
				continue
			}
		}
		return url
	}
}

/** What the machine knows about paths: the project folder, and which files exist. */
export interface FileWorld {
	readonly cwd: string
	/** True for a regular file at this absolute path. */
	readonly isFile: (absolute: string) => boolean
}

export function realFileWorld(cwd: string): FileWorld {
	return {
		cwd,
		isFile: (absolute) => {
			try {
				return statSync(absolute).isFile()
			} catch {
				return false
			}
		},
	}
}

/** The absolute path of `written` when it is a file inside the project, else null. */
export function projectFile(written: string, world: FileWorld): string | null {
	if (written.includes('\0')) return null
	const absolute = resolve(world.cwd, written)
	const from = relative(world.cwd, absolute)
	if (from === '' || from.startsWith('..') || isAbsolute(from)) return null
	return world.isFile(absolute) ? absolute : null
}

/**
 * The links in one line of text, in order. A web address is found by its scheme; a path only when
 * it names a file that exists inside the project, so a version number or a word with a dot in it
 * is never taken for one.
 */
export function findLinks(text: string, world: FileWorld): readonly LinkSpan[] {
	const spans: LinkSpan[] = []
	if (text.includes('://')) {
		for (const match of text.matchAll(URL_PATTERN)) {
			const url = trimUrl(match[0])
			if (url.length > 'https://'.length) {
				spans.push({
					link: { kind: 'url', target: url },
					from: match.index,
					to: match.index + url.length,
				})
			}
		}
	}
	if (text.includes('.')) {
		for (const match of text.matchAll(PATH_PATTERN)) {
			const from = match.index
			const to = from + match[0].length
			if (spans.some((span) => from < span.to && to > span.from)) continue
			const written = match[1] as string
			const target = projectFile(written, world)
			if (target === null) continue
			spans.push({
				link: {
					kind: 'path',
					target,
					written,
					...(match[2] !== undefined ? { line: Number(match[2]) } : {}),
					...(match[3] !== undefined ? { column: Number(match[3]) } : {}),
				},
				from,
				to,
			})
		}
	}
	return spans.sort((a, b) => a.from - b.from)
}

// ---- editors

/** Editors that draw in the terminal: they cannot be started beside a screen this program holds. */
const TERMINAL_EDITORS = new Set([
	'vi',
	'vim',
	'nvim',
	'neovim',
	'view',
	'nano',
	'pico',
	'emacs',
	'emacsclient',
	'micro',
	'hx',
	'helix',
	'ed',
	'joe',
	'kak',
	'less',
	'more',
])

/** Window editors tried, in order, when neither VISUAL nor EDITOR names one that can be started. */
const FALLBACK_EDITORS = ['code', 'cursor', 'zed'] as const

function editorName(command: string): string {
	return basename(command)
		.toLowerCase()
		.replace(/\.(exe|cmd|bat)$/u, '')
}

/** The arguments that open `file` at `line` in the editor named `name`; just the file when unknown. */
export function editorArguments(
	name: string,
	file: string,
	line: number | undefined,
	column: number | undefined,
): readonly string[] {
	if (line === undefined) return [file]
	const at = `${file}:${line}${column !== undefined ? `:${column}` : ''}`
	switch (name) {
		case 'code':
		case 'code-insiders':
		case 'codium':
		case 'cursor':
		case 'windsurf':
			return ['--goto', at]
		case 'zed':
		case 'subl':
		case 'sublime_text':
		case 'mate':
			return [at]
		case 'idea':
		case 'webstorm':
		case 'pycharm':
		case 'goland':
		case 'rubymine':
			return ['--line', String(line), file]
		default:
			return [file]
	}
}

export interface EditorLaunch {
	readonly command: string
	readonly args: readonly string[]
}

/**
 * The editor to open `file` in: `$VISUAL`, then `$EDITOR`, then whichever of `code`, `cursor` or
 * `zed` is on the path. A terminal editor is passed over, since it cannot draw while this program
 * holds the screen. Null when there is none.
 */
export function editorFor(
	file: string,
	line: number | undefined,
	column: number | undefined,
	env: Readonly<Record<string, string | undefined>>,
	which: (name: string) => string | null,
): EditorLaunch | null {
	for (const raw of [env.VISUAL, env.EDITOR]) {
		if (!raw?.trim()) continue
		let tokens: readonly string[]
		try {
			tokens = parseExternalEditorCommand(raw.trim())
		} catch {
			continue
		}
		const command = tokens[0] as string
		const name = editorName(command)
		if (TERMINAL_EDITORS.has(name)) continue
		return { command, args: [...tokens.slice(1), ...editorArguments(name, file, line, column)] }
	}
	for (const name of FALLBACK_EDITORS) {
		const path = which(name)
		if (path) return { command: path, args: editorArguments(name, file, line, column) }
	}
	return null
}

/** The first executable called `name` in an absolute directory of the path; project-relative entries are skipped. */
export function whichOnPath(
	name: string,
	env: Readonly<Record<string, string | undefined>>,
): string | null {
	for (const dir of (env.PATH ?? '').split(delimiter)) {
		if (!dir || !isAbsolute(dir)) continue
		const candidate = join(dir, name)
		try {
			accessSync(candidate, constants.X_OK)
			return candidate
		} catch {
			// keep looking
		}
	}
	return null
}

// ---- what a click says

/** The words a click on a link answers with, and whether it went well. */
export interface LinkReport {
	readonly text: string
	readonly ok: boolean
}

/** What the machine can do: injected, so a test says what it has. */
export interface LinkHost {
	readonly env: Readonly<Record<string, string | undefined>>
	/** Hand an address to the browser; false when no launcher could be started. */
	readonly openUrl: (url: string) => boolean
	/** Start a program, detached, with no shell; false when it could not be started. */
	readonly launch: (command: string, args: readonly string[]) => boolean
	readonly which: (name: string) => string | null
	/** The path as the person reads it: relative to the project. */
	readonly show: (absolute: string) => string
}

export function realLinkHost(
	cwd: string,
	env: Readonly<Record<string, string | undefined>>,
): LinkHost {
	return {
		env,
		openUrl: (url) => openInBrowser(url),
		launch: (command, args) => {
			try {
				const child = spawn(command, [...args], { stdio: 'ignore', detached: true, cwd })
				child.on('error', () => undefined)
				child.unref()
				return true
			} catch {
				return false
			}
		},
		which: (name) => whichOnPath(name, env),
		show: (absolute) => {
			const from = relative(cwd, absolute)
			return from.length > 0 && !from.startsWith('..') ? from : absolute
		},
	}
}

function placed(link: FileLink, host: LinkHost): string {
	const where = host.show(link.target)
	return link.line !== undefined ? `${where}:${link.line}` : where
}

/** `how` is `hint` for a plain click, which only says how to open the link, and `open` for ctrl-click. */
export function activateLink(link: FoundLink, how: 'open' | 'hint', host: LinkHost): LinkReport {
	if (link.kind === 'url') {
		if (how === 'hint') return { text: 'Ctrl+click opens this link in your browser.', ok: true }
		return host.openUrl(link.target)
			? { text: `Opening ${link.target}`, ok: true }
			: { text: `Couldn't open your browser. Open ${link.target} yourself.`, ok: false }
	}
	const name = placed(link, host)
	if (how === 'hint') return { text: `Ctrl+click opens ${name} in your editor.`, ok: true }
	const editor = editorFor(link.target, link.line, link.column, host.env, host.which)
	if (editor === null)
		return {
			text: `No editor to open it with (set VISUAL to one that opens a window). The path is ${name}`,
			ok: false,
		}
	return host.launch(editor.command, editor.args)
		? { text: `Opening ${name}`, ok: true }
		: { text: `Couldn't start the editor. The path is ${name}`, ok: false }
}

/** The address a terminal is told the link points at (OSC 8): the web address, or the file's. */
export function linkHref(link: FoundLink): string {
	return link.kind === 'url' ? link.target : pathToFileURL(link.target).href
}

/** How long what a line was found to link to is believed: a file can appear or go. */
const FIND_MEMO_MS = 3_000
const FIND_MEMO_LIMIT = 600

/**
 * `findLinks` for one project, remembering the answer for a line of text for a few seconds: the
 * window asks for every visible row on every frame, and the same lines come back each time.
 */
export function createLinkFinder(
	world: FileWorld,
	now: () => number = Date.now,
): (text: string) => readonly LinkSpan[] {
	const memo = new Map<string, { readonly at: number; readonly spans: readonly LinkSpan[] }>()
	return (text) => {
		const at = now()
		const hit = memo.get(text)
		if (hit && at - hit.at < FIND_MEMO_MS) return hit.spans
		const spans = findLinks(text, world)
		if (memo.size >= FIND_MEMO_LIMIT) memo.clear()
		memo.set(text, { at, spans })
		return spans
	}
}
