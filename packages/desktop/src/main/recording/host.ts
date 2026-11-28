import { randomUUID } from 'node:crypto'
import { type BrowserWindow, Menu, Tray, globalShortcut, nativeImage, screen } from 'electron'
import {
	type ChooserMicrophone,
	RECORDING_WORDS,
	type RecordingAvailability,
	type RecordingNotice,
} from '../../shared/recording-protocol.js'
import { LISTENING_LANGUAGE } from '../local-listening-assets.js'
import type { LocalListeningService } from '../local-listening.js'
import {
	type BeginResult,
	type DisplaySource,
	type ListeningState,
	RecordingController,
} from './controller.js'
import { redDot } from './pixels.js'
import { ContentProtection } from './protection.js'
import {
	electronDisplays,
	helperPath,
	isWsl,
	nativeWatchSource,
	realScheduler,
	thumbnailUrl,
} from './sources.js'
import { ScriptedWatch, paintedDisplay } from './test-hook.js'
import { PillWindow, showChooser } from './windows.js'

/**
 * Everything of a recording that needs the running application: the windows, the screen, the system
 * shortcut and tray, the listening models and the settings. It builds the controller from real parts
 * and watches the computer for a lock, a sleep or a display going away.
 */

export interface RecordingHostSettings {
	screenRecording: boolean
	screenRecordingVoice: boolean
	voiceInputAccepted: boolean
}

export interface RecordingHostDeps {
	settings: () => RecordingHostSettings
	saveSettings: (patch: Partial<Pick<RecordingHostSettings, 'screenRecordingVoice'>>) => void
	listening: LocalListeningService
	/** `only`: the id of the one window's contents that gets the notice; absent, every window does. */
	broadcast: (notice: RecordingNotice, only?: number) => void
	openSettings: () => void
	/** A test profile started with `NAMZU_RECORDING_FAKE=1`: painted screen, scripted controls. */
	fake?: boolean
	cliVersion?: string
}

/** The shortcut that ends a recording from anywhere. Ctrl+Shift+Esc is the system's own Task Manager. */
export const END_SHORTCUT = 'CommandOrControl+Alt+Shift+R'
const SHORTCUT_LABEL = process.platform === 'darwin' ? '⌘⌥⇧R' : 'Ctrl+Alt+Shift+R'
const TRAY_SIZE = 16

/** The language narration understands: the recognizer is configured for one, and says so. */
export function narrationLanguageName(code: string): string {
	const names: Record<string, string> = { tr: 'Turkish', en: 'English' }
	return names[code] ?? code
}

export class RecordingHost {
	readonly controller: RecordingController
	readonly protection = new ContentProtection()
	private readonly pill: PillWindow
	private parent: BrowserWindow | undefined
	/** The window that started the recording: the only one that opens the microphone. */
	private narrator: number | undefined
	private tray: Tray | undefined
	private shortcutOn = false
	private placed: Electron.Display | undefined

	constructor(private readonly deps: RecordingHostDeps) {
		this.pill = new PillWindow(
			this.protection,
			(action) => void this.controller.act(action),
			() => this.placed ?? screen.getDisplayNearestPoint(screen.getCursorScreenPoint()),
		)
		const fake = deps.fake === true
		this.controller = new RecordingController({
			platform: fake ? 'win32' : process.platform,
			env: fake ? {} : process.env,
			wsl: fake ? false : isWsl(),
			helperPresent: () => fake || helperPath() !== undefined,
			settings: () => {
				const settings = deps.settings()
				return {
					enabled: settings.screenRecording,
					voice: settings.screenRecordingVoice,
				}
			},
			saveSettings: (patch) => deps.saveSettings(patch),
			listening: () => this.listeningState(),
			displays: async (): Promise<DisplaySource[]> =>
				fake
					? [paintedDisplay(() => this.pill.place(screen.getPrimaryDisplay()))]
					: electronDisplays((display) => {
							this.placed = display
							this.pill.place(display)
						}),
			createWatch: () => {
				if (fake) return new ScriptedWatch()
				const path = helperPath()
				return path ? nativeWatchSource(path, deps.cliVersion) : undefined
			},
			chooser: (init) =>
				showChooser({
					parent: this.parent,
					init,
					protection: this.protection,
					clock: () => performance.now(),
				}),
			pill: this.pill,
			protection: this.protection,
			shortcut: () => SHORTCUT_LABEL,
			notify: (notice) => this.notify(notice),
			thumb: thumbnailUrl,
			clock: () => performance.now(),
			wall: () => Date.now(),
			scheduler: realScheduler,
			nextId: () => randomUUID(),
			openSettings: deps.openSettings,
		})
	}

