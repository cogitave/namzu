import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	assembleManifest,
	manifestBytes,
	parseManifest,
	reissueManifest,
} from '../kernel/manifest.mjs'
import {
	archiveUploadAction,
	decide,
	pruneList,
	tagCommit,
	waitForRegistry,
} from '../kernel/release-plan.mjs'

const hex = (c, n) => c.repeat(n)
const entry = (target, over = {}) => ({
	target,
	kernel: {
		commandLine: '51.3.0',
		engine: '62.14.0',
		desktopContract: 1,
		dataEpoch: 1,
		...over.kernel,
	},
	bundle: {
		file: 'ignored',
		size: 1234,
		sha512: hex('a', 128),
		filesSha512: hex('b', 128),
		fileCount: 10,
		unpackedSize: 5000,
		...over.bundle,
	},
})
const T0 = '2026-11-12T10:00:00Z'
const first = (over = {}) =>
	assembleManifest({ entries: [entry('win32-x64')], issuedAt: T0, floor: '51.1.0', ...over })

test('a first manifest has the shape of the text, in the text order, with the file name made from the version', () => {
	const m = first()
	assert.equal(m.sequence, Date.parse(T0) / 1000)
	assert.equal(m.issuedAt, T0)
	assert.equal(m.expiresAt, '2026-11-26T10:00:00Z')
	assert.equal(m.minimumKernel, '51.1.0')
	assert.deepEqual(m.withdrawn, [])
	assert.equal(m.kernel.bundles['win32-x64'].file, 'namzu-kernel-51.3.0-win32-x64.tar.gz')
	const text = manifestBytes(m).toString()
	assert.deepEqual(Object.keys(JSON.parse(text)), [
		'schema',
		'channel',
		'sequence',
		'issuedAt',
		'expiresAt',
		'minimumKernel',
		'withdrawn',
		'kernel',
	])
	assert.deepEqual(Object.keys(JSON.parse(text).kernel.bundles['win32-x64']), [
		'file',
		'size',
		'sha512',
		'filesSha512',
		'fileCount',
		'unpackedSize',
	])
	assert.ok(text.endsWith('}\n'))
	assert.deepEqual(manifestBytes(parseManifest(text)), manifestBytes(m))
})

test('a bundle entry cannot pick its own file name, and several entries share one kernel', () => {
	const m = assembleManifest({
		entries: [entry('win32-x64', { bundle: { file: '../evil' } }), entry('linux-x64')],
		issuedAt: T0,
		floor: '51.1.0',
	})
	assert.equal(m.kernel.bundles['win32-x64'].file, 'namzu-kernel-51.3.0-win32-x64.tar.gz')
	assert.deepEqual(Object.keys(m.kernel.bundles), ['linux-x64', 'win32-x64'])
	assert.throws(
		() =>
			assembleManifest({
				entries: [entry('win32-x64'), entry('linux-x64', { kernel: { engine: '9.9.9' } })],
				issuedAt: T0,
				floor: '51.1.0',
			}),
		/disagree about engine/,
	)
	assert.throws(
		() =>
			assembleManifest({
				entries: [entry('win32-x64'), entry('win32-x64')],
				issuedAt: T0,
				floor: '51.1.0',
			}),
		/given twice/,
	)
})

test('the floor defaults to the previous one, or to the kernel itself on a first manifest; never lowered; never above the kernel', () => {
	assert.equal(
		assembleManifest({ entries: [entry('win32-x64')], issuedAt: T0 }).minimumKernel,
		'51.3.0',
	)
	const previous = first({ floor: '51.2.0' })
	const next = assembleManifest({
		entries: [entry('win32-x64', { kernel: { commandLine: '51.4.0' } })],
		issuedAt: '2026-11-13T10:00:00Z',
		previous,
	})
	assert.equal(next.minimumKernel, '51.2.0')
	assert.throws(
		() =>
			assembleManifest({
				entries: [entry('win32-x64', { kernel: { commandLine: '51.4.0' } })],
				issuedAt: '2026-11-13T10:00:00Z',
				previous,
				floor: '51.1.0',
			}),
		/never lowered/,
	)
	assert.throws(() => first({ floor: '52.0.0' }), /above the kernel/)
	assert.equal(
		assembleManifest({
			entries: [entry('win32-x64', { kernel: { commandLine: '51.4.0' } })],
			issuedAt: '2026-11-13T10:00:00Z',
			previous,
			floor: '51.3.0',
		}).minimumKernel,
		'51.3.0',
	)
})

