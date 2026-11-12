import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assembleManifest, manifestBytes, parseManifest, reissueManifest } from '../kernel/manifest.mjs'
import { decide, pruneList } from '../kernel/release-plan.mjs'

const hex = (c, n) => c.repeat(n)
const entry = (target, over = {}) => ({
	target,
	kernel: { commandLine: '51.3.0', engine: '62.14.0', desktopContract: 1, dataEpoch: 1, ...over.kernel },
	bundle: { file: 'ignored', size: 1234, sha512: hex('a', 128), filesSha512: hex('b', 128), fileCount: 10, unpackedSize: 5000, ...over.bundle },
})
const T0 = '2026-11-12T10:00:00Z'
const first = (over = {}) => assembleManifest({ entries: [entry('win32-x64')], issuedAt: T0, floor: '51.1.0', ...over })

test('a first manifest has the shape of the text, in the text order, with the file name made from the version', () => {
	const m = first()
	assert.equal(m.sequence, Date.parse(T0) / 1000)
	assert.equal(m.issuedAt, T0)
	assert.equal(m.expiresAt, '2026-11-26T10:00:00Z')
	assert.equal(m.minimumKernel, '51.1.0')
	assert.deepEqual(m.withdrawn, [])
	assert.equal(m.kernel.bundles['win32-x64'].file, 'namzu-kernel-51.3.0-win32-x64.tar.gz')
	const text = manifestBytes(m).toString()
	assert.deepEqual(Object.keys(JSON.parse(text)), ['schema', 'channel', 'sequence', 'issuedAt', 'expiresAt', 'minimumKernel', 'withdrawn', 'kernel'])
	assert.deepEqual(Object.keys(JSON.parse(text).kernel.bundles['win32-x64']), ['file', 'size', 'sha512', 'filesSha512', 'fileCount', 'unpackedSize'])
	assert.ok(text.endsWith('}\n'))
	assert.deepEqual(manifestBytes(parseManifest(text)), manifestBytes(m))
})

test('a bundle entry cannot pick its own file name, and several entries share one kernel', () => {
	const m = assembleManifest({ entries: [entry('win32-x64', { bundle: { file: '../evil' } }), entry('linux-x64')], issuedAt: T0, floor: '51.1.0' })
	assert.equal(m.kernel.bundles['win32-x64'].file, 'namzu-kernel-51.3.0-win32-x64.tar.gz')
	assert.deepEqual(Object.keys(m.kernel.bundles), ['linux-x64', 'win32-x64'])
	assert.throws(() => assembleManifest({ entries: [entry('win32-x64'), entry('linux-x64', { kernel: { engine: '9.9.9' } })], issuedAt: T0, floor: '51.1.0' }), /disagree about engine/)
	assert.throws(() => assembleManifest({ entries: [entry('win32-x64'), entry('win32-x64')], issuedAt: T0, floor: '51.1.0' }), /given twice/)
})

test('the floor defaults to the previous one, or to the kernel itself on a first manifest; never lowered; never above the kernel', () => {
	assert.equal(assembleManifest({ entries: [entry('win32-x64')], issuedAt: T0 }).minimumKernel, '51.3.0')
	const previous = first({ floor: '51.2.0' })
	const next = assembleManifest({ entries: [entry('win32-x64', { kernel: { commandLine: '51.4.0' } })], issuedAt: '2026-11-13T10:00:00Z', previous })
	assert.equal(next.minimumKernel, '51.2.0')
	assert.throws(() => assembleManifest({ entries: [entry('win32-x64', { kernel: { commandLine: '51.4.0' } })], issuedAt: '2026-11-13T10:00:00Z', previous, floor: '51.1.0' }), /never lowered/)
	assert.throws(() => first({ floor: '52.0.0' }), /above the kernel/)
	assert.equal(assembleManifest({ entries: [entry('win32-x64', { kernel: { commandLine: '51.4.0' } })], issuedAt: '2026-11-13T10:00:00Z', previous, floor: '51.3.0' }).minimumKernel, '51.3.0')
})

test('a sequence that would go down is refused; equal is allowed for a new kernel only through the version rule', () => {
	const previous = first()
	const e = entry('win32-x64', { kernel: { commandLine: '51.4.0' } })
	assert.throws(() => assembleManifest({ entries: [e], issuedAt: '2026-11-12T09:59:59Z', previous }), /sequence .* is lower than the previous/)
	assert.equal(assembleManifest({ entries: [e], issuedAt: '2026-11-12T10:00:01Z', previous }).sequence, previous.sequence + 1)
})

test('the kernel version never goes down, and the same version is a re-issue, not a new manifest', () => {
	const previous = first()
	const at = '2026-11-13T10:00:00Z'
	assert.throws(() => assembleManifest({ entries: [entry('win32-x64', { kernel: { commandLine: '51.2.9' } })], issuedAt: at, previous }), /older than/)
	assert.throws(() => assembleManifest({ entries: [entry('win32-x64')], issuedAt: at, previous }), /use reissue/)
	assert.throws(() => assembleManifest({ entries: [entry('win32-x64')], issuedAt: at, previous, channel: 'beta' }), /channel/)
})

