import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
	EDITOR_TERMINALS,
	NATIVE_TERMINALS,
	TERMINAL_NAMES,
	type TerminalId,
	canSetUp,
	identifyTerminal,
	isRemoteEditorSession,
} from './identify.js'
import { addToObject, appendToArray, parseJsonc } from './jsonc.js'
import { updateTerminalState } from './state.js'

/**
 * `/terminal setup`: make Shift+Enter (or Option+Enter in Terminal.app) start a
 * new line in the terminal Namzu runs in. It runs only when the person types
 * the command. Every file it changes is copied to `<file>.<8 hex>.bak` first,
 * and the reply says what was changed and where. Where it cannot write (an
 * editor reached through a remote server, a file it cannot read as what it
 * expects) it prints the exact lines to add by hand and changes nothing.
 */

/** Runs a program and returns its output; throws when it fails. A seam for tests. */
export type RunProgram = (program: string, args: readonly string[]) => string

export interface SetupWorld {
	readonly env: Readonly<Record<string, string | undefined>>
	readonly platform: string
	/** The operating system's home folder, where editors keep their settings. */
	readonly home: string
	readonly run?: RunProgram
	/** The home folder `terminal-state.json` is kept under; defaults to `home`. */
	readonly stateHome?: string
}

/** The bytes a terminal sends for Alt+Enter, which Namzu reads as a new line. */
const NEWLINE_SEQUENCE = '\\u001b\\r'

const DEFAULT_LINE = 'No configuration needed. Just use Shift+Enter to add newlines.'