test('a sequence that would go down is refused; equal is allowed for a new kernel only through the version rule', () => {
	const previous = first()
	const e = entry('win32-x64', { kernel: { commandLine: '51.4.0' } })
	assert.throws(
		() => assembleManifest({ entries: [e], issuedAt: '2026-11-12T09:59:59Z', previous }),
		/sequence .* is lower than the previous/,
	)
	assert.equal(
		assembleManifest({ entries: [e], issuedAt: '2026-11-12T10:00:01Z', previous }).sequence,
		previous.sequence + 1,
	)
	assert.throws(
		() => assembleManifest({ entries: [e], issuedAt: T0, previous }),
		/not higher than the previous manifest's \(it equals it\)/,
	)
})

test('the kernel version never goes down, and the same version is a re-issue, not a new manifest', () => {
	const previous = first()
	const at = '2026-11-13T10:00:00Z'
	assert.throws(
		() =>
			assembleManifest({
				entries: [entry('win32-x64', { kernel: { commandLine: '51.2.9' } })],
				issuedAt: at,
				previous,
			}),
		/older than/,
	)
	assert.throws(
		() => assembleManifest({ entries: [entry('win32-x64')], issuedAt: at, previous }),
		/use reissue/,
	)
	assert.throws(
		() =>
			assembleManifest({ entries: [entry('win32-x64')], issuedAt: at, previous, channel: 'beta' }),
		/channel/,
	)
})

test('the withdrawn list is kept unless told to change, and the kernel offered cannot be on it', () => {
	const a = first({ withdraw: ['51.0.0'] })
	assert.deepEqual(a.withdrawn, ['51.0.0'])
	const e = entry('win32-x64', { kernel: { commandLine: '51.4.0' } })
	const b = assembleManifest({ entries: [e], issuedAt: '2026-11-13T10:00:00Z', previous: a })
	assert.deepEqual(b.withdrawn, ['51.0.0'])
	const c = assembleManifest({
		entries: [e],
		issuedAt: '2026-11-13T10:00:00Z',
		previous: a,
		withdraw: ['51.2.0', '50.0.0'],
		unwithdraw: ['51.0.0'],
	})
	assert.deepEqual(c.withdrawn, ['50.0.0', '51.2.0'])
	assert.throws(
		() =>
			assembleManifest({
				entries: [e],
				issuedAt: '2026-11-13T10:00:00Z',
				previous: a,
				withdraw: ['51.4.0'],
			}),
		/withdrawn list/,
	)
	assert.throws(() => first({ withdraw: ['not-a-version'] }), /not a version/)
})

test('reissue: the same kernel and bundles, new times, a higher sequence; floor and withdrawn only as told', () => {
	const previous = first({ withdraw: ['51.0.0'] })
	const again = reissueManifest({ previous, issuedAt: '2026-11-19T10:00:00Z' })
	assert.deepEqual(again.kernel, previous.kernel)
	assert.deepEqual(again.withdrawn, ['51.0.0'])
	assert.equal(again.minimumKernel, previous.minimumKernel)
	assert.equal(again.expiresAt, '2026-12-03T10:00:00Z')
	assert.ok(again.sequence > previous.sequence)
	assert.throws(() => reissueManifest({ previous, issuedAt: T0 }), /not higher/)
	assert.throws(
		() => reissueManifest({ previous, issuedAt: '2026-11-01T00:00:00Z' }),
		/never goes down/,
	)
	assert.throws(
		() => reissueManifest({ previous, issuedAt: '2026-11-19T10:00:00Z', floor: '51.0.5' }),
		/never lowered/,
	)
	assert.equal(
		reissueManifest({ previous, issuedAt: '2026-11-19T10:00:00Z', floor: '51.3.0' }).minimumKernel,
		'51.3.0',
	)
	assert.deepEqual(
		reissueManifest({ previous, issuedAt: '2026-11-19T10:00:00Z', withdraw: ['51.1.0'] }).withdrawn,
		['51.0.0', '51.1.0'],
	)
	assert.throws(
		() => reissueManifest({ previous, issuedAt: '2026-11-19T10:00:00Z', withdraw: ['51.3.0'] }),
		/withdrawn list/,
	)
	assert.throws(() => reissueManifest({ issuedAt: T0 }), /previous manifest/)
})

test('the lifetime defaults to 14 days and must be positive', () => {
	assert.equal(first({ lifetimeDays: 3 }).expiresAt, '2026-11-15T10:00:00Z')
	assert.throws(() => first({ lifetimeDays: 0 }), /lifetime/)
})

