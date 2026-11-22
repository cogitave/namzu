import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

import { identifyTerminal } from './identify.js'
import { parseJsonc } from './jsonc.js'
import { type SetupWorld, runTerminalSetup } from './setup.js'
import { readTerminalState } from './state.js'

let home: string

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'namzu-term-setup-'))
})

const world = (env: Record<string, string>, platform = 'linux', extra: Partial<SetupWorld> = {}) =>
	({ env, platform, home, ...extra }) as SetupWorld

const backups = (dir: string): string[] =>
	existsSync(dir) ? readdirSync(dir).filter((f) => /\.[0-9a-f]{8}\.bak$/.test(f)) : []

describe('identifyTerminal', () => {
	it('tells the editors apart', () => {
		expect(identifyTerminal({ TERM_PROGRAM: 'vscode' })).toBe('vscode')
		expect(identifyTerminal({ TERM_PROGRAM: 'vscode', CURSOR_TRACE_ID: 'x' })).toBe('cursor')
		expect(
			identifyTerminal({
				TERM_PROGRAM: 'vscode',
				__CFBundleIdentifier: 'com.exafunction.windsurf',
			}),
		).toBe('windsurf')
		expect(identifyTerminal({ TERM_PROGRAM: 'Apple_Terminal' })).toBe('apple')
		expect(identifyTerminal({ TERM: 'alacritty' })).toBe('alacritty')
		expect(identifyTerminal({ WT_SESSION: 'a' })).toBe('windows-terminal')
		expect(identifyTerminal({})).toBe('other')
	})
})

describe('/terminal setup in an editor', () => {
	const dir = () => join(home, '.config', 'Code', 'User')

	it('adds the key, the scroll setting and the GPU setting, with a backup of what was there', () => {
		mkdirSync(dir(), { recursive: true })
		writeFileSync(
			join(dir(), 'keybindings.json'),
			'// mine\n[\n  { "key": "ctrl+k", "command": "x" }\n]\n',
		)
		writeFileSync(
			join(dir(), 'settings.json'),
			'{\n  // theme\n  "workbench.colorTheme": "Dark"\n}\n',
		)
		const text = runTerminalSetup(world({ TERM_PROGRAM: 'vscode' }))
		expect(text).toContain('Installed VS Code terminal Shift+Enter key binding')
		const keys = parseJsonc(readFileSync(join(dir(), 'keybindings.json'), 'utf8')) as {
			key: string
			args?: { text: string }
		}[]
		expect(keys).toHaveLength(2)
		expect(keys[1]).toMatchObject({ key: 'shift+enter', args: { text: '\u001b\r' } })
		expect(readFileSync(join(dir(), 'keybindings.json'), 'utf8')).toContain('// mine')
		const settings = parseJsonc(readFileSync(join(dir(), 'settings.json'), 'utf8')) as Record<
			string,
			unknown
		>
		expect(settings['terminal.integrated.mouseWheelScrollSensitivity']).toBe(3)
		expect(settings['terminal.integrated.gpuAcceleration']).toBe('off')
		expect(settings['workbench.colorTheme']).toBe('Dark')
		expect(backups(dir())).toHaveLength(2)
		expect(readFileSync(join(dir(), 'settings.json'), 'utf8')).toContain('// theme')
		expect(readTerminalState(home).shiftEnterInstalled).toBe(true)
	})

	it('creates the files when there are none, and says it is already done the second time', () => {
		runTerminalSetup(world({ TERM_PROGRAM: 'vscode' }))
		expect(backups(dir())).toHaveLength(0)
		const again = runTerminalSetup(world({ TERM_PROGRAM: 'vscode' }))
		expect(again).toContain('already configured')
		expect(parseJsonc(readFileSync(join(dir(), 'keybindings.json'), 'utf8'))).toHaveLength(1)
	})

	it('leaves a scroll value the person already set', () => {
		mkdirSync(dir(), { recursive: true })
		writeFileSync(
			join(dir(), 'settings.json'),
			'{"terminal.integrated.mouseWheelScrollSensitivity": 1}',
		)
		const text = runTerminalSetup(world({ TERM_PROGRAM: 'vscode' }))
		expect(text).toContain('already set; leaving it as it is')
		const settings = parseJsonc(readFileSync(join(dir(), 'settings.json'), 'utf8')) as Record<
			string,
			unknown
		>
		expect(settings['terminal.integrated.mouseWheelScrollSensitivity']).toBe(1)
	})

	it('writes nothing in a remote session and prints the steps', () => {
		const text = runTerminalSetup(
			world({ TERM_PROGRAM: 'vscode', VSCODE_GIT_ASKPASS_MAIN: '/home/u/.vscode-server/x' }),
		)
		expect(text).toContain("Can't install keybindings from a remote VS Code session")
		expect(text).toContain('"command": "workbench.action.terminal.sendSequence"')
		expect(existsSync(dir())).toBe(false)
		expect(readTerminalState(home).shiftEnterInstalled).toBeUndefined()
	})

	it('does not touch a keybindings file it cannot read', () => {
		mkdirSync(dir(), { recursive: true })
		writeFileSync(join(dir(), 'keybindings.json'), '{ not a list')
		const text = runTerminalSetup(world({ TERM_PROGRAM: 'vscode' }))
		expect(text).toContain('left unchanged')
		expect(readFileSync(join(dir(), 'keybindings.json'), 'utf8')).toBe('{ not a list')
		expect(readTerminalState(home).shiftEnterInstalled).toBeUndefined()
	})
})

