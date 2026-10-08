import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FolderAccessDialog, folderAccessCopy } from './folder-access-dialog.js'

describe('folderAccessCopy', () => {
	it('names the whole-drive risk and offers a way out', () => {
		const copy = folderAccessCopy('C:\\', 'drive')
		expect(copy.description).toContain('your whole drive')
		expect(copy.description).toContain('read every file under it and run commands there')
		expect(copy.description).toContain('Prefer a project folder')
		expect([copy.confirm, copy.cancel]).toEqual(['Allow anyway', 'Choose another folder'])
	})
	it('words each broad kind', () => {
		expect(folderAccessCopy('x', 'home').title).toContain('home folder')
		expect(folderAccessCopy('x', 'system').title).toContain('system folder')
	})
	it('keeps the ordinary review wording', () => {
		const copy = folderAccessCopy('fixture')
		expect(copy.title).toBe('Work in fixture?')
		expect([copy.confirm, copy.cancel]).toEqual(['Allow folder access', 'Cancel'])
	})
	it('asks "Trust this folder?" and names what was found when settings can run code', () => {
		const copy = folderAccessCopy('risky-app', undefined, [
			'hooks in .namzu/hooks',
			'2 MCP servers',
		])
		expect(copy.title).toBe('Trust this folder?')
		expect(copy.description).toContain('read, edit and run files in risky-app')
		expect(copy.description).toContain('even without a model request')
		expect(copy.items).toEqual(['hooks in .namzu/hooks', '2 MCP servers'])
		expect(copy.note).toContain('Continue only if you trust these files')
		expect([copy.confirm, copy.cancel]).toEqual(['Trust folder', 'Cancel'])
	})
	it('keeps the broad caution ahead of the settings wording', () => {
		expect(folderAccessCopy('x', 'drive', ['hooks']).title).toContain('whole drive')
	})
	it('treats an empty list as an ordinary folder', () => {
		expect(folderAccessCopy('x', undefined, []).title).toBe('Work in x?')
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
		expect(copy.description).toContain('changed since you last trusted it:')
		expect(copy.items).toEqual(['hooks changed', 'plugin a.js added'])
	})
})
