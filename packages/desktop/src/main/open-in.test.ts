import { describe, expect, it, vi } from 'vitest'
import { OpenIn, type OpenInHost } from './open-in.js'

const host = (overrides: Partial<OpenInHost> & { files?: string[] } = {}) => {
	const files = new Set(overrides.files ?? [])
	const calls = {
		launch: vi.fn<OpenInHost['launch']>().mockResolvedValue(undefined),
		showItemInFolder: vi.fn<OpenInHost['showItemInFolder']>(),
		openPath: vi.fn<OpenInHost['openPath']>().mockResolvedValue(''),
	}
	const value: OpenInHost = {
		platform: 'win32',
		env: {},
		isFile: async (path) => files.has(path),
		...calls,
		...overrides,
	}
	return { value, calls }
}

const CODE = 'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe'
const CURSOR = 'C:\\Users\\me\\AppData\\Local\\Programs\\cursor\\Cursor.exe'
const WT = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe'
const env = { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', PATH: 'C:\\tools;D:\\bin' }

describe('editor detection', () => {
	it('finds the standard Windows installs in a fixed order', async () => {
		const { value } = host({ env, files: [CURSOR, CODE] })
		expect(await new OpenIn(value).editors()).toEqual([
			{ id: 'vscode', label: 'VS Code', executable: CODE },
			{ id: 'cursor', label: 'Cursor', executable: CURSOR },
		])
	})

	it('finds a system-wide install under Program Files', async () => {
		const code = 'C:\\Program Files\\Microsoft VS Code\\Code.exe'
		const cursor = 'C:\\Program Files\\cursor\\Cursor.exe'
		const { value } = host({ env: { ProgramFiles: 'C:\\Program Files' }, files: [cursor, code] })
		expect(await new OpenIn(value).editors()).toEqual([
			{ id: 'vscode', label: 'VS Code', executable: code },
			{ id: 'cursor', label: 'Cursor', executable: cursor },
		])
	})

	it('finds an editor on PATH', async () => {
		const { value } = host({ env, files: ['D:\\bin\\Cursor.exe'] })
		expect((await new OpenIn(value).editors()).map((editor) => editor.id)).toEqual(['cursor'])
	})

	it('finds code and cursor on PATH elsewhere', async () => {
		const { value } = host({
			platform: 'linux',
			env: { PATH: '/usr/bin:/opt/bin' },
			files: ['/opt/bin/code'],
		})
		expect(await new OpenIn(value).editors()).toEqual([
			{ id: 'vscode', label: 'VS Code', executable: '/opt/bin/code' },
		])
	})

	it('reports none when nothing is installed', async () => {
		const { value } = host({ env })
		expect(await new OpenIn(value).editors()).toEqual([])
	})
})

describe('opening', () => {
	it('opens a file at a line with separate argv entries', async () => {
		const { value, calls } = host({ env, files: [CODE] })
		await new OpenIn(value).open('C:\\p\\a b.ts', 'file', 'editor', 12)
		expect(calls.launch).toHaveBeenCalledWith(CODE, ['--goto', 'C:\\p\\a b.ts:12'])
	})

	it('keeps shell characters as plain argv text', async () => {
		const { value, calls } = host({ env, files: [CODE] })
		await new OpenIn(value).open('C:\\p\\a & calc.ts', 'file', 'editor')
		expect(calls.launch).toHaveBeenCalledWith(CODE, ['C:\\p\\a & calc.ts'])
	})

	it('ignores a line that is not a positive integer, and a line on a folder', async () => {
		const { value, calls } = host({ env, files: [CODE] })
		const openIn = new OpenIn(value)
		await openIn.open('/p/a.ts', 'file', 'editor', 0)
		await openIn.open('/p/a.ts', 'file', 'editor', 1.5)
		await openIn.open('/p/a.ts', 'file', 'editor', Number.NaN)
		await openIn.open('/p', 'directory', 'editor', 4)
		expect(calls.launch.mock.calls.map((call) => call[1])).toEqual([
			['/p/a.ts'],
			['/p/a.ts'],
			['/p/a.ts'],
			['/p'],
		])
	})

	it('says so when no editor exists', async () => {
		const { value, calls } = host({ env })
		await expect(new OpenIn(value).open('/p/a.ts', 'file', 'editor')).rejects.toThrow(/editor/)
		expect(calls.launch).not.toHaveBeenCalled()
	})

	it('reveals a file and opens a folder in the file manager', async () => {
		const { value, calls } = host()
		const openIn = new OpenIn(value)
		await openIn.open('/p/a.ts', 'file', 'file-manager')
		await openIn.open('/p', 'directory', 'file-manager')
		expect(calls.showItemInFolder).toHaveBeenCalledWith('/p/a.ts')
		expect(calls.openPath).toHaveBeenCalledWith('/p')
		calls.openPath.mockResolvedValueOnce('boom: /secret/path')
		const error = await openIn.open('/p', 'directory', 'file-manager').catch((e: Error) => e)
		expect((error as Error).message).not.toContain('secret')
	})

	it('opens Windows Terminal in the folder, or the file’s folder', async () => {
		const { value, calls } = host({ env, files: [WT] })
		const openIn = new OpenIn(value)
		await openIn.open('C:\\p', 'directory', 'terminal')
		await openIn.open('C:\\p\\src\\a.ts', 'file', 'terminal')
		expect(calls.launch.mock.calls).toEqual([
			[WT, ['-d', 'C:\\p']],
			[WT, ['-d', 'C:\\p\\src']],
		])
	})

	it('reports an unavailable terminal instead of falling back to a shell', async () => {
		const missing = host({ env })
		await expect(new OpenIn(missing.value).open('C:\\p', 'directory', 'terminal')).rejects.toThrow(
			/not found/,
		)
		const linux = host({ platform: 'linux', env: { PATH: '/usr/bin' }, files: ['/usr/bin/xterm'] })
		await expect(new OpenIn(linux.value).open('/p', 'directory', 'terminal')).rejects.toThrow(
			/not available/,
		)
		expect(missing.calls.launch).not.toHaveBeenCalled()
		expect(linux.calls.launch).not.toHaveBeenCalled()
	})

	it('refuses an unknown target', async () => {
		const { value } = host({ env, files: [CODE] })
		await expect(new OpenIn(value).open('/p', 'directory', 'shell' as never)).rejects.toThrow(
			/not supported/,
		)
	})
})