test('the withdrawn list is kept unless told to change, and the kernel offered cannot be on it', () => {
	const a = first({ withdraw: ['51.0.0'] })
	assert.deepEqual(a.withdrawn, ['51.0.0'])
	const e = entry('win32-x64', { kernel: { commandLine: '51.4.0' } })
	const b = assembleManifest({ entries: [e], issuedAt: '2026-11-13T10:00:00Z', previous: a })
	assert.deepEqual(b.withdrawn, ['51.0.0'])
	const c = assembleManifest({ entries: [e], issuedAt: '2026-11-13T10:00:00Z', previous: a, withdraw: ['51.2.0', '50.0.0'], unwithdraw: ['51.0.0'] })
	assert.deepEqual(c.withdrawn, ['50.0.0', '51.2.0'])
	assert.throws(() => assembleManifest({ entries: [e], issuedAt: '2026-11-13T10:00:00Z', previous: a, withdraw: ['51.4.0'] }), /withdrawn list/)
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
	assert.throws(() => reissueManifest({ previous, issuedAt: '2026-11-01T00:00:00Z' }), /never goes down/)
	assert.throws(() => reissueManifest({ previous, issuedAt: '2026-11-19T10:00:00Z', floor: '51.0.5' }), /never lowered/)
	assert.equal(reissueManifest({ previous, issuedAt: '2026-11-19T10:00:00Z', floor: '51.3.0' }).minimumKernel, '51.3.0')
	assert.deepEqual(reissueManifest({ previous, issuedAt: '2026-11-19T10:00:00Z', withdraw: ['51.1.0'] }).withdrawn, ['51.0.0', '51.1.0'])
	assert.throws(() => reissueManifest({ previous, issuedAt: '2026-11-19T10:00:00Z', withdraw: ['51.3.0'] }), /withdrawn list/)
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
	bad((m) => { m.extra = 1 }, /fields/)
	bad((m) => { m.withdrawn = undefined }, /fields/)
	bad((m) => { m.kernel.extra = 1 }, /kernel has the fields/)
	bad((m) => { m.kernel.bundles['win32-x64'].extra = 1 }, /bundle win32-x64 has the fields/)
	bad((m) => { m.schema = 2 }, /schema/)
	bad((m) => { m.sequence = 1.5 }, /sequence/)
	bad((m) => { m.issuedAt = '2026-11-12 10:00:00' }, /issuedAt/)
	bad((m) => { m.expiresAt = m.issuedAt }, /expires before/)
	bad((m) => { m.kernel.bundles['win32-x64'].file = '../x.tar.gz' }, /bare file name/)
	bad((m) => { m.kernel.bundles['win32-x64'].file = 'a/b.tar.gz' }, /bare file name/)
	bad((m) => { m.kernel.bundles['win32-x64'].sha512 = 'zz' }, /128 hex/)
	bad((m) => { m.kernel.bundles = {} }, /no bundles/)
	bad((m) => { m.kernel.bundles['plan9-x64'] = m.kernel.bundles['win32-x64'] }, /platform/)
	bad((m) => { m.minimumKernel = '99.0.0' }, /above the kernel/)
	bad((m) => { m.withdrawn = ['1.0.0', '1.0.0'] }, /twice/)
	assert.throws(() => parseManifest('not json'), /not valid JSON/)
})

// --- the logic of the workflow ---------------------------------------------------------------------------

test('decide: builds only when newer than the manifest AND on the registry; quiet otherwise', () => {
	const previous = first()
	const base = { event: 'workflow_run', localVersion: '51.4.0', onRegistry: true, keyCount: 1, previous }
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

test('decide: the weekly run and a manual run renew the current manifest when there is nothing to build', () => {
	const previous = first()
	const base = { localVersion: '51.3.0', onRegistry: true, keyCount: 1, previous }
	assert.equal(decide({ ...base, event: 'schedule' }).mode, 'reissue')
	assert.equal(decide({ ...base, event: 'workflow_dispatch' }).mode, 'reissue')
	assert.equal(decide({ ...base, event: 'workflow_dispatch', hasChange: true }).mode, 'reissue')
	assert.equal(decide({ ...base, event: 'workflow_run' }).mode, 'none')
	assert.equal(decide({ ...base, event: 'schedule', previous: undefined, localVersion: '51.3.0', onRegistry: false }).mode, 'none')
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
	assert.deepEqual(pruneList(names, '51.10.0').sort(), ['namzu-kernel-51.1.0-win32-x64.tar.gz', 'namzu-kernel-51.2.0-linux-x64.tar.gz', 'namzu-kernel-51.2.0-win32-x64.tar.gz'].sort())
	assert.deepEqual(pruneList(names, '51.1.0').sort(), ['namzu-kernel-51.2.0-linux-x64.tar.gz', 'namzu-kernel-51.2.0-win32-x64.tar.gz'])
	assert.deepEqual(pruneList(['kernel-latest.json'], '1.0.0'), [])
})
