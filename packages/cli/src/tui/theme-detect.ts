/**
 * Whether the terminal's background is dark or light, for the `auto` theme.
 *
 * Two sources, in order: what the terminal itself reports (a background-colour
 * query answered on stdin) and the `COLORFGBG` variable some terminals set.
 * Neither answering means dark.
 */

export type Background = 'dark' | 'light'

/** The query for the terminal's background colour (OSC 11), ended by BEL. */
export const BACKGROUND_QUERY = '\x1b]11;?\x07'

/**
 * `COLORFGBG` is `foreground;background` (some terminals add a middle field):
 * the text after the last `;` is a colour number 0..15, and 0..6 and 8 are dark.
 */
export function backgroundFromColorFgBg(value: string | undefined): Background | undefined {
	if (value === undefined) return undefined
	const last = value.split(';').pop() ?? ''
	if (!/^\d{1,2}$/.test(last)) return undefined
	const index = Number(last)
	if (index > 15) return undefined
	return index <= 6 || index === 8 ? 'dark' : 'light'
}

function channel(hex: string): number | undefined {
	if (!/^[0-9a-fA-F]{1,4}$/.test(hex)) return undefined
	return Number.parseInt(hex, 16) / (16 ** hex.length - 1)
}

/** The reply to the background query: `rgb:RRRR/GGGG/BBBB` (1 to 4 hex digits a channel) or `#rrggbb`. */
export function parseBackgroundReply(reply: string): Background | undefined {
	const rgb = /rgb:([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})/.exec(reply)
	let channels: (number | undefined)[] | undefined
	if (rgb) channels = [channel(rgb[1] ?? ''), channel(rgb[2] ?? ''), channel(rgb[3] ?? '')]
	else {
		const hash = /#([0-9a-fA-F]{6})(?![0-9a-fA-F])/.exec(reply)
		if (hash) {
			const digits = hash[1] ?? ''
			channels = [
				channel(digits.slice(0, 2)),
				channel(digits.slice(2, 4)),
				channel(digits.slice(4, 6)),
			]
		}
	}
	if (!channels) return undefined
	const [r, g, b] = channels
	if (r === undefined || g === undefined || b === undefined) return undefined
	return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5 ? 'light' : 'dark'
}

/** What a reply looks like once complete: ended by BEL or by ESC \. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the reply is made of escape and bell characters.
const COMPLETE_REPLY = /\u001b\]11;[^\u0007\u001b]*(?:\u0007|\u001b\\)/

export interface BackgroundQueryStreams {
	readonly input: {
		on(event: 'data', listener: (chunk: Buffer | string) => void): unknown
		off(event: 'data', listener: (chunk: Buffer | string) => void): unknown
		setRawMode?: (mode: boolean) => unknown
		isTTY?: boolean
		isRaw?: boolean
		pause?: () => unknown
		resume?: () => unknown
	}
	readonly output: { write(text: string): unknown; isTTY?: boolean }
}

/**
 * Ask the terminal and wait for its answer. `giveUp` resolves when the wait is
 * over (a timer in production); the answer wins whichever comes first. Nothing
 * is left listening afterwards, and raw mode is put back as it was.
 */
export function queryTerminalBackground(
	streams: BackgroundQueryStreams,
	giveUp: Promise<void>,
): Promise<Background | undefined> {
	const { input, output } = streams
	if (input.isTTY !== true || output.isTTY !== true) return Promise.resolve(undefined)
	return new Promise((resolve) => {
		const wasRaw = input.isRaw === true
		let buffer = ''
		let settled = false
		const finish = (result: Background | undefined): void => {
			if (settled) return
			settled = true
			input.off('data', onData)
			if (!wasRaw) input.setRawMode?.(false)
			input.pause?.()
			resolve(result)
		}
		const onData = (chunk: Buffer | string): void => {
			buffer += chunk.toString()
			const match = COMPLETE_REPLY.exec(buffer)
			if (match) finish(parseBackgroundReply(match[0]))
		}
		input.on('data', onData)
		if (!wasRaw) input.setRawMode?.(true)
		input.resume?.()
		output.write(BACKGROUND_QUERY)
		void giveUp.then(() => finish(undefined))
	})
}

/** The environment's answer: COLORFGBG, else dark. A live report, when there is one, comes first. */
export function detectBackground(
	reported: Background | undefined,
	env: NodeJS.ProcessEnv = process.env,
): Background {
	return reported ?? backgroundFromColorFgBg(env.COLORFGBG) ?? 'dark'
}
