import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { listAssets } from '../kernel/release-assets.mjs'
import { archiveUploadAction } from '../kernel/release-plan.mjs'

const ok = (stdout) => async () => ({ code: 0, stdout, stderr: '' })
const fails =
	(stderr, code = 1) =>
	async () => ({ code, stdout: '', stderr })

test('the names on the release are listed', async () => {
	assert.deepEqual(await listAssets('t', ok('a.tar.gz\nkernel-latest.json\n')), [
		'a.tar.gz',
		'kernel-latest.json',
	])
})

test('a release that does not exist yet has no assets', async () => {
	assert.deepEqual(await listAssets('t', fails('release not found')), [])
})

test('an API error is an error, never an empty release', async () => {
	for (const stderr of [
		'HTTP 502: Bad Gateway',
		'HTTP 403: API rate limit exceeded',
		'error connecting to api.github.com',
		'',
	])
		await assert.rejects(listAssets('t', fails(stderr)), /Not treating that as an empty release/)
})

test('why it matters: an empty list would let a published archive be replaced', () => {
	const published = {
		kernel: { bundles: { 'win32-x64': { file: 'namzu-kernel-51.3.0-win32-x64.tar.gz' } } },
	}
	const name = 'namzu-kernel-51.3.0-win32-x64.tar.gz'
	// The right assets and the right manifest: refused.
	assert.equal(
		archiveUploadAction({ name, assets: [name], manifests: [published] }).action,
		'refuse',
	)
	// A lost manifest with the archive still listed: replace. This is what the lister must never allow.
	assert.equal(archiveUploadAction({ name, assets: [name], manifests: [] }).action, 'replace')
})

test('the workflow lists assets through the lister and never swallows an error', () => {
	const text = readFileSync(
		new URL('../../../../.github/workflows/kernel-release.yml', import.meta.url),
		'utf8',
	)
	assert.equal((text.match(/release-assets\.mjs/g) ?? []).length, 2)
	assert.doesNotMatch(text, /gh release view[^\n]*assets[^\n]*\|\| true/)
})
