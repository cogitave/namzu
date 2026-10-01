import { describe, expect, it } from 'vitest'
import { selectRendererPage } from './renderer-page.js'

const productionPage = 'file:///application/dist/renderer/index.html'
describe('privileged renderer page selection', () => {
	it('uses the built page unless the host explicitly selects development', () => {
		expect(selectRendererPage({ isPackaged: false, productionPage })).toBe(productionPage)
	})
	it('ignores development environment settings in packaged applications', () => {
		for (const developmentUrl of ['http://127.0.0.1:5173/', 'https://remote.invalid/', ''])
			expect(selectRendererPage({ isPackaged: true, productionPage, developmentUrl })).toBe(
				productionPage,
			)
	})
	it('admits canonical loopback root URLs for the exact IPC and navigation checks', () => {
		for (const developmentUrl of [
			'http://127.0.0.1:5173/',
			'http://localhost:5173',
			'http://[::1]:5173/',
			'http://127.0.0.1:80/',
		])
			expect(selectRendererPage({ isPackaged: false, productionPage, developmentUrl })).toBe(
				new URL(developmentUrl).href,
			)
	})
	it('refuses remote origins, credentials, other pages and alternate schemes', () => {
		for (const developmentUrl of [
			'',
			'not a URL',
			'https://127.0.0.1:5173/',
			'http://127.0.0.1/',
			'http://127.0.0.1:0/',
			'http://127.0.0.1:65536/',
			'http://127.0.0.2:5173/',
			'http://localhost.remote.invalid:5173/',
			'http://0.0.0.0:5173/',
			'http://192.168.1.10:5173/',
			'http://user:secret@127.0.0.1:5173/',
			'http://127.0.0.1:5173/preview',
			'http://127.0.0.1:5173/other.html',
			'http://127.0.0.1:5173/?preview=true',
			'http://127.0.0.1:5173/#preview',
			'file:///tmp/other.html',
			'data:text/html,<script>run()</script>',
		])
			expect(() =>
				selectRendererPage({ isPackaged: false, productionPage, developmentUrl }),
			).toThrow('HTTP loopback root page')
	})
})
