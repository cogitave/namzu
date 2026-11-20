import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { describeEditorMode, parseVimArgument, saveEditorMode } from './editor-mode.js'

describe('/vim arguments', () => {
	it('toggles with none, and names a mode with one word', () => {
		expect(parseVimArgument([])).toBe('toggle')
		expect(parseVimArgument(['on'])).toBe('vim')
		expect(parseVimArgument(['VIM'])).toBe('vim')
		expect(parseVimArgument(['off'])).toBe('normal')
		expect(parseVimArgument(['normal'])).toBe('normal')
	})

	it('refuses anything else', () => {
		expect(parseVimArgument(['maybe'])).toBeUndefined()
		expect(parseVimArgument(['on', 'off'])).toBeUndefined()
	})
})

describe('saving the editor mode', () => {
	it('writes tui.editorMode to the user config and says the new mode in one line', () => {
		const home = mkdtempSync(join(tmpdir(), 'namzu-home-'))
		const said = saveEditorMode('vim', { env: { NAMZU_HOME: home } })
		expect(said).toBe(describeEditorMode('vim'))
		expect(said.includes('\n')).toBe(false)
		expect(said).toMatch(/^Editor mode is vim/)
		const written = readFileSync(join(home, 'config.yaml'), 'utf8')
		expect(written).toMatch(/editorMode: vim/)
		expect(saveEditorMode('normal', { env: { NAMZU_HOME: home } })).toMatch(
			/^Editor mode is normal/,
		)
		expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toMatch(/editorMode: normal/)
	})

	it('says so when the file cannot be written, and that the mode lasts until Namzu closes', () => {
		const home = mkdtempSync(join(tmpdir(), 'namzu-home-'))
		writeFileSync(join(home, 'config.yaml'), 'a: [unclosed\n')
		const said = saveEditorMode('vim', { env: { NAMZU_HOME: home } })
		expect(said).toContain('Editor mode is vim')
		expect(said).toContain('until Namzu closes')
	})
})
