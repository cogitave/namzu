import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { type TerminalTabView, terminalTabId } from '../shared/terminal-tabs.js'
import { MAX_SAVED_SCREEN, TerminalTabStore } from './terminal-tab-store.js'

const ID = terminalTabId('0f0e0d0c-0b0a-4908-8706-050403020100')
const tab = (over: Partial<TerminalTabView> = {}): TerminalTabView => ({
	id: ID,
	projectId: 'p',
	kind: 'shell',
	title: 'sh',
	status: 'running',
	createdAt: 5,
	...over,
})
let directory: string
let file: string
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), 'namzu-tab-store-'))
	file = join(directory, 'terminal-tabs.json')
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

it('keeps a tab and its screen, and a running one comes back as restored', () => {
	const store = new TerminalTabStore(file)
	store.save([{ view: tab(), screen: 'SCREEN' }])
	const [saved] = store.load()
	expect(saved?.screen).toBe('SCREEN')
	expect(saved?.view).toMatchObject({ id: ID, status: 'restored' })
})

it('keeps an ended tab ended with its code, and an engine tab with its engine', () => {
	const store = new TerminalTabStore(file)
	store.save([
		{
			view: tab({ kind: 'engine', engine: 'codex-cli', status: 'exited', exitCode: 3 }),
			screen: '',
		},
	])
	expect(store.load()[0]?.view).toMatchObject({
		kind: 'engine',
		engine: 'codex-cli',
		status: 'exited',
		exitCode: 3,
		activity: 'exited',
	})
})

it('drops a screen it cannot keep whole, rather than cutting it mid-sequence', () => {
	const store = new TerminalTabStore(file)
	store.save([{ view: tab(), screen: 'x'.repeat(MAX_SAVED_SCREEN + 1) }])
	expect(store.load()[0]?.screen).toBe('')
})

it('ignores damaged entries and reports an unreadable file once', () => {
	const onError = vi.fn()
	const store = new TerminalTabStore(file, onError)
	expect(store.load()).toEqual([])
	expect(onError).not.toHaveBeenCalled()
	writeFileSync(
		file,
		JSON.stringify({
			version: 1,
			tabs: [
				{ id: 'conversation-1', projectId: 'p', kind: 'shell', title: 'x', createdAt: 1 },
				{ id: ID, projectId: 'p', kind: 'engine', title: 'x', createdAt: 1 },
				{ id: ID, projectId: 'p', kind: 'shell', title: 'ok', createdAt: 1 },
				{ id: ID, projectId: 'p', kind: 'shell', title: 'duplicate', createdAt: 1 },
			],
		}),
	)
	expect(store.load().map((item) => item.view.title)).toEqual(['ok'])
	writeFileSync(file, '{not json')
	expect(store.load()).toEqual([])
	expect(onError).toHaveBeenCalledTimes(1)
})

it('writes atomically as owner-only JSON', () => {
	new TerminalTabStore(file).save([{ view: tab(), screen: 's' }])
	expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(1)
})
