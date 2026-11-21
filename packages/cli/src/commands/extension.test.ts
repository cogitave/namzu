import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { recordingSpawn, settle } from '../integrations/extensions/__fixtures__/fake-child.js'
import {
	buildPackage,
	makeKey,
	makeLicense,
	makeZip,
	sampleManifest,
	trustedFrom,
} from '../integrations/extensions/__fixtures__/package-builder.js'
import { ExtensionHost } from '../integrations/extensions/host.js'
import { openPackage } from '../integrations/extensions/package.js'
import { validateFolder } from '../integrations/extensions/validate.js'
import { type ExtensionDeps, parseExtensionArgs, runExtension } from './extension.js'

const pub = makeKey('pub-cmd')
const lic = makeKey('lic-cmd')
const ID = 'com.example.stub-recorder'

let dir: string
let host: ExtensionHost
const hosts: ExtensionHost[] = []
let out: string[]
let err: string[]
let answers: string[]
let stdin = ''
const rec = recordingSpawn()

const deps = (over: Partial<ExtensionDeps> = {}): ExtensionDeps => ({
	host,
	out: (t) => out.push(t),
	err: (t) => err.push(t),
	isTTY: true,
	ask: async (q) => {
		out.push(q)
		return answers.shift() ?? ''
	},
	readStdin: async () => stdin,
	...over,
})
const run = (...a: string[]) => runExtension(a, deps())
const nzx = (name: string, mut?: (m: any) => void, version = '1.0.0') => {
	const f = join(dir, name)
	writeFileSync(
		f,
		buildPackage({
			manifest: sampleManifest(mut as never, { version, keyId: pub.id }),
			publisherKey: pub,
			licenseKey: lic,
		}),
	)
	return f
}
const licFile = (text = makeLicense(lic)) => {
	const f = join(dir, 'key.nzlic')
	writeFileSync(f, text)
	return f
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'ext-cmd-'))
	out = []
	err = []
	answers = []
	stdin = ''
	host = new ExtensionHost({
		home: join(dir, 'home'),
		hostVersion: '53.5.0',
		kind: 'cli',
		env: {},
		locale: () => 'en',
		compiledKeys: [trustedFrom(pub)],
		spawn: rec.spawn,
	})
	hosts.push(host)
})
afterEach(async () => {
	for (const h of hosts.splice(0)) await h.stopSupervision()
	removeTempDir(dir)
})

