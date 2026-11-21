/**
 * The local settings file moves from `namzu.config.local.json` at the top of
 * the folder to `.namzu/settings.local.json`, and no saved answer is lost on
 * the way: the old file goes only after its bytes were written to the new
 * place, read back equal, and found unchanged, and only when git does not track
 * it. Every case in doubt keeps both files, and both are read.
 */

import { execFileSync, spawn } from 'node:child_process'
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { builtinCommandArguments } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { loadConfigWithProvenance, readPermissionLayers } from '../../config/load.js'
import { localConfigFiles } from '../../config/project-files.js'
import {
	LEGACY_LOCAL_CONFIG_FILE,
	LOCAL_SETTINGS_FILE,
	legacyLocalConfigPath,
	localSettingsPath,
	moveLegacyLocalConfig,
	removeStaleStagingFiles,
	settleLocalSettings,
	updateLocalSettings,
	writeLocalAllows,
} from '../local-settings.js'
import { createSessionAllows } from '../session-allow.js'

const OLD_TEXT = `{\n\t"permissions": {\n\t\t"bash": {\n\t\t\t"npm test *": "allow"\n\t\t}\n\t}\n}\n`

function project(): { root: string; cwd: string; home: string } {
	const root = mkdtempSync(join(tmpdir(), 'namzu-local-move-'))
	const cwd = join(root, 'work')
	const home = join(root, 'home')
	mkdirSync(cwd, { recursive: true })
	mkdirSync(home, { recursive: true })
	return { root, cwd, home }
}

function writeNew(cwd: string, text: string): void {
	mkdirSync(join(cwd, '.namzu'), { recursive: true })
	writeFileSync(localSettingsPath(cwd), text)
}

function permissionsRead(cwd: string, home: string) {
	return loadConfigWithProvenance({ cwd, home, env: {} }).config.permissions
}

const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' }
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: gitEnv })

