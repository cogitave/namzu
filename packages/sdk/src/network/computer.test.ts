import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'
import {
	COMPUTER_SECRET_FILE,
	COMPUTER_SECRET_WINDOWS_PATH_FILE,
	type ResolveSecretDeps,
	computerJoinProof,
	computerMemberProof,
	computerSecretFingerprint,
	ensureComputerSecret,
	homeQualifies,
	readComputerSecret,
	resolveComputerSecret,
	verifyComputerJoinProof,
	verifyComputerMemberProof,
	windowsProfilePathOk,
} from './computer.js'

const dirs: string[] = []
afterEach(() => {
	for (const d of dirs.splice(0)) removeTempDir(d)
})
const scratch = () => {
	const d = mkdtempSync(join(tmpdir(), 'namzu-computer-'))
	dirs.push(d)
	return d
}
const posixOnly = process.platform === 'win32' ? it.skip : it
const GOOD = `${'ab'.repeat(32)}\n`

function secretFile(mode = 0o600, dirMode = 0o700, body = GOOD) {
	const root = scratch()
	const dir = join(root, 'network')
	mkdirSync(dir, { mode: dirMode })
	chmodSync(dir, dirMode)
	const path = join(dir, COMPUTER_SECRET_FILE)
	writeFileSync(path, body, { mode })
	chmodSync(path, mode)
	return { root, dir, path }
}

describe('proof', () => {
	const secret = Buffer.alloc(32, 7)
	it('verifies for the same ids and nonce and for nothing else', () => {
		const proof = computerJoinProof(secret, 'j', 'm', 'n')
		expect(verifyComputerJoinProof(secret, proof, 'j', 'm', 'n')).toBe(true)
		expect(verifyComputerJoinProof(secret, proof, 'j2', 'm', 'n')).toBe(false)
		expect(verifyComputerJoinProof(secret, proof, 'j', 'm2', 'n')).toBe(false)
		expect(verifyComputerJoinProof(secret, proof, 'j', 'm', 'n2')).toBe(false)
		expect(verifyComputerJoinProof(Buffer.alloc(32, 8), proof, 'j', 'm', 'n')).toBe(false)
		expect(verifyComputerJoinProof(secret, 'short', 'j', 'm', 'n')).toBe(false)
	})
	it('does not contain the secret', () => {
		expect(computerJoinProof(secret, 'j', 'm', 'n')).toHaveLength(44)
	})
})

describe('readComputerSecret', () => {
	posixOnly('reads a private file in a private folder', async () => {
		const { path } = secretFile()
		const r = await readComputerSecret({ path, check: 'posix' })
		expect(r.status).toBe('ok')
	})
	it('reports an absent file as absent', async () => {
		expect(
			await readComputerSecret({
				path: join(scratch(), 'none'),
				check: 'posix',
			}),
		).toEqual({
			status: 'absent',
		})
	})
	posixOnly('refuses a file others can read', async () => {
		const { path } = secretFile(0o644)
		expect(await readComputerSecret({ path, check: 'posix' })).toMatchObject({
			status: 'unsafe',
		})
	})
	posixOnly('refuses a folder others can write', async () => {
		const { path } = secretFile(0o600, 0o770)
		expect(await readComputerSecret({ path, check: 'posix' })).toMatchObject({
			status: 'unsafe',
		})
	})
	posixOnly('refuses a symbolic link', async () => {
		const { dir, path } = secretFile()
		const link = join(dir, 'link')
		symlinkSync(path, link)
		expect(await readComputerSecret({ path: link, check: 'posix' })).toMatchObject({
			status: 'unsafe',
		})
	})
	posixOnly('refuses a file owned by another user', async () => {
		const { path } = secretFile()
		const r = await readComputerSecret(
			{ path, check: 'posix' },
			{ uid: (process.getuid?.() ?? 0) + 1 },
		)
		expect(r).toMatchObject({ status: 'unsafe' })
	})
	posixOnly('refuses a file of the wrong size or content', async () => {
		const { path } = secretFile(0o600, 0o700, 'abcd\n')
		expect(await readComputerSecret({ path, check: 'posix' })).toMatchObject({
			status: 'unsafe',
		})
	})
	it('path-only trust skips the mode bits (a Windows profile seen from WSL) but still refuses a link', async () => {
		const { path } = secretFile(0o666)
		expect((await readComputerSecret({ path, check: 'path-only' })).status).toBe('ok')
	})
})

