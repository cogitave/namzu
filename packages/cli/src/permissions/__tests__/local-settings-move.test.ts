/**
 * The local settings file moves from `namzu.config.local.json` at the top of
 * the folder to `.namzu/settings.local.json`, and no saved answer is lost on
 * the way: the old file goes only after its bytes were written to the new
 * place, read back equal, found unchanged, and kept once more in the Namzu
 * home, and only when git does not track it. Every case in doubt keeps both
 * files, and both are read.
 */

import { execFileSync, spawn } from 'node:child_process'
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { builtinCommandArguments } from '@namzu/sdk'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { loadConfigWithProvenance, readPermissionLayers } from '../../config/load.js'
import { localConfigFiles } from '../../config/project-files.js'
import {
	LEGACY_LOCAL_CONFIG_FILE,
	LOCAL_SETTINGS_FILE,
	ignoreSentence,
	legacyLocalConfigPath,
	localSettingsBackupDir,
	localSettingsPath,
	moveLegacyLocalConfig,
	removeStaleStagingFiles,
	settleLocalSettings,
	updateLocalSettings,
	writeLocalAllows,
} from '../local-settings.js'
import { createSessionAllows } from '../session-allow.js'

const OLD_TEXT = `{\n\t"permissions": {\n\t\t"bash": {\n\t\t\t"npm test *": "allow"\n\t\t}\n\t}\n}\n`

const roots: string[] = []
afterEach(() => {
	for (const root of roots.splice(0)) removeTempDir(root)
})