describe('moving the earlier local file', () => {
	it('moves a folder that has only the old file, byte for byte, and reads the same answers', () => {
		const { cwd, home } = project()
		writeFileSync(legacyLocalConfigPath(cwd), OLD_TEXT)
		const before = permissionsRead(cwd, home)

		expect(moveLegacyLocalConfig(cwd)).toEqual({ state: 'moved' })

		expect(existsSync(legacyLocalConfigPath(cwd))).toBe(false)
		expect(readFileSync(localSettingsPath(cwd), 'utf8')).toBe(OLD_TEXT)
		expect(permissionsRead(cwd, home)).toEqual(before)
		expect(before).toEqual({ bash: { 'npm test *': 'allow' } })
		// Nothing is left beside it: no lock, no staging file.
		expect(readdirSync(join(cwd, '.namzu'))).toEqual(['settings.local.json'])
	})

	it('does nothing for a folder that has only the new file', () => {
		const { cwd } = project()
		writeNew(cwd, OLD_TEXT)
		expect(moveLegacyLocalConfig(cwd)).toEqual({ state: 'nothing' })
		expect(readFileSync(localSettingsPath(cwd), 'utf8')).toBe(OLD_TEXT)
	})

	it('removes the old file when the new one already holds the same settings', () => {
		const { cwd } = project()
		writeFileSync(legacyLocalConfigPath(cwd), OLD_TEXT)
		writeNew(cwd, JSON.stringify({ permissions: { bash: { 'npm test *': 'allow' } } }))
		expect(moveLegacyLocalConfig(cwd)).toEqual({ state: 'moved' })
		expect(existsSync(legacyLocalConfigPath(cwd))).toBe(false)
	})

	it('keeps both when both hold different settings, and reads both', () => {
		const { cwd, home } = project()
		writeFileSync(
			legacyLocalConfigPath(cwd),
			JSON.stringify({ permissions: { bash: { 'npm test *': 'allow', 'rm *': 'deny' } } }),
		)
		writeNew(cwd, JSON.stringify({ permissions: { bash: { 'git status *': 'allow' } } }))

		const move = moveLegacyLocalConfig(cwd)

		expect(move).toMatchObject({ state: 'kept', why: 'both' })
		expect(existsSync(legacyLocalConfigPath(cwd))).toBe(true)
		const layers = readPermissionLayers({ cwd, home, env: {} }).filter(
			(layer) => layer.source === 'local-file',
		)
		expect(layers.map((layer) => layer.path)).toEqual([
			legacyLocalConfigPath(cwd),
			localSettingsPath(cwd),
		])
		// The deny in the old file still holds, and the new file's allow applies.
		expect(layers[0]?.permissions).toEqual({ bash: { 'npm test *': 'allow', 'rm *': 'deny' } })
		expect(layers[1]?.permissions).toEqual({ bash: { 'git status *': 'allow' } })
	})

	it('leaves an old file that is not valid JSON alone, and writes no new one', () => {
		const { cwd } = project()
		writeFileSync(legacyLocalConfigPath(cwd), '{ "permissions": ')
		expect(moveLegacyLocalConfig(cwd)).toMatchObject({ state: 'kept', why: 'unreadable' })
		expect(readFileSync(legacyLocalConfigPath(cwd), 'utf8')).toBe('{ "permissions": ')
		expect(existsSync(localSettingsPath(cwd))).toBe(false)
	})

	it('leaves an old file git tracks where it is, says so, and saves new answers beside it', () => {
		const { cwd, home } = project()
		git(cwd, 'init', '-q')
		writeFileSync(legacyLocalConfigPath(cwd), OLD_TEXT)
		git(cwd, 'add', LEGACY_LOCAL_CONFIG_FILE)

		const move = moveLegacyLocalConfig(cwd)

		expect(move).toMatchObject({ state: 'kept', why: 'tracked' })
		expect(move.state === 'kept' && move.sentence).toMatch(/^Git tracks namzu\.config\.local\.json/)
		expect(readFileSync(legacyLocalConfigPath(cwd), 'utf8')).toBe(OLD_TEXT)
		expect(existsSync(localSettingsPath(cwd))).toBe(false)

		expect(writeLocalAllows(cwd, { bash: { 'git log *': 'allow' } }).error).toBeUndefined()
		expect(readFileSync(legacyLocalConfigPath(cwd), 'utf8')).toBe(OLD_TEXT)
		expect(JSON.parse(readFileSync(localSettingsPath(cwd), 'utf8'))).toEqual({
			permissions: { bash: { 'git log *': 'allow' } },
		})
		expect(permissionsRead(cwd, home)).toEqual({
			bash: { 'npm test *': 'allow', 'git log *': 'allow' },
		})
	})

	it('refuses a .namzu that is a link or a file, and keeps the old file', () => {
		const linked = project()
		writeFileSync(legacyLocalConfigPath(linked.cwd), OLD_TEXT)
		mkdirSync(join(linked.root, 'elsewhere'))
		symlinkSync(join(linked.root, 'elsewhere'), join(linked.cwd, '.namzu'))
		expect(moveLegacyLocalConfig(linked.cwd)).toMatchObject({ state: 'kept', why: 'failed' })
		expect(readdirSync(join(linked.root, 'elsewhere'))).toEqual([])
		expect(writeLocalAllows(linked.cwd, { bash: { 'ls *': 'allow' } }).error).toMatch(/is a link/)

		const file = project()
		writeFileSync(legacyLocalConfigPath(file.cwd), OLD_TEXT)
		writeFileSync(join(file.cwd, '.namzu'), 'not a folder')
		expect(moveLegacyLocalConfig(file.cwd)).toMatchObject({ state: 'kept', why: 'failed' })
		expect(writeLocalAllows(file.cwd, { bash: { 'ls *': 'allow' } }).error).toMatch(/is a file/)
		expect(readFileSync(legacyLocalConfigPath(file.cwd), 'utf8')).toBe(OLD_TEXT)
	})

	it('refuses to write through a settings file that is a link', () => {
		const { root, cwd } = project()
		mkdirSync(join(cwd, '.namzu'))
		writeFileSync(join(root, 'target.json'), '{}')
		symlinkSync(join(root, 'target.json'), localSettingsPath(cwd))
		expect(writeLocalAllows(cwd, { bash: { 'ls *': 'allow' } }).error).toMatch(/is a link/)
		expect(readFileSync(join(root, 'target.json'), 'utf8')).toBe('{}')
	})

	it('reads the old file once only when a move left both holding the same settings', () => {
		const { cwd } = project()
		writeFileSync(legacyLocalConfigPath(cwd), OLD_TEXT)
		writeNew(cwd, OLD_TEXT)
		expect(localConfigFiles(cwd).map((file) => file.name)).toEqual([LOCAL_SETTINGS_FILE])
	})
})

