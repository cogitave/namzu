import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FolderAccessDialog, folderAccessCopy } from './folder-access-dialog.js'

describe('folderAccessCopy', () => {
	it('names the whole-drive risk and offers a way out', () => {
		const copy = folderAccessCopy('C:\\', 'drive')
		expect(copy.description).toContain('your whole drive')
		expect(copy.description).toContain('read every file under it and run commands there')
		expect(copy.description).not.toContain('engine')
		expect(copy.description).toContain('Prefer a project folder')
		expect([copy.confirm, copy.cancel]).toEqual(['Allow anyway', 'Choose another folder'])
	})
	it('words each broad kind', () => {
		expect(folderAccessCopy('x', 'home').title).toContain('home folder')
		expect(folderAccessCopy('x', 'system').title).toContain('system folder')
	})
	it('keeps the ordinary review wording', () => {
		const copy = folderAccessCopy('fixture')
		expect(copy.title).toBe('Work in \u201cfixture\u201d?')
		expect([copy.confirm, copy.cancel]).toEqual(['Allow folder access', 'Cancel'])
	})
	it('asks "Trust this folder?" and names what was found when settings can run code', () => {
		const copy = folderAccessCopy(
			'risky-app',
			undefined,
			['a Namzu settings file that can start programs', '2 tools it can start (MCP servers)'],
			undefined,
			[{ label: '2 tools it can start (MCP servers)', lines: ['files: npx -y files-server'] }],
		)
		expect(copy.title).toBe('Trust this folder?')
		expect(copy.description).toContain('read, edit and run files in \u201crisky-app\u201d')
		expect(copy.description).toContain('start programs on their own')
		expect(copy.description).not.toMatch(/engine|model request/)
		expect(copy.items).toEqual([
			'a Namzu settings file that can start programs',
			'2 tools it can start (MCP servers)',
		])
		expect(copy.details).toEqual([
			{ label: '2 tools it can start (MCP servers)', lines: ['files: npx -y files-server'] },
		])
		expect([copy.confirm, copy.cancel]).toEqual(['Trust and open', 'Cancel'])
	})
	it('keeps the broad caution ahead of the settings wording', () => {
		expect(folderAccessCopy('x', 'drive', ['hooks']).title).toContain('whole drive')
	})
	it('treats an empty list as an ordinary folder', () => {
		expect(folderAccessCopy('x', undefined, []).title).toBe('Work in \u201cx\u201d?')
	})
})

describe('FolderAccessDialog', () => {
	it('renders as nothing outside a browser (portal) without throwing', () => {
		const html = renderToStaticMarkup(
			createElement(FolderAccessDialog, {
				name: 'fixture',
				path: 'C:\\work\\fixture',
				broad: 'drive',
				onConfirm: async () => undefined,
				onCancel: () => undefined,
				onClose: () => undefined,
				returnFocus: () => null,
			}),
		)
		expect(typeof html).toBe('string')
	})
})

describe('folderAccessCopy for changed settings', () => {
	it('names what changed since the folder was trusted', () => {
		const copy = folderAccessCopy('docs', undefined, undefined, [
			'hooks changed',
			'plugin a.js added',
		])
		expect(copy.title).toBe('Trust this folder?')
		expect(copy.description).toContain('\u201cdocs\u201d changed since you last trusted it')
		expect(copy.items).toEqual(['hooks changed', 'plugin a.js added'])
		expect(copy.confirm).toBe('Trust and open')
	})
})