const defaultRun: RunProgram = (program, args) =>
	execFileSync(program, [...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

function backup(file: string): string | undefined {
	if (!existsSync(file)) return undefined
	const copy = `${file}.${randomBytes(4).toString('hex')}.bak`
	copyFileSync(file, copy)
	return copy
}

function writeWithBackup(file: string, text: string): void {
	backup(file)
	mkdirSync(dirname(file), { recursive: true })
	writeFileSync(file, text)
}

function editorDirName(id: TerminalId, userDirExists: (name: string) => boolean): string {
	if (id === 'vscode') return 'Code'
	if (id === 'cursor') return 'Cursor'
	return userDirExists('Devin') ? 'Devin' : 'Windsurf'
}

/** The folder an editor keeps `keybindings.json` and `settings.json` in. */
export function editorUserDir(id: TerminalId, world: SetupWorld): string {
	const base = (name: string): string =>
		world.platform === 'darwin'
			? join(world.home, 'Library', 'Application Support', name, 'User')
			: world.platform === 'win32'
				? join(world.env.APPDATA ?? join(world.home, 'AppData', 'Roaming'), name, 'User')
				: join(world.home, '.config', name, 'User')
	return base(editorDirName(id, (name) => existsSync(base(name))))
}

const keybindingEntry = `\t{\n\t\t"key": "shift+enter",\n\t\t"command": "workbench.action.terminal.sendSequence",\n\t\t"args": { "text": "${NEWLINE_SEQUENCE}" },\n\t\t"when": "terminalFocus"\n\t}`

function manualKeybinding(name: string): string[] {
	return [
		`Can't install keybindings from a remote ${name} session. To add the key yourself:`,
		'1. Open the Command Palette and run "Preferences: Open Keyboard Shortcuts (JSON)".',
		'2. Add this entry to the list:',
		keybindingEntry.replace(/^\t/gm, '    '),
		`3. Save the file, then press Shift+Enter in the ${name} terminal.`,
	]
}

function readTextOrUndefined(file: string): string | undefined {
	try {
		return readFileSync(file, 'utf8')
	} catch {
		return undefined
	}
}

function setUpEditorKey(id: TerminalId, world: SetupWorld): { lines: string[]; ok: boolean } {
	const name = TERMINAL_NAMES[id]
	if (isRemoteEditorSession(world.env)) return { lines: manualKeybinding(name), ok: false }
	const file = join(editorUserDir(id, world), 'keybindings.json')
	const existing = readTextOrUndefined(file)
	let list: unknown[] = []
	if (existing !== undefined && existing.trim().length > 0) {
		try {
			const parsed = parseJsonc(existing)
			if (!Array.isArray(parsed)) throw new Error('not a list')
			list = parsed
		} catch {
			return {
				lines: [
					`Your ${name} keybindings file isn't a readable list, so it was left unchanged: ${file}`,
					'To add the key yourself, add this entry to the list:',
					keybindingEntry.replace(/^\t/gm, '    '),
				],
				ok: false,
			}
		}
	}
	const same = list.find((entry) => {
		const e = entry as { key?: unknown; command?: unknown; when?: unknown } | null
		return (
			e?.key === 'shift+enter' &&
			e.command === 'workbench.action.terminal.sendSequence' &&
			e.when === 'terminalFocus'
		)
	}) as { args?: { text?: unknown } } | undefined
	if (same !== undefined) {
		const matches = same.args?.text === '\u001b\r'
		return matches
			? { lines: [`${name} terminal Shift+Enter key binding already configured`], ok: true }
			: {
					lines: [
						`${name} already has a Shift+Enter terminal binding with different arguments; leaving it as it is.`,
					],
					ok: false,
				}
	}
	const next =
		existing === undefined || existing.trim().length === 0
			? `[\n${keybindingEntry}\n]\n`
			: appendToArray(existing, keybindingEntry)
	if (next === '') {
		return {
			lines: [
				`Your ${name} keybindings file isn't a readable list, so it was left unchanged: ${file}`,
			],
			ok: false,
		}
	}
	try {
		writeWithBackup(file, next)
	} catch {
		return {
			lines: [`Couldn't install the ${name} terminal Shift+Enter key binding. File: ${file}`],
			ok: false,
		}
	}
	return {
		lines: [`Installed ${name} terminal Shift+Enter key binding`, `See ${file}`],
		ok: true,
	}
}

interface SettingChange {
	readonly key: string
	readonly value: unknown
	readonly shouldSet: (current: unknown) => boolean
	readonly done: string
	readonly kept: string
}

/** Apply settings to the editor's `settings.json` in one write, with one backup. */
function setEditorSettings(
	id: TerminalId,
	world: SetupWorld,
	changes: readonly SettingChange[],
): { lines: string[]; wrote: readonly SettingChange[] } {
	const name = TERMINAL_NAMES[id]
	const file = join(editorUserDir(id, world), 'settings.json')
	const fill = (text: string): string => text.replace('<Editor>', name)
	let text = readTextOrUndefined(file) ?? ''
	let parsed: unknown = {}
	if (text.trim().length > 0) {
		try {
			parsed = parseJsonc(text)
		} catch {
			return {
				lines: [`${name} settings.json isn't readable as JSON; not modifying it.`],
				wrote: [],
			}
		}
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
			return { lines: [`${name} settings.json isn't a JSON object; not modifying it.`], wrote: [] }
	} else text = '{\n}\n'
	const current = parsed as Record<string, unknown>
	const lines: string[] = []
	const wrote: SettingChange[] = []
	for (const change of changes) {
		if (!change.shouldSet(current[change.key])) {
			lines.push(fill(change.kept))
			continue
		}
		let next: string
		if (current[change.key] !== undefined) {
			// A value already there is replaced in place.
			const escaped = change.key.replace(/\./g, '\\.')
			const pattern = new RegExp(`("${escaped}"\\s*:\\s*)("(?:[^"\\\\]|\\\\.)*"|[^,}\\n]+)`)
			next = pattern.test(text) ? text.replace(pattern, `$1${JSON.stringify(change.value)}`) : ''
		} else
			next = addToObject(text, `\t${JSON.stringify(change.key)}: ${JSON.stringify(change.value)}`)
		if (next === '') {
			lines.push(`${name} settings.json couldn't be edited safely; not modifying ${change.key}.`)
			continue
		}
		text = next
		current[change.key] = change.value
		wrote.push(change)
	}
	if (wrote.length === 0) return { lines, wrote }
	try {
		writeWithBackup(file, text)
	} catch {
		return { lines: [`Couldn't update ${name} settings. File: ${file}`], wrote: [] }
	}
	return { lines: [...wrote.map((c) => fill(c.done)), ...lines], wrote }
}

function setUpEditor(id: TerminalId, world: SetupWorld): { lines: string[]; ok: boolean } {
	const name = TERMINAL_NAMES[id]
	const key = setUpEditorKey(id, world)
	const lines = [...key.lines]
	if (isRemoteEditorSession(world.env)) {
		lines.push(
			'',
			`For faster scrolling, set "terminal.integrated.mouseWheelScrollSensitivity": 3 in ${name} settings.`,
			`To fix garbled text, set "terminal.integrated.gpuAcceleration": "off" in ${name} settings (undo: set it back to "auto").`,
		)
		return { lines, ok: key.ok }
	}
	const settings = setEditorSettings(id, world, [
		{
			key: 'terminal.integrated.mouseWheelScrollSensitivity',
			value: 3,
			shouldSet: (current) => current === undefined,
			done: 'Set <Editor> terminal scroll sensitivity to 3',
			kept: '<Editor> terminal.integrated.mouseWheelScrollSensitivity already set; leaving it as it is',
		},
		{
			key: 'terminal.integrated.gpuAcceleration',
			value: 'off',
			shouldSet: (current) => current !== 'off',
			done: 'Turned off <Editor> GPU acceleration to fix garbled text',
			kept: '<Editor> GPU acceleration is already off',
		},
	])
	lines.push(...settings.lines)
	if (settings.wrote.some((c) => c.key === 'terminal.integrated.gpuAcceleration'))
		lines.push(
			`Reload the ${name} window to apply. Undo: set "terminal.integrated.gpuAcceleration" back to "auto".`,
		)
	return { lines, ok: key.ok }
}

const ALACRITTY_BLOCK = `[[keyboard.bindings]]\nkey = "Return"\nmods = "Shift"\nchars = "\\u001B\\r"\n`

function alacrittyPath(world: SetupWorld): string {
	const xdg = world.env.XDG_CONFIG_HOME
	if (world.platform === 'win32' && world.env.APPDATA)
		return join(world.env.APPDATA, 'alacritty', 'alacritty.toml')
	return join(xdg && xdg !== '' ? xdg : join(world.home, '.config'), 'alacritty', 'alacritty.toml')
}

function setUpAlacritty(world: SetupWorld): { lines: string[]; ok: boolean } {
	const file = alacrittyPath(world)
	const existing = readTextOrUndefined(file) ?? ''
	if (existing.includes('mods = "Shift"') && existing.includes('key = "Return"'))
		return { lines: ['Alacritty Shift+Enter key binding already configured'], ok: true }
	const next = `${existing}${existing === '' || existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n'}${ALACRITTY_BLOCK}`
	try {
		writeWithBackup(file, next)
	} catch {
		return {
			lines: [
				"Couldn't install the Alacritty Shift+Enter key binding. To add it yourself, put this in alacritty.toml:",
				ALACRITTY_BLOCK,
			],
			ok: false,
		}
	}
	return {
		lines: [
			'Installed Alacritty Shift+Enter key binding',
			`See ${file}`,
			"Restart Alacritty if Shift+Enter doesn't work yet",
		],
		ok: true,
	}
}

const ZED_ENTRY = {
	context: 'Terminal',
	bindings: { 'shift-enter': ['terminal::SendText', '\u001b\r'] },
}

function zedPath(world: SetupWorld): string {
	const xdg = world.env.XDG_CONFIG_HOME
	return join(xdg && xdg !== '' ? xdg : join(world.home, '.config'), 'zed', 'keymap.json')
}

function setUpZed(world: SetupWorld): { lines: string[]; ok: boolean } {
	const file = zedPath(world)
	const manual = [
		`To add the binding yourself, add this block to the keymap array in ${file}:`,
		'    { "context": "Terminal", "bindings": { "shift-enter": ["terminal::SendText", "\\u001b\\r"] } }',
	]
	const existing = readTextOrUndefined(file)
	let list: unknown[] = []
	if (existing !== undefined && existing.trim().length > 0) {
		let parsed: unknown
		try {
			parsed = parseJsonc(existing)
		} catch {
			return {
				lines: ["Couldn't read your Zed keymap, so it was left unchanged.", ...manual],
				ok: false,
			}
		}
		if (!Array.isArray(parsed))
			return {
				lines: [
					"Your Zed keymap isn't a readable list of keybindings, so it was left unchanged.",
					...manual,
				],
				ok: false,
			}
		list = parsed
	}
	for (const entry of list) {
		const e = entry as { context?: unknown; bindings?: Record<string, unknown> } | null
		const bound = e?.context === 'Terminal' ? e.bindings?.['shift-enter'] : undefined
		if (bound === undefined) continue
		return JSON.stringify(bound) === JSON.stringify(ZED_ENTRY.bindings['shift-enter'])
			? { lines: ['Zed Shift+Enter key binding already configured'], ok: true }
			: {
					lines: ['Zed already has a Shift+Enter binding in the terminal; leaving it as it is.'],
					ok: false,
				}
	}
	const item = `\t${JSON.stringify(ZED_ENTRY)}`
	const next =
		existing === undefined || existing.trim().length === 0
			? `[\n${item}\n]\n`
			: appendToArray(existing, item)
	if (next === '')
		return {
			lines: ["Couldn't update your Zed keymap, so it was left unchanged.", ...manual],
			ok: false,
		}
	try {
		writeWithBackup(file, next)
	} catch {
		return {
			lines: ["Couldn't update your Zed keymap, so it was left unchanged.", ...manual],
			ok: false,
		}
	}
	return { lines: ['Installed Zed Shift+Enter key binding', `See ${file}`], ok: true }
}

const OPTION_WARNING =
	'With it on, the Option key no longer types characters such as é, or on some keyboard layouts @, |, [, ], {, } and backslash. To undo it, uncheck "Use Option as Meta key" in Terminal > Settings > Profiles > Keyboard, for your default and startup profiles.'

function setUpAppleTerminal(world: SetupWorld): { lines: string[]; ok: boolean } {
	const run = world.run ?? defaultRun
	const plist = join(world.home, 'Library', 'Preferences', 'com.apple.Terminal.plist')
	const saved = `${plist}.${randomBytes(4).toString('hex')}.bak`
	const restore = (): string =>
		(() => {
			try {
				run('defaults', ['import', 'com.apple.Terminal', saved])
				return 'Your settings have been restored from the backup.'
			} catch {
				return `Couldn't restore from the backup. To restore it yourself, run: defaults import com.apple.Terminal ${saved}`
			}
		})()
	try {
		run('defaults', ['export', 'com.apple.Terminal', saved])
	} catch {
		return {
			lines: [
				"Couldn't back up your Terminal.app settings, so they weren't changed.",
				`Backup path: ${saved}`,
			],
			ok: false,
		}
	}
	try {
		const profiles = new Set<string>()
		for (const key of ['Default Window Settings', 'Startup Window Settings']) {
			const name = run('defaults', ['read', 'com.apple.Terminal', key]).trim()
			if (name !== '') profiles.add(name)
		}
		for (const profile of profiles) {
			if (/[:\\]/.test(profile)) {
				run('defaults', ['import', 'com.apple.Terminal', saved])
				return {
					lines: [
						`Your Terminal.app profile "${profile}" has a ":" or a backslash in its name, so its settings were left unchanged.`,
						'To set it up yourself, open Terminal > Settings > Profiles > Keyboard and check "Use Option as Meta key".',
					],
					ok: false,
				}
			}
			for (const [setting, value] of [
				['useOptionAsMetaKey', 'true'],
				['Bell', 'false'],
			] as const) {
				const path = `:'Window Settings':'${profile.replace(/'/g, "\\'")}':${setting}`
				try {
					run('/usr/libexec/PlistBuddy', ['-c', `Set ${path} ${value}`, plist])
				} catch {
					run('/usr/libexec/PlistBuddy', ['-c', `Add ${path} bool ${value}`, plist])
				}
				const back = run('/usr/libexec/PlistBuddy', ['-c', `Print ${path}`, plist]).trim()
				if (back !== value) throw new Error('the written value did not read back')
			}
		}
		try {
			run('killall', ['cfprefsd'])
		} catch {
			// the preferences daemon restarts on its own; nothing to report
		}
	} catch {
		return {
			lines: ["Couldn't change your Terminal.app settings.", restore()],
			ok: false,
		}
	}
	return {
		lines: [
			'Configured Terminal.app settings:',
			'- Turned on "Use Option as Meta key"',
			OPTION_WARNING,
			'- Turned off the audible bell',
			'Option+Enter will now enter a newline.',
			`Backup: ${saved}`,
			'Restart Terminal.app to apply the changes.',
		],
		ok: true,
	}
}

const TMUX_LINES = [
	'Inside tmux, Shift+Enter also needs these lines in ~/.tmux.conf:',
	'  set -s extended-keys on',
	"  set -as terminal-features 'xterm*:extkeys'",
	'Then run tmux source-file ~/.tmux.conf, detach and reattach, and restart Namzu.',
]

export function unsupportedTerminalText(id: TerminalId, platform: string): string {
	return [
		`Terminal setup can't run from ${TERMINAL_NAMES[id]}.`,
		'This command sets up Shift+Enter for multi-line messages.',
		...(platform === 'darwin' ? ['macOS: Terminal.app'] : []),
		'IDE: VS Code, Cursor, Windsurf, Zed',
		'Other: Alacritty',
		'iTerm2, WezTerm, Ghostty, Kitty, Warp and Windows Terminal support Shift+Enter natively.',
		'In any terminal, Alt+Enter and Ctrl+J also start a new line.',
	].join('\n')
}

/** What `/terminal setup` does and says. Changes files only for a terminal it knows how to set up. */
export function runTerminalSetup(world: SetupWorld): string {
	const id = identifyTerminal(world.env)
	if (id === 'tmux') return [...TMUX_LINES, '', DEFAULT_LINE].join('\n')
	if (id === 'windows-terminal')
		return [
			'Shift+Enter is natively supported in Windows Terminal 1.25 or later.',
			'On an older version, press Alt+Enter or Ctrl+J to add a newline, or update Windows Terminal (Windows Terminal Preview if no update reaches 1.25).',
		].join('\n')
	if (NATIVE_TERMINALS.includes(id))
		return [`Shift+Enter is natively supported in ${TERMINAL_NAMES[id]}.`, DEFAULT_LINE].join('\n')
	if (!canSetUp(id, world.platform)) return unsupportedTerminalText(id, world.platform)

	const done: { lines: string[]; ok: boolean } = EDITOR_TERMINALS.includes(id)
		? setUpEditor(id, world)
		: id === 'alacritty'
			? setUpAlacritty(world)
			: id === 'zed'
				? setUpZed(world)
				: setUpAppleTerminal(world)
	if (done.ok)
		updateTerminalState(
			(state) =>
				id === 'apple'
					? { ...state, optionAsMetaInstalled: true }
					: { ...state, shiftEnterInstalled: true },
			world.stateHome ?? world.home,
		)
	return done.lines.join('\n')
}