	private async listeningState(): Promise<ListeningState> {
		const state = await this.deps.listening.state()
		if (state.installation !== 'ready')
			return { ready: false, missing: RECORDING_WORDS.listeningMissing }
		if (!this.deps.settings().voiceInputAccepted)
			return {
				ready: false,
				missing: 'Turn on voice input in Settings to use your voice.',
			}
		return {
			ready: true,
			language: narrationLanguageName(LISTENING_LANGUAGE),
			service: this.deps.listening,
		}
	}

	availability(): RecordingAvailability {
		return this.controller.availability()
	}

	/** A window that exists now or later: hidden from the pictures while a recording runs. */
	watchWindow(window: BrowserWindow): void {
		this.protection.add(window)
		window.once('closed', () => this.protection.remove(window))
	}

	begin(
		window: BrowserWindow | undefined,
		options: { provider: string; microphones?: ChooserMicrophone[]; microphone?: string },
	): Promise<BeginResult> {
		this.parent = window
		this.narrator = window && !window.isDestroyed() ? window.webContents.id : undefined
		return this.controller.begin(options)
	}

	private notify(notice: RecordingNotice): void {
		if (notice.type === 'state') this.onState(notice.recording)
		if (notice.type === 'narration') {
			// One window opens the microphone; a notice with no such window is dropped.
			if (this.narrator !== undefined) this.deps.broadcast(notice, this.narrator)
			return
		}
		this.deps.broadcast(notice)
	}

	/** Audio and a lost microphone are taken from the window that started the recording only. */
	isNarrator(window: BrowserWindow): boolean {
		return (
			this.narrator !== undefined &&
			!window.isDestroyed() &&
			window.webContents.id === this.narrator
		)
	}

	/** The shortcut and the tray exist only while a recording could be ended by them. */
	private onState(state: 'idle' | 'chooser' | 'running' | 'paused' | 'away' | 'review'): void {
		const recording = state === 'running' || state === 'paused' || state === 'away'
		if (recording) this.engage()
		else this.release()
	}

	private engage(): void {
		if (!this.shortcutOn) {
			try {
				this.shortcutOn = globalShortcut.register(END_SHORTCUT, () => void this.controller.endNow())
			} catch {
				this.shortcutOn = false
			}
			if (!this.shortcutOn)
				this.deps.broadcast({
					type: 'message',
					text: 'The end shortcut is taken by another program. Use Done on the pill or the tray icon.',
				})
		}
		if (!this.tray) {
			try {
				const icon = nativeImage.createFromBitmap(Buffer.from(redDot(TRAY_SIZE)), {
					width: TRAY_SIZE,
					height: TRAY_SIZE,
				})
				const tray = new Tray(icon)
				tray.setToolTip('Namzu is recording')
				tray.setContextMenu(
					this.menu([
						{ label: 'Done: stop and review', click: () => void this.controller.endNow() },
						{
							label: 'Pause or resume',
							click: () => {
								const state = this.controller.state
								void this.controller.act(
									state === 'paused' || state === 'away' ? 'resume' : 'pause',
								)
							},
						},
						{ label: 'Discard the recording', click: () => void this.controller.act('discard') },
					]),
				)
				this.tray = tray
			} catch {
				// A tray that cannot be drawn leaves the pill and the shortcut.
			}
		}
	}

	private menu(template: { label: string; click: () => void }[]): Electron.Menu {
		return Menu.buildFromTemplate(template)
	}

	private release(): void {
		if (this.shortcutOn) {
			globalShortcut.unregister(END_SHORTCUT)
			this.shortcutOn = false
		}
		this.tray?.destroy()
		this.tray = undefined
	}

	/** The computer locked or went to sleep. */
	away(reason: 'lock' | 'sleep'): void {
		this.controller.away(reason)
	}

	/** A display was unplugged. */
	displayRemoved(): void {
		this.controller.displayLost()
	}

	/** A recording that waits would be lost by quitting. */
	get holdsRecording(): boolean {
		return this.controller.holdsRecording
	}

	dispose(): void {
		this.release()
		this.pill.hide()
	}
}
