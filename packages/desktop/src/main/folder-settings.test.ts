import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findAutoRunSettings } from './folder-settings.js'

let folder: string
beforeEach(async () => {
	folder = await mkdtemp(join(tmpdir(), 'namzu-settings-'))
})
afterEach(async () => {
	await rm(folder, { recursive: true, force: true })
})
const config = (value: unknown) =>
	writeFile(
		join(folder, 'namzu.config.json'),
		typeof value === 'string' ? value : JSON.stringify(value),
	)

describe('findAutoRunSettings', () => {
	it('finds nothing in an ordinary folder', async () => {
		await writeFile(join(folder, 'README.md'), '# hi')
		expect(await findAutoRunSettings(folder)).toEqual([])
		expect(await findAutoRunSettings(join(folder, 'missing'))).toEqual([])
	})
	it('names hooks and counts MCP servers in the project config', async () => {
		await config({ hooks: { PreToolUse: [] }, mcpServers: { a: {}, b: {} }, model: 'x' })
		expect(await findAutoRunSettings(folder)).toEqual(['hooks', '2 MCP servers'])
	})
	it('says one server in the singular and skips empty sections', async () => {
		await config({ mcpServers: { a: {} }, hooks: {}, plugins: null })
		expect(await findAutoRunSettings(folder)).toEqual(['1 MCP server'])
	})
	it('ignores config sections that only choose a model', async () => {
		await config({ model: 'x', theme: 'dark' })
		expect(await findAutoRunSettings(folder)).toEqual([])
	})
	it('reports a config it cannot parse rather than passing it', async () => {
		await config('{ not json')
		expect(await findAutoRunSettings(folder)).toEqual(['namzu.config.json that could not be read'])
	})
	it('counts project plugins and commands', async () => {
		await mkdir(join(folder, '.namzu', 'plugins', 'one'), { recursive: true })
		await mkdir(join(folder, '.namzu', 'plugins', 'two'), { recursive: true })
		await mkdir(join(folder, '.namzu', 'commands'), { recursive: true })
		await writeFile(join(folder, '.namzu', 'commands', 'ship.md'), 'go')
		expect(await findAutoRunSettings(folder)).toEqual([
			'2 plugins in .namzu/plugins',
			'1 command in .namzu/commands',
		])
	})
	it('never follows a link, and counts one in a settings position as settings', async () => {
		const elsewhere = await mkdtemp(join(tmpdir(), 'namzu-elsewhere-'))
		try {
			await writeFile(join(elsewhere, 'a.md'), 'x')
			await writeFile(join(elsewhere, 'cfg.json'), '{"hooks":{}}')
			await mkdir(join(folder, '.namzu'), { recursive: true })
			await symlink(elsewhere, join(folder, '.namzu', 'commands'))
			await symlink(join(elsewhere, 'cfg.json'), join(folder, 'namzu.config.json'))
			expect(await findAutoRunSettings(folder)).toEqual([
				'namzu.config.json that is a link',
				'.namzu/commands that is a link',
			])
		} finally {
			await rm(elsewhere, { recursive: true, force: true })
		}
	})
	it('counts a linked .namzu folder as settings', async () => {
		const elsewhere = await mkdtemp(join(tmpdir(), 'namzu-elsewhere-'))
		try {
			await mkdir(join(elsewhere, 'plugins', 'one'), { recursive: true })
			await symlink(elsewhere, join(folder, '.namzu'))
			expect(await findAutoRunSettings(folder)).toEqual(['.namzu that is a link'])
		} finally {
			await rm(elsewhere, { recursive: true, force: true })
		}
	})
})