describe('the start of a session in a trusted folder', () => {
	it('moves the file and says nothing when nothing is in doubt', () => {
		const { cwd } = project()
		writeFileSync(legacyLocalConfigPath(cwd), OLD_TEXT)
		expect(settleLocalSettings(cwd)).toEqual([])
		expect(readFileSync(localSettingsPath(cwd), 'utf8')).toBe(OLD_TEXT)
	})

	it('says once why it kept both', () => {
		const { cwd } = project()
		writeFileSync(legacyLocalConfigPath(cwd), JSON.stringify({ quiet: true }))
		writeNew(cwd, JSON.stringify({ quiet: false }))
		const said = settleLocalSettings(cwd)
		expect(said).toHaveLength(1)
		expect(said[0]).toMatch(/Both namzu\.config\.local\.json and \.namzu\/settings\.local\.json/)
	})
})

describe('an untrusted folder', () => {
	it('keeps an answer for the session only and writes nothing', () => {
		const { cwd } = project()
		writeFileSync(legacyLocalConfigPath(cwd), OLD_TEXT)
		const store = createSessionAllows(builtinCommandArguments(), {
			cwd,
			trusted: () => false,
		})

		const said = store.add([{ kind: 'prefix', tool: 'bash', prefix: 'git commit' }])

		expect(said).toMatch(/not trusted/)
		expect(said).toMatch(/this conversation only/)
		expect(store.list()).toHaveLength(1)
		expect(readFileSync(legacyLocalConfigPath(cwd), 'utf8')).toBe(OLD_TEXT)
		expect(existsSync(join(cwd, '.namzu'))).toBe(false)
	})
})

describe('an answer that looks like it holds a secret', () => {
	it('is held for the session and not written; the rest of the answer is', () => {
		const { cwd } = project()
		const store = createSessionAllows(builtinCommandArguments(), {
			cwd,
			keepIgnored: async () => ({ state: 'not-a-repository' }),
		})

		const said = store.add([
			{ kind: 'command', tool: 'bash', command: 'curl -u admin:hunter2 https://example.com' },
			{ kind: 'prefix', tool: 'bash', prefix: 'git status' },
		])

		expect(said).toMatch(/password or a token/)
		expect(store.list()).toHaveLength(2)
		const saved = readFileSync(localSettingsPath(cwd), 'utf8')
		expect(saved).not.toContain('hunter2')
		expect(JSON.parse(saved)).toEqual({ permissions: { bash: { 'git status *': 'allow' } } })
	})

	it.each([
		'gh auth status',
		'npm test',
		'node --test tests/money.test.ts',
		'git push -u origin main',
		'docker run -p 8080:80 nginx',
	])('does not catch an ordinary command: %s', (command) => {
		const { cwd } = project()
		const store = createSessionAllows(builtinCommandArguments(), {
			cwd,
			keepIgnored: async () => ({ state: 'not-a-repository' }),
		})
		expect(store.add([{ kind: 'command', tool: 'bash', command }])).toBeUndefined()
	})

	it('is refused, with a sentence, when git tracks the local file', () => {
		const { cwd } = project()
		git(cwd, 'init', '-q')
		writeNew(cwd, '{}\n')
		git(cwd, 'add', '-f', LOCAL_SETTINGS_FILE)
		const store = createSessionAllows(builtinCommandArguments(), { cwd })

		const said = store.add([{ kind: 'prefix', tool: 'bash', prefix: 'git status' }])

		expect(said).toBe(
			'Git tracks .namzu/settings.local.json, so this was not saved there; it holds for this conversation only.',
		)
		expect(readFileSync(localSettingsPath(cwd), 'utf8')).toBe('{}\n')
	})
})