describe('namzu extension', () => {
	it('parses flags and refuses unknown ones', () => {
		expect(
			parseExtensionArgs(['notice', 'x', '--staged', '--locale', 'tr']).flags.get('--locale'),
		).toBe('tr')
		expect(parseExtensionArgs(['add', '--wat']).error).toMatch(/unknown option/)
		expect(parseExtensionArgs(['license', 'x', '--file']).error).toMatch(/needs a value/)
	})

	it('E4: add prints each permission with its purposes in plain words, starts nothing, says what is next', async () => {
		expect(await run('add', nzx('a.nzx'))).toBe(0)
		const text = out.join('\n')
		expect(text).toMatch(/os\.foregroundWindow \[medium\]/)
		expect(text).toMatch(/Why: To count the time spent in each program\./)
		expect(text).toMatch(/os\.screenChange \[high, optional: asked for later\]/)
		expect(text).toMatch(/It does not use the network\./)
		expect(text).toMatch(/An administrator of this computer can get around this protection\./)
		expect(text).toMatch(/Nothing was started\./)
		expect(text).toMatch(/namzu extension license com\.example\.stub-recorder/)
		expect(host.view(ID).state).toBe('added')
	})

	it('E5: a permission with no purpose is refused, naming the permission and exiting 1', async () => {
		const bad = nzx('bad.nzx', (m) => {
			m.permissions[0].purposes = []
		})
		expect(await run('add', bad)).toBe(1)
		expect(err.join('\n')).toMatch(/os\.foregroundWindow has no purpose/)
	})

	it('add refuses a folder and a missing file with their own codes', async () => {
		expect(await run('add', dir)).toBe(64)
		expect(await run('add', join(dir, 'nope.nzx'))).toBe(66)
	})

	it('E7: enable without a record needs a person: a non-TTY run is refused, with no record', async () => {
		await run('add', nzx('a.nzx'))
		await run('license', ID, '--file', licFile())
		out.length = 0
		expect(await runExtension(['enable', ID], deps({ isTTY: false }))).toBe(75)
		expect(err.join('\n')).toMatch(/needs you/)
		expect(host.consent.read(ID)).toBeUndefined()
	})

	it('E7: answering no writes only an audit line and leaves it off; answering yes records and enables', async () => {
		await run('add', nzx('a.nzx'))
		await run('license', ID, '--file', licFile())
		answers = ['n']
		expect(await run('enable', ID)).toBe(1)
		expect(host.consent.read(ID)).toBeUndefined()
		expect(host.view(ID).enabled).toBe(false)
		expect(host.audit(ID).map((l) => l.event)).toContain('declined')
		answers = ['y']
		out.length = 0
		expect(await run('enable', ID)).toBe(0)
		expect(out.join('\n')).toMatch(/Acknowledge this notice \(version 1\.0\)\? \[y\/N\]/)
		expect(host.consent.read(ID)?.via).toBe('cli')
		expect(host.view(ID).enabled).toBe(true)
		await settle()
		// A covering record: enabling again asks nothing, and the CLI never takes --yes.
		await run('disable', ID)
		out.length = 0
		answers = []
		expect(await runExtension(['enable', ID], deps({ isTTY: false }))).toBe(0)
		expect(out.join('\n')).not.toMatch(/Acknowledge/)
		expect(await run('enable', ID, '--yes')).toBe(64)
	})

	it('license: from a file or from standard input, never from an argument; a bad one is named', async () => {
		await run('add', nzx('a.nzx'))
		expect(await run('license', ID)).toBe(64)
		expect(err.join('\n')).toMatch(/never as an argument/)
		stdin = makeLicense(lic, { expires: '2020-01-01T00:00:00Z' })
		expect(await runExtension(['license', ID], deps({ isTTY: false }))).toBe(1)
		expect(err.join('\n')).toMatch(/expired/)
		stdin = makeLicense(lic)
		out.length = 0
		expect(await runExtension(['license', ID], deps({ isTTY: false }))).toBe(0)
		expect(out.join('\n')).toMatch(/Test Company, 25 seats/)
		const f = join(dir, 'home', 'extensions', ID, 'license.json')
		expect(readFileSync(f, 'utf8')).toContain('payload')
	})

	it('list, status and notice read without changing anything, and --json prints one object', async () => {
		await run('add', nzx('a.nzx'))
		await run('license', ID, '--file', licFile())
		answers = ['y']
		await run('enable', ID)
		await settle()
		out.length = 0
		expect(await run('list', '--json')).toBe(0)
		const list = JSON.parse(out[0] as string)
		expect(list.extensions[0]).toMatchObject({ id: ID, state: 'running', dev: false })
		out.length = 0
		expect(await run('status', ID)).toBe(0)
		expect(out.join('\n')).toMatch(/Recording/)
		expect(out.join('\n')).toMatch(/Acknowledged: .*notice 1\.0 \(en\)/)
		out.length = 0
		const before = readFileSync(join(dir, 'home', 'extensions', ID, 'consent.json'), 'utf8')
		expect(await run('notice', ID, '--locale', 'tr')).toBe(0)
		expect(out.join('\n')).toMatch(/Notice in tr/)
		expect(readFileSync(join(dir, 'home', 'extensions', ID, 'consent.json'), 'utf8')).toBe(before)
	})

	it('an update that asks for more is staged and `enable` shows the diff and asks once', async () => {
		await run('add', nzx('a.nzx'))
		await run('license', ID, '--file', licFile())
		answers = ['y']
		await run('enable', ID)
		out.length = 0
		await run(
			'add',
			nzx(
				'b.nzx',
				(m) => {
					m.legal.noticeVersion = '1.1'
				},
				'1.1.0',
			),
		)
		expect(out.join('\n')).toMatch(
			/An update is waiting: it asks for more \(notice version 1\.0 -> 1\.1\)/,
		)
		expect(host.view(ID).version).toBe('1.0.0')
		out.length = 0
		answers = ['y']
		expect(await run('enable', ID)).toBe(0)
		expect(out.join('\n')).toMatch(/It now also asks:/)
		expect(host.view(ID).version).toBe('1.1.0')
	})

	it('grant asks with the prompt and the purposes; revoke takes it back; a required permission is refused', async () => {
		await run('add', nzx('a.nzx'))
		await run('license', ID, '--file', licFile())
		answers = ['y']
		await run('enable', ID)
		expect(await run('grant', ID, 'os.foregroundWindow')).toBe(1)
		expect(err.join('\n')).toMatch(/part of the scope/)
		out.length = 0
		answers = ['y']
		expect(await run('grant', ID, 'os.screenChange')).toBe(0)
		expect(out.join('\n')).toMatch(/Allow the screen-change number\?/)
		expect(host.consent.read(ID)?.grants['os.screenChange']).toBeTruthy()
		expect(await runExtension(['grant', ID, 'os.screenChange'], deps({ isTTY: false }))).toBe(75)
		expect(await run('revoke', ID, 'os.screenChange')).toBe(0)
		expect(host.consent.read(ID)?.grants).toEqual({})
	})

	it('key: stored from standard input, never printed back, never an argument', async () => {
		await run('add', nzx('a.nzx'))
		expect(await runExtension(['key', ID, 'openai'], deps({ isTTY: false }))).toBe(64)
		stdin = 'sk-secret-value-9876\n'
		out.length = 0
		expect(await runExtension(['key', ID, 'openai', '--stdin'], deps({ isTTY: false }))).toBe(0)
		expect(out.join('\n')).not.toContain('sk-secret-value')
		expect(out.join('\n')).toMatch(/9876/)
		expect(await run('key', ID, 'openai', '--remove')).toBe(0)
	})

	it('remove with --delete-data and without, and the words about what was sent elsewhere', async () => {
		await run('add', nzx('a.nzx'))
		out.length = 0
		expect(await run('remove', ID, '--delete-data')).toBe(0)
		expect(out.join('\n')).toMatch(/Its data was deleted\..*Nothing was ever sent anywhere/)
		expect(host.list()).toEqual([])
	})

	it('run supervises until aborted and stops cleanly', async () => {
		await run('add', nzx('a.nzx'))
		await run('license', ID, '--file', licFile())
		answers = ['y']
		await run('enable', ID)
		const ac = new AbortController()
		const done = runExtension(['run'], deps({ signal: ac.signal }))
		await settle()
		ac.abort()
		expect(await done).toBe(0)
		expect(err.join('\n')).toMatch(/●/)
	})

	it('run keeps a timer alive while it waits, so Node does not leave early with nothing running', async () => {
		vi.useFakeTimers()
		try {
			const ac = new AbortController()
			const done = runExtension(['run'], deps({ signal: ac.signal }))
			await vi.advanceTimersByTimeAsync(0)
			expect(vi.getTimerCount()).toBeGreaterThan(0)
			ac.abort()
			expect(await done).toBe(0)
			expect(vi.getTimerCount()).toBe(0)
		} finally {
			vi.useRealTimers()
		}
	})

	it('unknown commands and a missing command are usage errors', async () => {
		expect(await run('frobnicate')).toBe(64)
		expect(await run()).toBe(64)
		expect(await run('status')).toBe(64)
	})
})