test('a strict parse refuses unknown or missing fields at every level, bad times and bad shapes', () => {
	const good = JSON.parse(manifestBytes(first()))
	const clone = () => JSON.parse(JSON.stringify(good))
	const bad = (mutate, pattern) => {
		const m = clone()
		mutate(m)
		assert.throws(() => parseManifest(JSON.stringify(m)), pattern)
	}
	bad((m) => {
		m.extra = 1
	}, /fields/)
	bad((m) => {
		m.withdrawn = undefined
	}, /fields/)
	bad((m) => {
		m.kernel.extra = 1
	}, /kernel has the fields/)
	bad((m) => {
		m.kernel.bundles['win32-x64'].extra = 1
	}, /bundle win32-x64 has the fields/)
	bad((m) => {
		m.schema = 2
	}, /schema/)
	bad((m) => {
		m.sequence = 1.5
	}, /sequence/)
	bad((m) => {
		m.issuedAt = '2026-11-12 10:00:00'
	}, /issuedAt/)
	bad((m) => {
		m.expiresAt = m.issuedAt
	}, /expires before/)
	bad((m) => {
		m.kernel.bundles['win32-x64'].file = '../x.tar.gz'
	}, /bare file name/)
	bad((m) => {
		m.kernel.bundles['win32-x64'].file = 'a/b.tar.gz'
	}, /bare file name/)
	bad((m) => {
		m.kernel.bundles['win32-x64'].sha512 = 'zz'
	}, /128 hex/)
	bad((m) => {
		m.kernel.bundles = {}
	}, /no bundles/)
	bad((m) => {
		m.kernel.bundles['plan9-x64'] = m.kernel.bundles['win32-x64']
	}, /platform/)
	bad((m) => {
		m.minimumKernel = '99.0.0'
	}, /above the kernel/)
	bad((m) => {
		m.withdrawn = ['1.0.0', '1.0.0']
	}, /twice/)
	assert.throws(() => parseManifest('not json'), /not valid JSON/)
	// One reading only: a repeated key (the last one wins in JSON.parse) and a different layout are refused.
	const text = manifestBytes(first()).toString()
	assert.throws(
		() => parseManifest(text.replace('"schema": 1,', '"schema": 2,\n  "schema": 1,')),
		/exact form/,
	)
	assert.throws(() => parseManifest(JSON.stringify(JSON.parse(text))), /exact form/)
	assert.throws(() => parseManifest(text.trimEnd()), /exact form/)
})

// --- the logic of the workflow ---------------------------------------------------------------------------

test('decide: builds only when newer than the manifest AND on the registry; quiet otherwise', () => {
	const previous = first()
	const base = {
		event: 'workflow_run',
		localVersion: '51.4.0',
		onRegistry: true,
		keyCount: 1,
		previous,
	}
	assert.equal(decide(base).mode, 'build')
	assert.equal(decide({ ...base, onRegistry: false }).mode, 'none')
	assert.match(decide({ ...base, onRegistry: false }).reason, /not on the registry/)
	assert.equal(decide({ ...base, localVersion: '51.3.0' }).mode, 'none')
	assert.equal(decide({ ...base, localVersion: '51.2.0' }).mode, 'none')
	assert.equal(decide({ ...base, previous: undefined }).mode, 'build')
	assert.equal(decide({ ...base, keyCount: 0 }).mode, 'none')
	assert.match(decide({ ...base, keyCount: 0 }).reason, /no public key/)
	assert.equal(decide({ ...base, localVersion: 'x' }).mode, 'none')
})

test('decide: either proof of publication is enough; neither ends quietly', () => {
	const base = {
		event: 'workflow_run',
		localVersion: '51.4.0',
		onRegistry: false,
		tagPublished: false,
		keyCount: 1,
		previous: first(),
	}
	const tagOnly = decide({ ...base, tagPublished: true })
	assert.equal(tagOnly.mode, 'build')
	assert.match(tagOnly.reason, /release tag on main/)
	const registryOnly = decide({ ...base, onRegistry: true })
	assert.equal(registryOnly.mode, 'build')
	assert.match(registryOnly.reason, /is on the registry/)
	assert.equal(decide({ ...base, onRegistry: true, tagPublished: true }).mode, 'build')
	const neither = decide(base)
	assert.equal(neither.mode, 'none')
	assert.match(neither.reason, /not on the registry yet and has no release tag on main/)
	// A proof does not weaken the other checks.
	assert.equal(decide({ ...base, tagPublished: true, keyCount: 0 }).mode, 'none')
	assert.equal(decide({ ...base, tagPublished: true, localVersion: '51.3.0' }).mode, 'none')
	assert.equal(decide({ ...base, tagPublished: true, localVersion: 'x' }).mode, 'none')
})