describe('/terminal setup elsewhere', () => {
	it('appends the Alacritty binding once, with a backup', () => {
		const file = join(home, '.config', 'alacritty', 'alacritty.toml')
		mkdirSync(join(home, '.config', 'alacritty'), { recursive: true })
		writeFileSync(file, '[font]\nsize = 12\n')
		const text = runTerminalSetup(world({ TERM: 'alacritty' }))
		expect(text).toContain('Installed Alacritty Shift+Enter key binding')
		const written = readFileSync(file, 'utf8')
		expect(written).toContain('[font]')
		expect(written).toContain('mods = "Shift"')
		expect(backups(join(home, '.config', 'alacritty'))).toHaveLength(1)
		expect(runTerminalSetup(world({ TERM: 'alacritty' }))).toContain('already configured')
		expect(readFileSync(file, 'utf8')).toBe(written)
	})

	it('adds the Zed binding to its keymap', () => {
		const file = join(home, '.config', 'zed', 'keymap.json')
		mkdirSync(join(home, '.config', 'zed'), { recursive: true })
		writeFileSync(file, '// keys\n[]\n')
		expect(runTerminalSetup(world({ TERM_PROGRAM: 'zed' }))).toContain('Installed Zed')
		const keymap = parseJsonc(readFileSync(file, 'utf8')) as { context: string }[]
		expect(keymap).toHaveLength(1)
		expect(keymap[0]?.context).toBe('Terminal')
		expect(runTerminalSetup(world({ TERM_PROGRAM: 'zed' }))).toContain('already configured')
	})

	it('names a terminal that needs nothing, and writes nothing', () => {
		const text = runTerminalSetup(world({ TERM_PROGRAM: 'ghostty' }))
		expect(text).toBe(
			'Shift+Enter is natively supported in Ghostty.\nNo configuration needed. Just use Shift+Enter to add newlines.',
		)
		expect(readdirSync(home)).toEqual([])
	})

	it('says what tmux needs', () => {
		expect(runTerminalSetup(world({ TERM_PROGRAM: 'tmux' }))).toContain('set -s extended-keys on')
	})

	it('explains an unsupported terminal and changes nothing', () => {
		const text = runTerminalSetup(world({ TERM: 'xterm' }))
		expect(text).toContain("Terminal setup can't run from your current terminal.")
		expect(text).toContain('Other: Alacritty')
		expect(readdirSync(home)).toEqual([])
	})

	it('sets up Terminal.app through its own tools, backs up first and restores on failure', () => {
		const calls: string[] = []
		const ok = runTerminalSetup(
			world({ TERM_PROGRAM: 'Apple_Terminal' }, 'darwin', {
				run: (program, args) => {
					calls.push([program, ...args].join(' '))
					if (args[0] === '-c' && args[1]?.startsWith('Print ')) {
						return args[1].endsWith('useOptionAsMetaKey') ? 'true\n' : 'false\n'
					}
					return args[0] === 'read' ? 'Basic\n' : ''
				},
			}),
		)
		expect(calls[0]).toMatch(/^defaults export com\.apple\.Terminal .*\.[0-9a-f]{8}\.bak$/)
		expect(calls.some((c) => c.includes('useOptionAsMetaKey true'))).toBe(true)
		expect(ok).toContain('Turned on "Use Option as Meta key"')
		expect(readTerminalState(home).optionAsMetaInstalled).toBe(true)

		const calls2: string[] = []
		const failed = runTerminalSetup(
			world({ TERM_PROGRAM: 'Apple_Terminal' }, 'darwin', {
				stateHome: join(home, 'other'),
				run: (program, args) => {
					calls2.push([program, ...args].join(' '))
					if (program.includes('PlistBuddy')) throw new Error('no')
					return args[0] === 'read' ? 'Basic\n' : ''
				},
			}),
		)
		expect(failed).toContain('restored from the backup')
		const odd: string[] = []
		const refused = runTerminalSetup(
			world({ TERM_PROGRAM: 'Apple_Terminal' }, 'darwin', {
				stateHome: join(home, 'odd'),
				run: (program, args) => {
					odd.push([program, ...args].join(' '))
					return args[0] === 'read' ? 'My:Profile\n' : ''
				},
			}),
		)
		expect(refused).toContain('left unchanged')
		expect(odd.some((c) => c.includes('PlistBuddy'))).toBe(false)
		expect(readTerminalState(join(home, 'odd')).optionAsMetaInstalled).toBeUndefined()
		expect(calls2.some((c) => c.startsWith('defaults import'))).toBe(true)
		expect(readTerminalState(join(home, 'other')).optionAsMetaInstalled).toBeUndefined()
	})
})
