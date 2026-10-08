import { closeSync, openSync } from 'node:fs'
import { ReadStream } from 'node:tty'

/** The Windows device name of the console's input buffer. */
export const CONSOLE_INPUT_DEVICE = String.raw`\\.\CONIN$`

export interface ConsoleInput {
	readonly stream: NodeJS.ReadStream
	/** Give the console back. */
	release(): void
}

/**
 * The console's own keyboard, for a Windows process whose standard input is not it.
 *
 * Electron's executable run as a plain interpreter is a Windows-subsystem program: on
 * a pseudo-console its standard output is the console but its standard input is a null
 * device, so `process.stdin` is not a terminal and the interactive screen cannot read
 * keys or switch to raw mode. The console input device opens independently of the
 * standard handles. This returns a terminal stream on it only when that is the situation
 * (Windows, output a terminal, input not), and `undefined` everywhere else, including
 * when the device cannot be opened, so an ordinary launch is untouched.
 */
export function openConsoleInput(
	streams: {
		readonly stdin: { readonly isTTY?: boolean }
		readonly stdout: { readonly isTTY?: boolean }
	} = process,
	platform: NodeJS.Platform = process.platform,
	io: {
		open(path: string): number
		close(fd: number): void
		stream(fd: number): NodeJS.ReadStream
	} = {
		open: (path) => openSync(path, 'r+'),
		close: closeSync,
		stream: (fd) => new ReadStream(fd) as unknown as NodeJS.ReadStream,
	},
): ConsoleInput | undefined {
	if (platform !== 'win32' || streams.stdin.isTTY === true || streams.stdout.isTTY !== true)
		return undefined
	let fd: number
	try {
		fd = io.open(CONSOLE_INPUT_DEVICE)
	} catch {
		return undefined
	}
	try {
		const stream = io.stream(fd)
		return { stream, release: () => stream.destroy() }
	} catch {
		try {
			io.close(fd)
		} catch {
			/* Nothing was opened that needs closing. */
		}
		return undefined
	}
}