describe('the lock', () => {
	it('waits for nobody when another live process holds it, and changes nothing', () => {
		const { cwd } = project()
		writeNew(cwd, '{}\n')
		writeFileSync(
			`${localSettingsPath(cwd)}.lock`,
			JSON.stringify({ pid: process.ppid, at: new Date().toISOString() }),
		)
		const write = updateLocalSettings(cwd, () => ({ document: { quiet: true } }), { lockWaitMs: 0 })
		expect(write.error).toMatch(/another Namzu/)
		expect(readFileSync(localSettingsPath(cwd), 'utf8')).toBe('{}\n')
		expect(existsSync(`${localSettingsPath(cwd)}.lock`)).toBe(true)
	})

	it('takes over a lock left by a process that is gone, or one too old to be a write', () => {
		const { cwd } = project()
		writeNew(cwd, '{}\n')
		const lock = `${localSettingsPath(cwd)}.lock`
		writeFileSync(lock, JSON.stringify({ pid: 999_999_999, at: new Date().toISOString() }))
		expect(
			updateLocalSettings(cwd, () => ({ document: { quiet: true } }), { lockWaitMs: 0 }).error,
		).toBeUndefined()
		expect(existsSync(lock)).toBe(false)

		writeFileSync(lock, '')
		const minuteAgo = new Date(Date.now() - 60_000)
		utimesSync(lock, minuteAgo, minuteAgo)
		expect(
			updateLocalSettings(cwd, () => ({ document: { quiet: false } }), { lockWaitMs: 0 }).error,
		).toBeUndefined()
		expect(JSON.parse(readFileSync(localSettingsPath(cwd), 'utf8'))).toEqual({ quiet: false })
	})

	// Real subprocesses: each boots TypeScript through tsx, which is slow on a busy runner, so the
	// limit is raised. The outcome does not depend on speed: each writer waits for the lock as long
	// as it takes.
	it(
		'keeps every answer when two processes write and move at once',
		{ timeout: 120_000 },
		async () => {
			const { cwd } = project()
			writeFileSync(legacyLocalConfigPath(cwd), OLD_TEXT)
			const script = fileURLToPath(new URL('./__fixtures__/local-writer.ts', import.meta.url))
			const run = (name: string) =>
				new Promise<string>((resolve, reject) => {
					const child = spawn(process.execPath, ['--import', 'tsx', script, cwd, name, '12'], {
						env: { ...process.env },
						stdio: ['ignore', 'pipe', 'inherit'],
					})
					let out = ''
					child.stdout?.on('data', (chunk) => {
						out += chunk
					})
					child.on('error', reject)
					child.on('close', (code) =>
						code === 0 ? resolve(out) : reject(new Error(`writer ${name} exited ${code}`)),
					)
				})

			const results = await Promise.all([run('a'), run('b')])

			const moves = results.map((out) => JSON.parse(out).move.state).sort()
			expect(moves).toEqual(['moved', 'nothing'])
			expect(existsSync(legacyLocalConfigPath(cwd))).toBe(false)
			const saved = JSON.parse(readFileSync(localSettingsPath(cwd), 'utf8')) as {
				permissions: { bash: Record<string, string> }
			}
			const expected: Record<string, string> = { 'npm test *': 'allow' }
			for (const name of ['a', 'b'])
				for (let n = 0; n < 12; n += 1) expected[`echo ${name}${n} *`] = 'allow'
			expect(saved.permissions.bash).toEqual(expected)
			expect(readdirSync(join(cwd, '.namzu'))).toEqual(['settings.local.json'])
		},
	)
})

describe('staging files an earlier writer left', () => {
	it('are removed when their process is gone and they are old, and kept otherwise', () => {
		const { cwd } = project()
		writeNew(cwd, '{}\n')
		const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
		const gone = join(cwd, `${LEGACY_LOCAL_CONFIG_FILE}.999999999.tmp`)
		const goneNew = join(cwd, '.namzu', 'settings.local.json.999999999.abcdef.tmp')
		const fresh = join(cwd, `${LEGACY_LOCAL_CONFIG_FILE}.999999998.tmp`)
		const alive = join(cwd, `${LEGACY_LOCAL_CONFIG_FILE}.${process.ppid}.tmp`)
		for (const path of [gone, goneNew, fresh, alive]) writeFileSync(path, '{}')
		for (const path of [gone, goneNew, alive]) utimesSync(path, old, old)

		expect(removeStaleStagingFiles(cwd)).toBe(2)

		expect(existsSync(gone)).toBe(false)
		expect(existsSync(goneNew)).toBe(false)
		expect(existsSync(fresh)).toBe(true)
		expect(existsSync(alive)).toBe(true)
	})

	it('are kept when the settings file they were meant for is not readable', () => {
		const { cwd } = project()
		const gone = join(cwd, `${LEGACY_LOCAL_CONFIG_FILE}.999999999.tmp`)
		writeFileSync(gone, '{"permissions":{}}')
		const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
		utimesSync(gone, old, old)
		expect(removeStaleStagingFiles(cwd)).toBe(0)
		expect(existsSync(gone)).toBe(true)
	})
})
