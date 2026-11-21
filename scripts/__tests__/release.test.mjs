// node --test scripts/__tests__/release.test.mjs
// The decision logic of scripts/release.mjs with injected runners: no npm, gh, git or registry is called.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Refusal, compareVersions, main, parseGateProof } from '../release.mjs'

const TREE = 'a'.repeat(40)
const HEAD = 'b'.repeat(40)
const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' })
const bad = (stderr = 'boom') => ({ status: 1, stdout: '', stderr })
const PKGS = JSON.stringify([
	{ name: '@namzu/sdk', version: '2.0.0', private: false },
	{ name: '@namzu/cli', version: '3.0.0', private: false },
	{ name: '@namzu/desktop', version: '0.9.0', private: true },
])
const PROOF = `tree ${TREE}\nDONE fail=0\n`

function world(over = {}) {
	const w = {
		calls: [],
		logs: [],
		sleeps: [],
		files: new Map([['/r/.release/gates/' + TREE + '.txt', PROOF]]),
		dirty: '',
		head: HEAD,
		main: HEAD,
		lsTree: '',
		whoami: ok('arda\n'),
		registry: new Set(), // "name@version" present
		visibleAfter: 0, // view calls that fail before a published version shows
		views: new Map(),
		tags: '@namzu/sdk@2.0.0\n@namzu/cli@3.0.0\n',
		...over,
	}
	w.deps = {
		root: '/r',
		repo: 'o/r',
		log: (m) => w.logs.push(m),
		now: () => new Date('2026-11-22T10:00:00Z'),
		sleep: async (ms) => {
			w.sleeps.push(ms)
		},
		readFile: (p) => {
			if (!w.files.has(p)) throw new Error(`no file ${p}`)
			return w.files.get(p)
		},
		writeFile: (p, t) => w.files.set(p, t),
		mkdir: () => {},
		exists: (p) => w.files.has(p),
		readDir: (p) => w.dirs?.[p] ?? [],
		sha512: () => 'SUM',
		run: (cmd, args, opts) => {
			w.calls.push([cmd, ...args])
			const k = `${cmd} ${args.join(' ')}`
			if (k === 'git status --porcelain') return ok(w.dirty)
			if (k === 'git rev-parse HEAD') return ok(w.head)
			if (k === 'git rev-parse origin/main') return ok(w.main)
			if (k === 'git rev-parse HEAD^{tree}') return ok(TREE)
			if (k.startsWith('git ls-tree')) return ok(w.lsTree)
			if (k === 'git tag --list') return ok(w.tags)
			if (k === 'pnpm list -r --depth -1 --json') return ok(PKGS)
			if (k === 'npm whoami') return w.whoami
			if (cmd === 'npm' && args[0] === 'view') {
				const id = args[1]
				const n = (w.views.get(id) ?? 0) + 1
				w.views.set(id, n)
				if (w.registry.has(id)) return ok(`${id.slice(id.lastIndexOf('@') + 1)}\n`)
				if (w.published && n > w.visibleAfter) return ok(`${id.slice(id.lastIndexOf('@') + 1)}\n`)
				return bad('npm error code E404')
			}
			if (k.startsWith('pnpm changeset publish')) {
				w.published = true
				w.views.clear()
				return ok()
			}
			if (w.gh) return w.gh(cmd, args, opts, k)
			return ok()
		},
	}
	return w
}
const run = (argv, w) => main(argv, w.deps)
const refused = async (argv, w, re) => {
	await assert.rejects(run(argv, w), (e) => e instanceof Refusal && re.test(e.message))
	assert.ok(!w.calls.some((c) => c.join(' ').startsWith('pnpm changeset publish')), 'must not publish')
	assert.ok(!w.calls.some((c) => c[0] === 'git' && c[1] === 'push'), 'must not push')
}

