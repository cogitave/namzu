import type { WindowChrome } from '../shared/protocol.js'

/** What the menu shows for a shortcut Electron writes as `CmdOrCtrl+Shift+Z`. */
export function acceleratorLabel(accelerator: string, mac: boolean): string {
	const parts = accelerator.split('+')
	const key = parts.pop() ?? ''
	const names = mac
		? {
				cmdorctrl: '⌘',
				commandorcontrol: '⌘',
				command: '⌘',
				cmd: '⌘',
				ctrl: '⌃',
				control: '⌃',
				alt: '⌥',
				option: '⌥',
				shift: '⇧',
			}
		: {
				cmdorctrl: 'Ctrl',
				commandorcontrol: 'Ctrl',
				command: 'Ctrl',
				cmd: 'Ctrl',
				ctrl: 'Ctrl',
				control: 'Ctrl',
				alt: 'Alt',
				option: 'Alt',
				shift: 'Shift',
			}
	const mods = parts.map((part) => names[part.toLowerCase() as keyof typeof names] ?? part)
	const shown = key === 'Plus' ? '+' : key.length === 1 ? key.toUpperCase() : key
	if (!mac) return [...mods, shown].join('+')
	// The system's order: control, option, shift, command.
	const order = ['⌃', '⌥', '⇧', '⌘']
	mods.sort((a, b) => order.indexOf(a) - order.indexOf(b))
	return `${mods.join('')}${shown}`
}

/**
 * The platform before the main process has answered: enough to place the header's controls on the
 * first frame. The answer from the main process replaces it.
 */
export function guessChromePlatform(navigatorPlatform: string): WindowChrome['platform'] {
	if (/Mac/i.test(navigatorPlatform)) return 'darwin'
	if (/Win/i.test(navigatorPlatform)) return 'win32'
	if (/Linux|X11/i.test(navigatorPlatform)) return 'linux'
	return 'other'
}
