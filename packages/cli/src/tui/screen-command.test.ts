import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readTerminalState, updateTerminalState } from '../terminal-setup/state.js'
import { CLI_VERSION } from '../version.js'
import { setScreenModeNow } from './fullscreen/mode.js'
import { terminalSetupText, tuiCommandText } from './screen-command.js'

let home: string
const env = () => ({ NAMZU_HOME: join(home, '.namzu') }) as NodeJS.ProcessEnv

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'namzu-tui-cmd-'))
})
afterEach(() => setScreenModeNow(undefined))

describe('/tui', () => {
	it('shows the screen in use and the usage', () => {
		setScreenModeNow({ fullscreen: true, autoOff: false, fromEnv: false })
		expect(tuiCommandText([], { home, env: env() })).toBe(
			'Namzu is using fullscreen.\nUsage: /tui <default|fullscreen>',
		)
	})

	it('says when a failed start turned fullscreen off', () => {
		updateTerminalState(
			(s) => ({ ...s, fullscreenAutoDisabled: { version: CLI_VERSION, at: 1, strikes: 2 } }),
			home,
		)
		const text = tuiCommandText([], { home, env: env() })
		expect(text).toContain(
			'Fullscreen was turned off on this machine after it repeatedly failed to start.',
		)
		expect(text).toContain('/tui fullscreen tries it again.')
	})

	it('saves the choice, forgets failed starts, and says to restart', () => {
		const text = tuiCommandText(['default'], { home, env: env() })
		expect(text).toContain('Saved. Namzu will use the normal screen the next time it starts')
		expect(readFileSync(join(home, '.namzu', 'config.yaml'), 'utf8')).toContain('fullscreen: false')
		expect(readTerminalState(home).fullscreenAutoDisabled).toBeUndefined()
	})

	it('names an environment variable that wins', () => {
		const text = tuiCommandText(['fullscreen'], { home, env: { ...env(), NAMZU_FULLSCREEN: '0' } })
		expect(text).toContain('NAMZU_FULLSCREEN is set in your environment and wins')
	})

	it('refuses a word it does not know', () => {
		expect(tuiCommandText(['wide'], { home, env: env() })).toBe(
			'Unknown screen mode "wide". Usage: /tui <default|fullscreen>',
		)
	})
})

describe('/terminal-setup', () => {
	it('explains a terminal it cannot set up and writes nothing', () => {
		expect(terminalSetupText({ env: { TERM: 'xterm' }, home })).toContain("can't run from")
	})
})