test('refuses a dirty tree', async () => {
	await refused(['local'], world({ dirty: ' M a.ts\n' }), /not clean/)
})
test('refuses when HEAD is not origin/main', async () => {
	await refused(['local'], world({ main: 'c'.repeat(40) }), /not origin\/main/)
})
test('refuses while a changeset is pending, and says how to proceed', async () => {
	const w = world({ lsTree: '100644 blob ' + 'd'.repeat(40) + '\t.changeset/x.md\0' })
	await refused(['local'], w, /pnpm release version/)
})
test('refuses without a gate record', async () => {
	const w = world()
	w.files.clear()
	await refused(['local'], w, /no gate record/)
})
test('refuses a record for another tree or with failures', async () => {
	const w = world()
	w.files.set('/r/.release/gates/' + TREE + '.txt', `tree ${'e'.repeat(40)}\nDONE fail=0\n`)
	await refused(['local'], w, /does not name this tree/)
	w.files.set('/r/.release/gates/' + TREE + '.txt', `tree ${TREE}\nDONE fail=2\n`)
	await refused(['local'], w, /failures/)
})
test('--gates accepts an explicit summary', async () => {
	const w = world({ whoami: bad() })
	w.files.clear()
	w.files.set('/s.txt', PROOF)
	await refused(['local', '--gates', '/s.txt'], w, /not signed in/)
	assert.ok(w.logs.some((l) => l.includes('gates: passed')))
})
test('refuses when not signed in to npm and names the login command', async () => {
	await refused(['local'], world({ whoami: bad('ENEEDAUTH') }), /npm login --auth-type=web/)
})
test('skips a version already on the registry and publishes nothing when all exist', async () => {
	const w = world({ registry: new Set(['@namzu/sdk@2.0.0', '@namzu/cli@3.0.0']) })
	const r = await run(['local'], w)
	assert.deepEqual(r.published, [])
	assert.ok(w.logs.some((l) => l.includes('skip @namzu/sdk@2.0.0')))
	assert.ok(!w.calls.some((c) => c.join(' ').startsWith('pnpm changeset publish')))
})
test('a registry error that is not a 404 refuses', async () => {
	const w = world()
	const orig = w.deps.run
	w.deps.run = (c, a, o) => (c === 'npm' && a[0] === 'view' ? bad('ECONNRESET') : orig(c, a, o))
	await refused(['local'], w, /could not ask the registry/)
})
test('dry run runs the checks, lists the packages and does not publish or push', async () => {
	const w = world({ registry: new Set(['@namzu/sdk@2.0.0']) })
	const r = await run(['local', '--dry-run'], w)
	assert.equal(r.dryRun, true)
	assert.deepEqual(r.toPublish.map((p) => p.name), ['@namzu/cli'])
	const cmds = w.calls.map((c) => c.join(' '))
	assert.ok(cmds.some((c) => c.includes('verify-consumer-install.sh')))
	assert.ok(cmds.some((c) => c.includes('check-publish-metadata.mjs')))
	assert.ok(cmds.includes('npm whoami'))
	assert.ok(!cmds.some((c) => c.startsWith('pnpm changeset publish') || c.startsWith('git push')))
})
test('publishes with --otp, verifies with bounded retries on a fake clock, then pushes tags and writes the note', async () => {
	const w = world({ visibleAfter: 2 })
	const r = await run(['local', '--otp', '123456'], w)
	const cmds = w.calls.map((c) => c.join(' '))
	const pub = cmds.findIndex((c) => c === 'pnpm changeset publish --otp 123456')
	const push = cmds.findIndex((c) => c.startsWith('git push origin'))
	assert.ok(pub >= 0 && push > pub, 'tags are pushed after the publish')
	const lastView = cmds.map((c, i) => (c.startsWith('npm view') && i > pub ? i : -1)).reduce((a, b) => Math.max(a, b))
	assert.ok(push > lastView, 'tags are pushed only after verification')
	assert.deepEqual(w.sleeps, [2000, 4000, 2000, 4000])
	assert.equal(cmds[push], 'git push origin refs/tags/@namzu/sdk@2.0.0 refs/tags/@namzu/cli@3.0.0')
	assert.match(w.files.get(r.notePath), /@namzu\/sdk@2\.0\.0/)
})
test('a version that never shows leaves the tags unpushed', async () => {
	const w = world({ visibleAfter: 99 })
	await assert.rejects(run(['local'], w), /Tags were NOT pushed/)
	assert.deepEqual(w.sleeps.slice(0, 5), [2000, 4000, 8000, 16000, 30000])
	assert.ok(!w.calls.some((c) => c[0] === 'git' && c[1] === 'push'))
	assert.ok(!w.calls.some((c) => c.join(' ').includes('unpublish')))
})
test('record-gates writes a record only for DONE fail=0', async () => {
	const w = world()
	w.files.clear()
	w.files.set('/ok.txt', 'ran 40 gates\nDONE fail=0\n')
	w.files.set('/no.txt', 'DONE fail=1\n')
	await assert.rejects(run(['record-gates', '--summary', '/no.txt'], w), Refusal)
	await run(['record-gates', '--summary', '/ok.txt'], w)
	assert.deepEqual(parseGateProof(w.files.get('/r/.release/gates/' + TREE + '.txt'), TREE), { ok: true, reason: '' })
})
test('version stops after showing the bumps', async () => {
	const w = world()
	let n = 0
	const orig = w.deps.run
	w.deps.run = (c, a, o) => {
		if (c === 'pnpm' && a[0] === 'list') return ok(n++ === 0 ? PKGS.replace('3.0.0', '2.9.0') : PKGS)
		return orig(c, a, o)
	}
	const bumps = await run(['version'], w)
	assert.deepEqual(bumps, [{ name: '@namzu/cli', version: '3.0.0' }])
	assert.ok(w.logs.some((l) => l.includes('2.9.0 -> 3.0.0')))
})
test('compareVersions orders like sort -V', () => {
	assert.ok(compareVersions('0.10.0', '0.9.1') > 0)
	assert.ok(compareVersions('1.0.0', '1.0.0-rc.1') > 0)
})

// ---- desktop -------------------------------------------------------------------------------