describe('ensureComputerSecret', () => {
	posixOnly('creates once, 0600, and two homes starting together agree', async () => {
		const root = scratch()
		const source = {
			path: join(root, '.namzu', 'network', COMPUTER_SECRET_FILE),
			check: 'posix',
			create: true,
		} as const
		const results = await Promise.all([ensureComputerSecret(source), ensureComputerSecret(source)])
		expect(results.filter((r) => r === 'created').length).toBeGreaterThanOrEqual(1)
		const first = readFileSync(source.path, 'utf8')
		await ensureComputerSecret(source)
		expect(readFileSync(source.path, 'utf8')).toBe(first)
		expect((await readComputerSecret(source)).status).toBe('ok')
	})
	posixOnly('never replaces a file that is there, even a loose one', async () => {
		const { path, root } = secretFile(0o644)
		await ensureComputerSecret({ path, check: 'posix', create: true })
		expect(readFileSync(path, 'utf8')).toBe(GOOD)
		expect(existsSync(root)).toBe(true)
	})
	it('creates nothing when the source may not create', async () => {
		const path = join(scratch(), 'x', COMPUTER_SECRET_FILE)
		expect(await ensureComputerSecret({ path, check: 'path-only', create: false })).toBe('exists')
		expect(existsSync(path)).toBe(false)
	})
})