test('tagCommit: only the exact tag of this version counts', () => {
	const a = 'a'.repeat(40)
	const b = 'b'.repeat(40)
	const c = 'c'.repeat(40)
	assert.equal(tagCommit(`${a}\trefs/tags/@namzu/cli@51.4.0\n`, '51.4.0'), a)
	// another version, a longer version, another package, a branch of that name
	const others = [
		`${a}\trefs/tags/@namzu/cli@51.3.0`,
		`${a}\trefs/tags/@namzu/cli@51.4.01`,
		`${a}\trefs/tags/@namzu/cli@51.4.0-rc.1`,
		`${a}\trefs/tags/@namzu/sdk@51.4.0`,
		`${a}\trefs/heads/@namzu/cli@51.4.0`,
		'',
	].join('\n')
	assert.equal(tagCommit(others, '51.4.0'), '')
	// an annotated tag lists the commit it wraps after the tag object
	assert.equal(
		tagCommit(
			`${b}\trefs/tags/@namzu/cli@51.4.0\n${c}\trefs/tags/@namzu/cli@51.4.0^{}\n`,
			'51.4.0',
		),
		c,
	)
	assert.equal(tagCommit('not a line\nzzz refs/tags/@namzu/cli@51.4.0', '51.4.0'), '')
})

test('waitForRegistry: the long wait runs on an injected clock, never real time', async () => {
	let clock = 0
	let asked = 0
	const sleeps = []
	const run = (answerAt, totalMs) => {
		clock = 0
		asked = 0
		sleeps.length = 0
		return waitForRegistry({
			ask: async () => {
				asked += 1
				return clock >= answerAt
			},
			sleep: async (ms) => {
				sleeps.push(ms)
				clock += ms
			},
			now: () => clock,
			totalMs,
			intervalMs: 60_000,
		})
	}
	// answers after the old three-minute budget, inside the new one
	assert.equal(await run(13 * 60_000, 25 * 60_000), true)
	assert.equal(asked, 14)
	assert.ok(sleeps.every((ms) => ms === 60_000))
	// never answers: gives up once the budget is spent, and does not sleep past it
	assert.equal(await run(Number.POSITIVE_INFINITY, 25 * 60_000), false)
	assert.equal(asked, 26)
	assert.equal(clock, 25 * 60_000)
	// no budget: one question, no sleep
	assert.equal(await run(Number.POSITIVE_INFINITY, 0), false)
	assert.equal(asked, 1)
	assert.deepEqual(sleeps, [])
})

test('decide: the weekly run and a manual run renew the current manifest when there is nothing to build', () => {
	const previous = first()
	const base = { localVersion: '51.3.0', onRegistry: true, keyCount: 1, previous }
	assert.equal(decide({ ...base, event: 'schedule' }).mode, 'reissue')
	assert.equal(decide({ ...base, event: 'workflow_dispatch' }).mode, 'reissue')
	assert.equal(decide({ ...base, event: 'workflow_dispatch', hasChange: true }).mode, 'reissue')
	assert.equal(decide({ ...base, event: 'workflow_run' }).mode, 'none')
	assert.equal(
		decide({
			...base,
			event: 'schedule',
			previous: undefined,
			localVersion: '51.3.0',
			onRegistry: false,
		}).mode,
		'none',
	)
	assert.equal(decide({ ...base, event: 'schedule', localVersion: '51.9.0' }).mode, 'build')
})

test('prune: keeps the two newest versions and the one being published, removes older archives only', () => {
	const names = [
		'kernel-latest.json',
		'kernel-latest.json.sig',
		'namzu-kernel-51.1.0-win32-x64.tar.gz',
		'namzu-kernel-51.2.0-win32-x64.tar.gz',
		'namzu-kernel-51.2.0-linux-x64.tar.gz',
		'namzu-kernel-51.10.0-win32-x64.tar.gz',
		'namzu-kernel-51.3.0-win32-x64.tar.gz',
		'unrelated.txt',
	]
	assert.deepEqual(
		pruneList(names, '51.10.0').sort(),
		[
			'namzu-kernel-51.1.0-win32-x64.tar.gz',
			'namzu-kernel-51.2.0-linux-x64.tar.gz',
			'namzu-kernel-51.2.0-win32-x64.tar.gz',
		].sort(),
	)
	assert.deepEqual(pruneList(names, '51.1.0').sort(), [
		'namzu-kernel-51.2.0-linux-x64.tar.gz',
		'namzu-kernel-51.2.0-win32-x64.tar.gz',
	])
	assert.deepEqual(pruneList(['kernel-latest.json'], '1.0.0'), [])
})

