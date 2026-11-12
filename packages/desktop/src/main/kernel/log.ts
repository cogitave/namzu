import { homedir } from 'node:os'
import { dirname } from 'node:path'
import type { KernelFs } from './fs.js'
import type { KernelLog } from './store.js'

/**
 * `updates.log`: one JSON object per line, capped, with nothing about the person in it. A
 * file that reaches the cap becomes `updates.log.1` (the one older file kept) and a new one
 * starts. A failed write is dropped: the log never changes what the app does.
 */

export const LOG_CAP_BYTES = 1024 * 1024
const MAX_TEXT = 200

export interface KernelLogOptions {
	fs: KernelFs
	path: string
	now: () => number
	/** Folders whose names are replaced in any text written: the app data folder, the home. */
	hide?: string[]
	capBytes?: number
}

const ESCAPE = /[.*+?^${}()|[\]\\]/g

/** Text with the given folders, any other absolute path, and control characters taken out. */
export function scrub(text: string, hide: readonly string[] = []): string {
	let out = text
	for (const folder of hide) {
		if (folder.length < 3) continue
		out = out.replace(new RegExp(folder.replace(ESCAPE, '\\$&'), 'gi'), '<folder>')
	}
	out = out
		.replace(/[A-Za-z]:[\\/][^'"`)\]\r\n]*/g, '<path>')
		.replace(/(^|[\s(=:'"`])\/(?:[^\s/'"`)\]]+\/)+[^\s/'"`)\]]*/g, '$1<path>')
		.replace(/\\\\[^\s'"`)\]]+/g, '<path>')
	let clean = ''
	for (const char of out) {
		const code = char.charCodeAt(0)
		clean += code < 32 || code === 127 ? ' ' : char
	}
	return clean.length > MAX_TEXT ? `${clean.slice(0, MAX_TEXT)}…` : clean
}

function plain(value: unknown, hide: readonly string[]): unknown {
	if (typeof value === 'string') return scrub(value, hide)
	if (typeof value === 'number' || typeof value === 'boolean') return value
	return undefined
}

export type FlushableLog = KernelLog & {
	/** Resolves when every line written so far has reached the file. */
	flush(): Promise<void>
}

export function createKernelLog(options: KernelLogOptions): FlushableLog {
	const cap = options.capBytes ?? LOG_CAP_BYTES
	const hide = [...(options.hide ?? [])]
	try {
		hide.push(homedir())
	} catch {
		// no home to hide
	}
	let size: number | undefined
	let chain: Promise<void> = Promise.resolve()
	const write = async (line: string): Promise<void> => {
		const { fs, path } = options
		if (size === undefined) {
			await fs.mkdir(dirname(path), { recursive: true })
			size = (await fs.stat(path))?.size ?? 0
		}
		if (size + line.length > cap) {
			await fs.rm(`${path}.1`)
			await fs.rename(path, `${path}.1`)
			size = 0
		}
		await fs.appendFile(path, line)
		size += line.length
	}
	const log: KernelLog = (event, detail) => {
		const entry: Record<string, unknown> = { at: new Date(options.now()).toISOString(), event }
		for (const [key, value] of Object.entries(detail ?? {})) {
			const clean = plain(value, hide)
			if (clean !== undefined) entry[key] = clean
		}
		const line = `${JSON.stringify(entry)}\n`
		chain = chain
			.then(() => write(line))
			.catch(() => {
				size = undefined
			})
	}
	return Object.assign(log, { flush: () => chain })
}