function project(): { root: string; cwd: string; home: string } {
	const root = mkdtempSync(join(tmpdir(), 'namzu-local-move-'))
	roots.push(root)
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

/** The copies the moves of `cwd` kept in the Namzu home. */
function backups(cwd: string): string[] {
	const dir = localSettingsBackupDir(cwd)
	return existsSync(dir) ? readdirSync(dir).map((name) => join(dir, name)) : []
}

describe('moving the earlier local file', () => {
	it('moves a folder that has only the old file, byte for byte, and reads the same answers', () => {
		const { cwd, home } = project()
		writeFileSync(legacyLocalConfigPath(cwd), OLD_TEXT)
		const before = permissionsRead(cwd, home)

		const move = moveLegacyLocalConfig(cwd)

		expect(move.state).toBe('moved')
		expect(existsSync(legacyLocalConfigPath(cwd))).toBe(false)
		expect(readFileSync(localSettingsPath(cwd), 'utf8')).toBe(OLD_TEXT)
		expect(permissionsRead(cwd, home)).toEqual(before)
		expect(before).toEqual({ bash: { 'npm test *': 'allow' } })
		// Nothing is left beside it: no lock, no staging file, no step-aside file.
		expect(readdirSync(join(cwd, '.namzu'))).toEqual(['settings.local.json'])
		expect(readdirSync(cwd)).toEqual(['.namzu'])
		// The old file's bytes are kept once more, in the Namzu home, private.
		const kept = backups(cwd)
		expect(kept).toHaveLength(1)
		expect(move.state === 'moved' && move.backup).toBe(kept[0])
		expect(kept[0]).toMatch(/[\\/]namzu\.config\.local\.json\.backup\.\d+$/)
		expect(readFileSync(kept[0] as string, 'utf8')).toBe(OLD_TEXT)
		if (process.platform !== 'win32') expect(statSync(kept[0] as string).mode & 0o777).toBe(0o600)
	})

	it('copies bytes that are not UTF-8 as they are, and keeps the same bytes', () => {
		const { cwd } = project()
		// 0xFE is a letter on a Windows code page; read as UTF-8 it would become U+FFFD.
		const bytes = Buffer.concat([
			Buffer.from('{"hooks":{"session_start":[{"command":"echo '),
			Buffer.from([0xfe]),
			Buffer.from('"}]}}\n'),
		])
		writeFileSync(legacyLocalConfigPath(cwd), bytes)

		expect(moveLegacyLocalConfig(cwd).state).toBe('moved')

		expect(readFileSync(localSettingsPath(cwd)).equals(bytes)).toBe(true)
		expect(readFileSync(backups(cwd)[0] as string).equals(bytes)).toBe(true)
	})

	it('neither removes nor rewrites a file that is not UTF-8 when the new one reads the same', () => {
		const { cwd } = project()
		const bytes = Buffer.concat([Buffer.from('{"theme":"'), Buffer.from([0xfe]), Buffer.from('"}')])
		writeFileSync(legacyLocalConfigPath(cwd), bytes)
		// The same settings as the old file reads, U+FFFD where its byte was.
		writeNew(cwd, `${JSON.stringify({ theme: '\ufffd' })}\n`)

		expect(moveLegacyLocalConfig(cwd)).toMatchObject({ state: 'kept', why: 'unreadable' })
		expect(readFileSync(legacyLocalConfigPath(cwd)).equals(bytes)).toBe(true)

		const write = updateLocalSettings(cwd, (document) => ({ document }), { target: 'legacy' })
		expect(write.error).toMatch(/not UTF-8 text/)
		expect(readFileSync(legacyLocalConfigPath(cwd)).equals(bytes)).toBe(true)
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
		expect(moveLegacyLocalConfig(cwd).state).toBe('moved')
		expect(existsSync(legacyLocalConfigPath(cwd))).toBe(false)
		expect(readFileSync(backups(cwd)[0] as string, 'utf8')).toBe(OLD_TEXT)
	})

	it('puts the old file back when its backup cannot be written, and reads the two once', () => {
		const { root, cwd } = project()
		writeFileSync(legacyLocalConfigPath(cwd), OLD_TEXT)
		const home = process.env.NAMZU_HOME
		// A Namzu home that is a file: no folder can be made under it.
		process.env.NAMZU_HOME = join(root, 'home-is-a-file')
		writeFileSync(process.env.NAMZU_HOME, '')
		try {
			const move = moveLegacyLocalConfig(cwd)
			expect(move).toMatchObject({ state: 'kept', why: 'failed' })
			expect(move.state === 'kept' && move.sentence).toMatch(/backup could not be written/)
		} finally {
			process.env.NAMZU_HOME = home
		}
		expect(readFileSync(legacyLocalConfigPath(cwd), 'utf8')).toBe(OLD_TEXT)
		expect(readFileSync(localSettingsPath(cwd), 'utf8')).toBe(OLD_TEXT)
		expect(localConfigFiles(cwd).map((file) => file.name)).toEqual([LOCAL_SETTINGS_FILE])
		expect(readdirSync(cwd).sort()).toEqual(['.namzu', LEGACY_LOCAL_CONFIG_FILE])

		// The next start finds both holding the same settings, and finishes the move.
		expect(moveLegacyLocalConfig(cwd).state).toBe('moved')
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
		// Not even an empty .namzu is left in the project.
		expect(existsSync(join(cwd, '.namzu'))).toBe(false)
	})

	it('makes no .namzu to edit the old file alone, and leaves none behind', () => {
		const { cwd } = project()
		writeFileSync(legacyLocalConfigPath(cwd), OLD_TEXT)
		const write = updateLocalSettings(cwd, () => ({ document: { quiet: true } }), {
			target: 'legacy',
		})
		expect(write.error).toBeUndefined()
		expect(JSON.parse(readFileSync(legacyLocalConfigPath(cwd), 'utf8'))).toEqual({ quiet: true })
		expect(existsSync(join(cwd, '.namzu'))).toBe(false)
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
	it('moves the file and says nothing when nothing is in doubt', async () => {
		const { cwd } = project()
		writeFileSync(legacyLocalConfigPath(cwd), OLD_TEXT)
		const settled = settleLocalSettings(cwd)
		expect(settled.said).toEqual([])
		// Not a git work tree: there is nothing for git to ignore, and nothing to say.
		expect(await settled.ignore).toEqual([])
		expect(readFileSync(localSettingsPath(cwd), 'utf8')).toBe(OLD_TEXT)
	})

	it('says why it kept both once, and again only when the old file changes', () => {
		const { cwd } = project()
		writeFileSync(legacyLocalConfigPath(cwd), JSON.stringify({ quiet: true }))
		writeNew(cwd, JSON.stringify({ quiet: false }))
		const said = settleLocalSettings(cwd).said
		expect(said).toHaveLength(1)
		expect(said[0]).toMatch(/Both namzu\.config\.local\.json and \.namzu\/settings\.local\.json/)

		expect(settleLocalSettings(cwd).said).toEqual([])
		// A new answer in the new file is not news: the old file is what the sentence is about.
		writeNew(cwd, JSON.stringify({ quiet: false, theme: 'dark' }))
		expect(settleLocalSettings(cwd).said).toEqual([])

		writeFileSync(legacyLocalConfigPath(cwd), JSON.stringify({ quiet: true, theme: 'light' }))
		expect(settleLocalSettings(cwd).said).toHaveLength(1)
	})

	it('names what to do when git would take the local file along', () => {
		expect(ignoreSentence({ state: 'ignored', written: true })).toBeUndefined()
		expect(ignoreSentence({ state: 'not-a-repository' })).toBeUndefined()
		expect(ignoreSentence({ state: 'tracked', reason: 'x' })).toMatch(
			/^Git tracks \.namzu\/settings\.local\.json.*git rm --cached \.namzu\/settings\.local\.json\.$/,
		)
		expect(ignoreSentence({ state: 'not-read', reason: 'x' })).toMatch(
			/^Git does not ignore \.namzu\/settings\.local\.json although/,
		)
		expect(ignoreSentence({ state: 'failed', reason: 'EACCES' })).toMatch(
			/could not make git ignore .*\(EACCES\).*global git ignore file\.$/,
		)
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

	it('does not take over the lock of a running process that is only slow', () => {
		const { cwd } = project()
		writeNew(cwd, '{}\n')
		const lock = `${localSettingsPath(cwd)}.lock`
		writeFileSync(lock, JSON.stringify({ pid: process.ppid, host: hostname(), at: 'x' }))
		// Eleven seconds: past the limit for a lock nobody can vouch for, far inside a live one's.
		const paused = new Date(Date.now() - 11_000)
		utimesSync(lock, paused, paused)
		const write = updateLocalSettings(cwd, () => ({ document: { quiet: true } }), {
			lockWaitMs: 0,
		})
		expect(write.error).toMatch(/another Namzu/)
		expect(readFileSync(localSettingsPath(cwd), 'utf8')).toBe('{}\n')

		// A running process that held it for an hour is not writing: its id was reused.
		const hourAgo = new Date(Date.now() - 60 * 60 * 1000)
		utimesSync(lock, hourAgo, hourAgo)
		expect(
			updateLocalSettings(cwd, () => ({ document: { quiet: true } }), { lockWaitMs: 0 }).error,
		).toBeUndefined()
	})

	it('judges a lock from another machine by its age alone', () => {
		const { cwd } = project()
		writeNew(cwd, '{}\n')
		const lock = `${localSettingsPath(cwd)}.lock`
		// This process's own id, but written elsewhere: it says nothing about this process.
		writeFileSync(lock, JSON.stringify({ pid: process.pid, host: `${hostname()}-other`, at: 'x' }))
		expect(
			updateLocalSettings(cwd, () => ({ document: { quiet: true } }), { lockWaitMs: 0 }).error,
		).toMatch(/another Namzu/)
		const minuteAgo = new Date(Date.now() - 60_000)
		utimesSync(lock, minuteAgo, minuteAgo)
		expect(
			updateLocalSettings(cwd, () => ({ document: { quiet: true } }), { lockWaitMs: 0 }).error,
		).toBeUndefined()
	})

	it.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)(
		'says why a lock could not be made instead of blaming another Namzu',
		() => {
			const { cwd } = project()
			writeNew(cwd, '{}\n')
			chmodSync(join(cwd, '.namzu'), 0o500)
			try {
				const write = updateLocalSettings(cwd, () => ({ document: { quiet: true } }), {
					lockWaitMs: 0,
				})
				expect(write.error).toMatch(/lock could not be made/)
				expect(write.error).not.toMatch(/another Namzu/)
			} finally {
				chmodSync(join(cwd, '.namzu'), 0o700)
			}
			expect(readFileSync(localSettingsPath(cwd), 'utf8')).toBe('{}\n')
		},
	)

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

describe.runIf(process.platform !== 'win32')('a disk that takes fewer bytes than asked', () => {
	// A real process under a file-size limit: the disk refuses the rest of the staging file the
	// way a full disk does. It boots TypeScript through tsx, which is slow on a busy runner, so
	// the limit is raised; the outcome does not depend on speed.
	it(
		'leaves the saved file whole and says the answer was not saved',
		{ timeout: 120_000 },
		async () => {
			const { cwd } = project()
			const bash: Record<string, string> = {}
			for (let n = 0; n < 200; n += 1) bash[`echo saved-answer-${n} *`] = 'allow'
			const saved = `${JSON.stringify({ permissions: { bash } }, null, '\t')}\n`
			// Over 4 KiB, so the limit below (2 or 4 KiB, by the shell's block size) cuts the copy.
			expect(saved.length).toBeGreaterThan(6000)
			writeNew(cwd, saved)
			const script = fileURLToPath(new URL('./__fixtures__/local-short-disk.ts', import.meta.url))
			const child = spawn(
				'sh',
				['-c', 'ulimit -f 4 && exec "$0" --import tsx "$1" "$2"', process.execPath, script, cwd],
				// No transform cache: the limit would refuse its files too.
				{ env: { ...process.env, TSX_DISABLE_CACHE: '1' }, stdio: ['ignore', 'pipe', 'inherit'] },
			)
			let out = ''
			child.stdout?.on('data', (chunk) => {
				out += chunk
			})
			const code = await new Promise<number | null>((resolve, reject) => {
				child.on('error', reject)
				child.on('close', resolve)
			})

			expect(code).toBe(0)
			const write = JSON.parse(out) as { error?: string }
			expect(write.error).toMatch(/EFBIG|disk took/)
			expect(readFileSync(localSettingsPath(cwd), 'utf8')).toBe(saved)
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