test('upload-plan: an archive no published manifest names is replaced; one a manifest names is never', () => {
	const published = first()
	const named = published.kernel.bundles['win32-x64'].file
	assert.equal(named, 'namzu-kernel-51.3.0-win32-x64.tar.gz')
	const other = 'namzu-kernel-51.4.0-win32-x64.tar.gz'
	const assets = ['kernel-latest.json', 'kernel-latest.json.sig', named, other]

	// Not on the release yet.
	assert.equal(
		archiveUploadAction({
			name: 'namzu-kernel-51.5.0-win32-x64.tar.gz',
			assets,
			manifests: [published],
		}).action,
		'upload',
	)
	// On the release and named by the published manifest: refused, with what to do.
	const refused = archiveUploadAction({ name: named, assets, manifests: [published] })
	assert.equal(refused.action, 'refuse')
	assert.match(refused.reason, /bump the version/)
	// On the release, named by nothing published: the leftover of an upload cut before the signed pair.
	const replaced = archiveUploadAction({ name: other, assets, manifests: [published] })
	assert.equal(replaced.action, 'replace')
	assert.match(replaced.reason, /no published manifest names it/)
	// With no published manifest at all (a first release cut after the archive), the leftover is replaced too.
	assert.equal(archiveUploadAction({ name: other, assets, manifests: [] }).action, 'replace')
	assert.equal(archiveUploadAction({ name: other, assets }).action, 'replace')
	// Any manifest of the list counts, and a bundle of another platform counts.
	const two = assembleManifest({
		entries: [entry('win32-x64'), entry('linux-x64')],
		issuedAt: T0,
		floor: '51.1.0',
	})
	assert.equal(
		archiveUploadAction({
			name: 'namzu-kernel-51.3.0-linux-x64.tar.gz',
			assets: ['namzu-kernel-51.3.0-linux-x64.tar.gz'],
			manifests: [published, two],
		}).action,
		'refuse',
	)
	// A name that is not an archive is never uploaded.
	assert.equal(archiveUploadAction({ name: '../x.tar.gz', assets, manifests: [] }).action, 'refuse')
	// Running it twice gives the same answer.
	assert.deepEqual(
		archiveUploadAction({ name: other, assets, manifests: [published] }),
		archiveUploadAction({ name: other, assets, manifests: [published] }),
	)
})

test('upload-plan: the command prints the action and the reason, and refuses a manifest it cannot read', async () => {
	const { execFileSync, spawnSync } = await import('node:child_process')
	const { mkdtempSync, writeFileSync } = await import('node:fs')
	const { tmpdir } = await import('node:os')
	const { join } = await import('node:path')
	const dir = mkdtempSync(join(tmpdir(), 'namzu-plan-'))
	const published = first()
	writeFileSync(join(dir, 'kernel-latest.json'), manifestBytes(published))
	const named = published.kernel.bundles['win32-x64'].file
	writeFileSync(
		join(dir, 'assets.json'),
		JSON.stringify([named, 'namzu-kernel-51.4.0-win32-x64.tar.gz']),
	)
	const script = new URL('../kernel/release-plan.mjs', import.meta.url).pathname
	const run = (name) =>
		execFileSync(
			process.execPath,
			[
				script,
				'upload-plan',
				'--name',
				name,
				'--assets',
				join(dir, 'assets.json'),
				'--manifest',
				join(dir, 'kernel-latest.json'),
			],
			{ encoding: 'utf8' },
		)
	assert.match(run('namzu-kernel-51.4.0-win32-x64.tar.gz'), /^action=replace\nreason=/)
	assert.match(run('namzu-kernel-51.9.0-win32-x64.tar.gz'), /^action=upload\n/)
	assert.match(run(named), /^action=refuse\n/)
	writeFileSync(join(dir, 'bad.json'), '{}')
	const bad = spawnSync(
		process.execPath,
		[
			script,
			'upload-plan',
			'--name',
			named,
			'--assets',
			join(dir, 'assets.json'),
			'--manifest',
			join(dir, 'bad.json'),
		],
		{ encoding: 'utf8' },
	)
	assert.notEqual(bad.status, 0)
})
