import type { Presence, PresenceMark } from '../presence/presence.js'
import { NativeWinProcess, type NativeWinProcessOptions } from './process.js'

/**
 * The presence overlay drawn by the native helper: the agent's cursor and a
 * frame round the operated window, in two layered, click-through windows the
 * helper owns. It takes no input and never changes the foreground window.
 *
 * The overlay is not excluded from screen capture. A screenshot may show it,
 * and that is honest: the picture shows where the agent pointed. (The
 * PowerShell overlay this replaces hid itself from capture, which together
 * with a topmost transparent window reads as evasion.)
 *
 * A failure to show it never fails an action.
 */
export class NativePresence implements Presence {
	private readonly process: NativeWinProcess

	constructor(options: NativeWinProcessOptions) {
		this.process = new NativeWinProcess(options)
	}

	mark(mark: PresenceMark): void {
		void this.process
			.request(
				{
					op: 'presence.act',
					windowId: windowIdOf(mark.hwnd),
					kind: mark.kind,
					...(mark.at ? { at: { x: Math.round(mark.at.x), y: Math.round(mark.at.y) } } : {}),
				},
				4_000,
			)
			.catch(() => undefined)
	}

	warm(): void {
		this.process.warm()
	}

	hide(): void {
		// Only a helper that is running has anything to hide.
		if (this.process.isUp)
			void this.process.request({ op: 'presence.hide' }, 4_000).catch(() => undefined)
	}

	release(): void {
		this.process.release()
	}

	async dispose(): Promise<void> {
		await this.process.close()
	}
}

function windowIdOf(hwnd: number): string {
	return `w:${hwnd.toString(16).padStart(16, '0')}`
}
