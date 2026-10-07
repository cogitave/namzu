import { execFileSync } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

import { OEM_UPPER_HALF } from './oem-code-pages.js'

/**
 * Decodes the bytes a host command writes.
 *
 * Off Windows that is UTF-8. On Windows, cmd and console programs write the
 * console's OEM code page (850 on Western installs, 857 on Turkish ones), not
 * UTF-8, so a strict UTF-8 decode turns `ç` into U+FFFD. PowerShell and Node
 * children do write UTF-8. So a stream starts as strict UTF-8 and falls back
 * to the code page for good the first time it holds bytes that are not UTF-8.
 */
export interface HostOutputDecoder {
	write(chunk: Buffer): string
	end(): string
}

export interface HostOutputDecoderOptions {
	readonly platform?: NodeJS.Platform
	/** Windows only: the OEM code page. Default: probed once with `chcp`. */
	readonly codePage?: number | undefined
}

let probedCodePage: number | null | undefined

/** The console's active code page on Windows, probed once; null when unknown. */
export function probeOemCodePage(): number | null {
	if (probedCodePage !== undefined) return probedCodePage
	try {
		const out = execFileSync('cmd.exe', ['/d', '/s', '/c', 'chcp'], {
			encoding: 'latin1',
			windowsHide: true,
			stdio: ['ignore', 'pipe', 'ignore'],
			timeout: 5000,
		})
		const match = /(\d{3,5})\s*$/.exec(out.trim())
		probedCodePage = match ? Number(match[1]) : null
	} catch {
		probedCodePage = null
	}
	return probedCodePage
}

/** A decoder for one non-UTF-8 console code page, or undefined when none is known. */
function legacyDecoder(codePage: number | undefined): HostOutputDecoder | undefined {
	if (codePage === undefined || codePage === 65001) return undefined
	const table = OEM_UPPER_HALF[codePage]
	if (table !== undefined) {
		// Single-byte: no state between chunks.
		return {
			write(chunk) {
				let text = ''
				for (const byte of chunk)
					text += byte < 0x80 ? String.fromCharCode(byte) : table[byte - 0x80]
				return text
			},
			end: () => '',
		}
	}
	// The WHATWG labels Node knows: Windows ANSI pages and IBM866.
	const label =
		codePage >= 1250 && codePage <= 1258
			? `windows-${codePage}`
			: codePage === 866
				? 'ibm866'
				: undefined
	if (label === undefined) return undefined
	try {
		const decoder = new TextDecoder(label)
		return {
			write: (chunk) => decoder.decode(chunk, { stream: true }),
			end: () => decoder.decode(),
		}
	} catch {
		return undefined
	}
}

/** The trailing bytes of `bytes` that start a UTF-8 character it does not finish. */
function incompleteUtf8Tail(bytes: Buffer): Buffer {
	for (let back = 1; back <= Math.min(3, bytes.length); back++) {
		const byte = bytes[bytes.length - back] as number
		if ((byte & 0xc0) === 0x80) continue
		const needed = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1
		return needed > back ? bytes.subarray(bytes.length - back) : Buffer.alloc(0)
	}
	return Buffer.alloc(0)
}

export function createHostOutputDecoder(options: HostOutputDecoderOptions = {}): HostOutputDecoder {
	const platform = options.platform ?? process.platform
	if (platform !== 'win32') return new StringDecoder('utf8')
	const legacy = legacyDecoder(
		'codePage' in options ? options.codePage : (probeOemCodePage() ?? undefined),
	)
	if (legacy === undefined) return new StringDecoder('utf8')
	let utf8: InstanceType<typeof TextDecoder> | undefined = new TextDecoder('utf-8', { fatal: true })
	// The bytes of a character cut by the last chunk, which the UTF-8 decoder
	// holds internally and cannot hand back when the stream turns out not to
	// be UTF-8: the legacy decoder must start from them, not lose them.
	let tail: Buffer = Buffer.alloc(0)
	return {
		write(chunk) {
			if (utf8 !== undefined) {
				try {
					const text = utf8.decode(chunk, { stream: true })
					tail = incompleteUtf8Tail(chunk.length >= 3 ? chunk : Buffer.concat([tail, chunk]))
					return text
				} catch {
					utf8 = undefined
					return legacy.write(Buffer.concat([tail, chunk]))
				}
			}
			return legacy.write(chunk)
		},
		end() {
			if (utf8 !== undefined) {
				try {
					return utf8.decode()
				} catch {
					utf8 = undefined
					return legacy.write(tail) + legacy.end()
				}
			}
			return legacy.end()
		},
	}
}

/** Decode a whole captured buffer. */
export function decodeHostOutput(bytes: Buffer, options: HostOutputDecoderOptions = {}): string {
	const decoder = createHostOutputDecoder(options)
	return decoder.write(bytes) + decoder.end()
}