describe('E24: validate says rule and path for each refusal', () => {
	const writeFolder = (mut: (m: any) => void) => {
		const f = mkdtempSync(join(dir, 'folder-'))
		const m: any = sampleManifest(mut as never)
		writeFileSync(join(f, 'namzu-extension.json'), JSON.stringify(m))
		for (const [name, body] of [
			['bin/stub.cjs', '#!/bin/sh\n'],
			['keys/license-pub.json', '{}'],
			['schemas/status.json', '{}'],
			['schemas/counts.json', '{}'],
			['schemas/rows.json', '{}'],
		] as const) {
			mkdirSync(join(f, name.split('/')[0] as string), { recursive: true })
			writeFileSync(join(f, name), body)
		}
		chmodSync(join(f, 'bin/stub.cjs'), 0o755)
		return f
	}
	it('a folder with a notice file missing is refused (K1) and says which', () => {
		const r = validateFolder(writeFolder(() => {}))
		expect(r.ok).toBe(false)
		expect(r.issues[0]).toMatchObject({ rule: 'K1' })
		expect(r.issues[0]?.message).toMatch(/legal\/notice/)
	})
	it.each([
		[
			'a permission with no purpose',
			(m: any) => {
				m.permissions[0].purposes = []
			},
			'P0',
		],
		[
			'a reserved permission',
			(m: any) => {
				m.permissions[0].id = 'os.windowTitle'
			},
			'schema',
		],
		[
			'a text without the default language',
			(m: any) => {
				delete m.name.en
			},
			'L2',
		],
		[
			'a content-like field',
			(m: any) => {
				m.produces[0].fields.push({ name: 'url', type: 'text', description: { en: 'x' } })
			},
			'P4',
		],
	])('%s', (_n, mut, rule) => {
		const r = validateFolder(writeFolder(mut))
		expect(r.ok).toBe(false)
		expect(r.issues.some((i) => i.rule === rule)).toBe(true)
	})
	it('a package: signed fine and checked, a zip-slip refused, an untrusted key still has its hashes checked and is marked NOT verified', async () => {
		const good = nzx('good.nzx')
		// A test key is not trusted in a plain environment: the structure and hashes pass, the signature is NOT proven, and it says so.
		expect(await run('validate', good)).toBe(0)
		expect(out.join('\n')).toMatch(
			/Signature: NOT verified: This file was not signed by a publisher Namzu trusts \(key pub-cmd\)/,
		)
		out.length = 0
		const slip = join(dir, 'slip.nzx')
		writeFileSync(slip, makeZip([{ name: '../evil', data: Buffer.from('x') }]))
		expect(await run('validate', slip)).toBe(1)
		expect(out.join('\n')).toMatch(/zip-slip/)
		out.length = 0
		expect(await runExtension(['validate', good, '--json'], deps())).toBe(0)
		expect(JSON.parse(out[0] as string)).toMatchObject({ kind: 'package', ok: true, id: ID })
	})
	it('warns, without refusing, when a package file is not named <id>-<version>-<platform>.nzx', async () => {
		const odd = nzx('odd.nzx')
		expect(await run('validate', odd)).toBe(0)
		expect(out.join('\n')).toMatch(
			/Warning: the package file is named odd\.nzx; name it <id>-<version>-<platform>\.nzx/,
		)
		out.length = 0
		expect(await runExtension(['validate', odd, '--json'], deps())).toBe(0)
		expect(JSON.parse(out[0] as string).warnings).toHaveLength(1)
	})
	it('says nothing about a package file named by the convention', async () => {
		const first = nzx('first.nzx')
		const manifest = JSON.parse(
			openPackage(readFileSync(first))
				.get('namzu-extension.json')
				?.bytes.toString('utf8') as string,
		)
		const named = join(dir, `${manifest.id}-${manifest.version}-${manifest.platforms[0]}.nzx`)
		writeFileSync(named, readFileSync(first))
		expect(await run('validate', named)).toBe(0)
		expect(out.join('\n')).not.toMatch(/Warning/)
	})
	it('a missing target is exit 66', async () => {
		expect(await run('validate', join(dir, 'nope'))).toBe(66)
	})
})