const EXE = 'Namzu-Setup-0.9.0.exe'
function desktopWorld(over = {}) {
	const w = world(over)
	w.files.set('/r/packages/desktop/package.json', JSON.stringify({ version: '0.9.0', devDependencies: { electron: '39.0.0' } }))
	w.files.set('/r/packages/desktop/CHANGELOG.md', '# d\n\n## 0.9.0\n\n- x\n\n## 0.8.4\n')
	w.files.set('/inst/latest.yml', `version: 0.9.0\npath: ${EXE}\nsha512: SUM\n`)
	w.dirs = { '/inst': ['latest.yml', EXE, `${EXE}.blockmap`] }
	w.feed = ('feed' in over ? over.feed : ['Namzu-Setup-0.8.4.exe', 'Namzu-Setup-0.8.4.exe.blockmap', 'Namzu-Setup-0.8.3.exe', 'Namzu-Setup-0.8.3.exe.blockmap', 'latest.yml'])
	w.gh = (cmd, args, _o, k) => {
		if (k === 'gh release view desktop-latest') return w.feed ? ok() : bad('release not found')
		if (k.startsWith('gh release view desktop-latest --json')) return ok(w.feed.join('\n'))
		return ok()
	}
	return w
}
const ghCalls = (w) => w.calls.filter((c) => c[0] === 'gh').map((c) => c.join(' '))

test('desktop stage refuses without a changelog entry or without the image', async () => {
	const w = desktopWorld()
	w.files.set('/r/packages/desktop/CHANGELOG.md', '## 0.8.4\n')
	await assert.rejects(run(['desktop'], w), /no "## 0.9.0" section/)
	const v = desktopWorld()
	await assert.rejects(run(['desktop'], v), /--pal-computer-image is required/)
})
test('desktop stage stages, checks the image and prints the Windows instructions', async () => {
	const w = desktopWorld()
	w.files.set('/i.zst', 'x')
	w.files.set('/m.json', '{}')
	await run(['desktop', '--pal-computer-image', '/i.zst', '--pal-computer-manifest', '/m.json'], w)
	const cmds = w.calls.map((c) => c.join(' '))
	assert.ok(cmds.some((c) => c.includes('stage-installer.mjs') && c.includes('--pal-computer-manifest /m.json')))
	assert.ok(cmds.some((c) => c.includes('check-pal-image.mjs archive')))
	assert.ok(w.logs.join('\n').includes('electron-builder@26.17.0'))
})
test('desktop publish refuses a wrong sha512, a wrong file set and a version already on the feed', async () => {
	const a = desktopWorld()
	a.files.set('/inst/latest.yml', `version: 0.9.0\npath: ${EXE}\nsha512: OTHER\n`)
	await assert.rejects(run(['desktop', 'publish', '--installer', '/inst'], a), /sha512/)
	const b = desktopWorld()
	b.dirs['/inst'] = ['latest.yml', EXE]
	await assert.rejects(run(['desktop', 'publish', '--installer', '/inst'], b), /must hold exactly/)
	const c = desktopWorld({ feed: [EXE, 'Namzu-Setup-0.8.4.exe'] })
	await assert.rejects(run(['desktop', 'publish', '--installer', '/inst'], c), /already on desktop-latest/)
	for (const w of [a, b, c]) assert.ok(!ghCalls(w).some((g) => g.startsWith('gh release upload')))
})
test('desktop publish --dry-run checks everything and uploads nothing', async () => {
	const w = desktopWorld()
	const r = await run(['desktop', 'publish', '--installer', '/inst', '--dry-run'], w)
	assert.equal(r.previous, '0.8.4')
	assert.ok(w.calls.some((c) => c.join(' ').includes('feed-release-notes.mjs') && c.includes('0.8.4')))
	assert.ok(!ghCalls(w).some((g) => /release (upload|edit|create|delete-asset)/.test(g)))
})
test('desktop publish uploads installer, then latest.yml, then edits, then prunes', async () => {
	const w = desktopWorld()
	await run(['desktop', 'publish', '--installer', '/inst'], w)
	const g = ghCalls(w).filter((c) => /release (upload|edit|delete-asset)/.test(c))
	assert.match(g[0], /release upload desktop-latest \/inst\/Namzu-Setup-0\.9\.0\.exe .*blockmap/)
	assert.match(g[1], /release upload desktop-latest --clobber \/inst\/latest\.yml/)
	assert.match(g[2], /release edit desktop-latest --title Namzu Desktop 0\.9\.0 --notes-file/)
	assert.match(g[3], /delete-asset desktop-latest Namzu-Setup-0\.8\.3\.exe --yes/)
	assert.equal(g.length, 5)
})
test('desktop publish creates the release when the feed has none', async () => {
	const w = desktopWorld({ feed: null })
	await run(['desktop', 'publish', '--installer', '/inst'], w)
	assert.ok(ghCalls(w).some((c) => c.startsWith('gh release create desktop-latest --prerelease --latest=false')))
})