describe('which secret a home may use', () => {
	const OS = '/home/arda'
	function deps(
		files: Record<string, string>,
		exec: Record<string, string> = {},
	): ResolveSecretDeps & { wrote: Record<string, string> } {
		const wrote: Record<string, string> = {}
		return {
			wrote,
			realpath: async (p) => p,
			exists: async (p) => p in files,
			readText: async (p) => files[p],
			writeText: async (p, t) => {
				wrote[p] = t
			},
			exec: async (cmd, args) => exec[`${cmd} ${args.join(' ')}`],
			// The Windows drive is mounted as Linux user 1000, who is also this process.
			fileOwner: async (p) => (p in files ? 1000 : undefined),
			uid: 1000,
		}
	}
	const base = { osHome: OS, platform: 'linux' }
	const native = `${OS}/.namzu/network/${COMPUTER_SECRET_FILE}`

	it('the default home and a service home directly under it use the native secret', async () => {
		for (const home of [`${OS}/.namzu`, `${OS}/.namzu/services/autodev`]) {
			expect(await resolveComputerSecret({ ...base, home, env: {}, deps: deps({}) })).toEqual({
				path: native,
				check: 'posix',
				create: true,
			})
		}
	})
	it('a lookalike services folder, a nested one and a custom NAMZU_HOME use none', async () => {
		for (const home of [
			'/other/services/x',
			`${OS}/.namzu/services/a/b`,
			'/tmp/scratch-home',
			`${OS}/.namzu/other/x`,
		])
			expect(
				await resolveComputerSecret({ ...base, home, env: {}, deps: deps({}) }),
			).toBeUndefined()
		expect(await homeQualifies('/x/services/y', OS, async (p) => p)).toBe(false)
	})
	it('judges a home by its real path', async () => {
		const d = {
			...deps({}),
			realpath: async (p: string) => (p === '/tmp/link' ? `${OS}/.namzu/services/q` : p),
		}
		expect(
			await resolveComputerSecret({
				...base,
				home: '/tmp/link',
				env: {},
				deps: d,
			}),
		).toBeDefined()
	})
	it('Windows uses its native copy, trusted by path', async () => {
		const r = await resolveComputerSecret({
			home: 'C:/Users/arda/.namzu',
			osHome: 'C:/Users/arda',
			platform: 'win32',
			env: {},
			deps: deps({}),
		})
		expect(r?.check).toBe('path-only')
		expect(r?.create).toBe(true)
	})

	const win = '/mnt/c/Users/Arda'
	const other = '/mnt/c/Users/Other'
	const winFile = `${win}/.namzu/network/${COMPUTER_SECRET_FILE}`
	const cmdKey = 'cmd.exe /c echo %USERPROFILE%'
	const wsl = { ...base, home: `${OS}/.namzu` }

	it('the member counter-proof binds both ends and both nonces, and a join proof is not one', () => {
		const secret = Buffer.alloc(32, 7)
		const proof = computerMemberProof(secret, 'm', 'j', 'jn', 'mn')
		expect(verifyComputerMemberProof(secret, proof, 'm', 'j', 'jn', 'mn')).toBe(true)
		for (const [m, j, jn, mn] of [
			['m2', 'j', 'jn', 'mn'],
			['m', 'j2', 'jn', 'mn'],
			['m', 'j', 'jn2', 'mn'],
			['m', 'j', 'jn', 'mn2'],
		] as const)
			expect(verifyComputerMemberProof(secret, proof, m, j, jn, mn)).toBe(false)
		expect(verifyComputerMemberProof(Buffer.alloc(32, 8), proof, 'm', 'j', 'jn', 'mn')).toBe(false)
		const asJoin = computerJoinProof(secret, 'm', 'j', 'jn')
		expect(verifyComputerMemberProof(secret, asJoin, 'm', 'j', 'jn', 'mn')).toBe(false)
		expect(computerSecretFingerprint(secret)).toMatch(/^[0-9a-f]{16}$/)
		expect(computerSecretFingerprint(secret)).not.toBe(
			computerSecretFingerprint(Buffer.alloc(32, 8)),
		)
	})
	it('WSL with interop finds the Windows copy, never creates in it, and caches the path', async () => {
		const d = deps(
			{ [winFile]: GOOD },
			{ [cmdKey]: 'C:\\Users\\Arda\r', 'wslpath -u C:\\Users\\Arda': win },
		)
		const r = await resolveComputerSecret({
			...wsl,
			env: { WSL_DISTRO_NAME: 'Ubuntu', WSL_INTEROP: '/run/x' },
			deps: d,
		})
		expect(r).toEqual({ path: winFile, check: 'path-only', create: false })
		expect(d.wrote[`${OS}/.namzu/network/${COMPUTER_SECRET_WINDOWS_PATH_FILE}`]).toBe(`${win}\n`)
	})
	it('WSL without interop uses the cached Windows path', async () => {
		const d = deps({
			[winFile]: GOOD,
			[`${OS}/.namzu/network/${COMPUTER_SECRET_WINDOWS_PATH_FILE}`]: `${win}\n`,
		})
		const r = await resolveComputerSecret({
			...wsl,
			env: { WSL_DISTRO_NAME: 'Ubuntu' },
			deps: d,
		})
		expect(r?.path).toBe(winFile)
	})
	it('WSL with interop asks Windows afresh and ignores a cache that names another profile', async () => {
		const d = deps(
			{
				[winFile]: GOOD,
				[`${other}/.namzu/network/${COMPUTER_SECRET_FILE}`]: GOOD,
				[`${OS}/.namzu/network/${COMPUTER_SECRET_WINDOWS_PATH_FILE}`]: `${other}\n`,
			},
			{ [cmdKey]: 'C:\\Users\\Arda', 'wslpath -u C:\\Users\\Arda': win },
		)
		const r = await resolveComputerSecret({
			...wsl,
			env: { WSL_DISTRO_NAME: 'Ubuntu', WSL_INTEROP: '/run/x' },
			deps: d,
		})
		expect(r?.path).toBe(winFile)
	})
	it('WSL falls back to its native copy when the Windows file is absent or no path is known', async () => {
		const noFile = deps({}, { [cmdKey]: 'C:\\Users\\Arda', 'wslpath -u C:\\Users\\Arda': win })
		expect(
			(
				await resolveComputerSecret({
					...wsl,
					env: { WSL_INTEROP: '/run/x' },
					deps: noFile,
				})
			)?.path,
		).toBe(native)
		const nothing = deps({})
		expect(
			(
				await resolveComputerSecret({
					...wsl,
					env: { WSL_DISTRO_NAME: 'U' },
					deps: nothing,
				})
			)?.path,
		).toBe(native)
	})
	it('WSL trusts the Windows copy only for the Linux user the drive mount maps it to', async () => {
		const env = { WSL_DISTRO_NAME: 'Ubuntu', WSL_INTEROP: '/run/x' }
		const files = { [winFile]: GOOD }
		const exec = { [cmdKey]: 'C:\\Users\\Arda', 'wslpath -u C:\\Users\\Arda': win }
		// Another Linux user of the same distro: the mount says the file is user 1000's, not theirs.
		const stranger = { ...deps(files, exec), uid: 1001 }
		expect(
			await resolveComputerSecret({
				...wsl,
				home: '/home/other/.namzu',
				osHome: '/home/other',
				env,
				deps: stranger,
			}),
		).toEqual({ path: '/home/other/.namzu/network/machine-secret', check: 'posix', create: true })
		// The owner itself still gets the Windows copy.
		expect((await resolveComputerSecret({ ...wsl, env, deps: deps(files, exec) }))?.path).toBe(
			winFile,
		)
	})
	it('WSL does not trust a Windows copy whose owner cannot be seen, or a host that gave no way to see it', async () => {
		const env = { WSL_DISTRO_NAME: 'Ubuntu', WSL_INTEROP: '/run/x' }
		const files = { [winFile]: GOOD }
		const exec = { [cmdKey]: 'C:\\Users\\Arda', 'wslpath -u C:\\Users\\Arda': win }
		const blind = { ...deps(files, exec), fileOwner: async () => undefined }
		const noCheck = { ...deps(files, exec), fileOwner: undefined }
		const noUid = { ...deps(files, exec), uid: undefined }
		for (const d of [blind, noCheck, noUid])
			expect((await resolveComputerSecret({ ...wsl, env, deps: d }))?.path).toBe(native)
	})
	it('WSL refuses a Windows profile path outside /mnt/<drive>/Users/<name>', async () => {
		for (const bad of [
			'/etc',
			'/mnt/c/Users',
			'/mnt/c/Users/a/../../Windows',
			'/mnt/cc/Users/a',
			'/home/arda',
		]) {
			const d = deps(
				{ [`${bad}/.namzu/network/${COMPUTER_SECRET_FILE}`]: GOOD },
				{ [cmdKey]: 'C:\\X', 'wslpath -u C:\\X': bad },
			)
			const r = await resolveComputerSecret({
				...wsl,
				env: { WSL_INTEROP: '/run/x' },
				deps: d,
			})
			expect(r?.path, bad).toBe(native)
			expect(windowsProfilePathOk(bad), bad).toBe(false)
		}
		expect(windowsProfilePathOk(win)).toBe(true)
	})
})
