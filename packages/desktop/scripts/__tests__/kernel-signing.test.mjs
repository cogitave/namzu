import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createPrivateKey } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { writeArchive } from '../kernel/archive-writer.mjs'
import { assembleManifest, manifestBytes, parseManifest } from '../kernel/manifest.mjs'
import { packKernel } from '../kernel/pack.mjs'
import {
	SigningError,
	keyIdFor,
	makeKeyPair,
	parseKeyList,
	privateKeyFromText,
	signManifest,
	verifySignature,
} from '../kernel/signing.mjs'
import { describeArchive, verifyRelease } from '../kernel/verify.mjs'
import { goodManifest, makePairKey, pairCases, publicOnly, signedPair } from './kernel-cases.mjs'
import { smallKernelFiles, tempDir, writeTree } from './kernel-helpers.mjs'

const scripts = join(fileURLToPath(new URL('../kernel/', import.meta.url)))
const NOW = Date.parse('2026-11-12T12:00:00Z')

function pair(id = 'k1') {
	const made = makeKeyPair(id)
	return { ...made, list: parseKeyList(JSON.stringify([made.entry])) }
}

test('a signature verifies under its key; a wrong key, a changed byte and an empty list are refused', () => {
	const a = pair('k1')
	const b = pair('k2')
	const bytes = Buffer.from('{"manifest":"bytes"}\n')
	const sig = signManifest(bytes, privateKeyFromText(a.privatePem), 'k1')
	assert.deepEqual(verifySignature(bytes, sig, a.list), { keyId: 'k1' })
	assert.throws(
		() =>
			verifySignature(
				bytes,
				sig,
				parseKeyList(JSON.stringify([{ id: 'k1', publicKey: b.entry.publicKey }])),
			),
		/does not match/,
	)
	assert.throws(() => verifySignature(bytes, sig, b.list), /not in the public key list/)
	const changed = Buffer.from(bytes)
	changed[3] ^= 1
	assert.throws(() => verifySignature(changed, sig, a.list), /does not match/)
	assert.throws(() => verifySignature(bytes, sig, []), /list is empty/)
	// Two keys listed: either verifies, by id.
	const both = parseKeyList(JSON.stringify([a.entry, b.entry]))
	assert.equal(
		verifySignature(bytes, signManifest(bytes, privateKeyFromText(b.privatePem), 'k2'), both).keyId,
		'k2',
	)
	assert.equal(keyIdFor(privateKeyFromText(b.privatePem), both), 'k2')
	// Naming the other key's id does not help a signature made with this one.
	assert.throws(
		() => verifySignature(bytes, signManifest(bytes, privateKeyFromText(b.privatePem), 'k1'), both),
		/does not match/,
	)
})

test('the signature file has exactly the fields of the text, and a malformed one is refused', () => {
	const a = pair()
	const bytes = Buffer.from('x')
	const value = JSON.parse(signManifest(bytes, privateKeyFromText(a.privatePem), 'k1'))
	assert.deepEqual(Object.keys(value), ['schema', 'keyId', 'algorithm', 'signature'])
	assert.equal(value.algorithm, 'ed25519')
	assert.equal(Buffer.from(value.signature, 'base64').length, 64)
	for (const broken of [
		{ ...value, algorithm: 'rsa' },
		{ ...value, extra: 1 },
		{ ...value, schema: 2 },
		{ ...value, signature: 'AAAA' },
	])
		assert.throws(
			() => verifySignature(bytes, Buffer.from(JSON.stringify(broken)), a.list),
			SigningError,
		)
	assert.throws(() => verifySignature(bytes, Buffer.from('nope'), a.list), /not valid JSON/)
})

test('the signing key is accepted as a PEM or as base64 of the PEM, and nothing else', () => {
	const { privatePem } = pair()
	assert.equal(privateKeyFromText(privatePem).asymmetricKeyType, 'ed25519')
	assert.equal(
		privateKeyFromText(Buffer.from(privatePem).toString('base64')).asymmetricKeyType,
		'ed25519',
	)
	assert.throws(() => privateKeyFromText(''), /empty or not set/)
	assert.throws(() => privateKeyFromText('hunter2-not-a-key'), /not a PKCS#8 private key/)
})

test('the public key list is a JSON array of { id, publicKey } with 32-byte keys, ids unique', () => {
	const a = pair()
	assert.equal(Buffer.from(a.entry.publicKey, 'base64').length, 32)
	assert.deepEqual(parseKeyList('[]'), [])
	assert.throws(() => parseKeyList('{}'), /JSON array/)
	assert.throws(() => parseKeyList(JSON.stringify([{ id: 'k1', publicKey: 'AAAA' }])), /32 bytes/)
	assert.throws(
		() => parseKeyList(JSON.stringify([{ id: 'k1', publicKey: a.entry.publicKey, more: 1 }])),
		/not \{ "id", "publicKey" \}/,
	)
	assert.throws(() => parseKeyList(JSON.stringify([a.entry, a.entry])), /twice/)
})

test('the committed key list is valid and lists the first public key', () => {
	const text = readFileSync(
		fileURLToPath(new URL('../../kernel-keys.json', import.meta.url)),
		'utf8',
	)
	assert.deepEqual(
		parseKeyList(text).map(({ id }) => id),
		['k1'],
	)
})

// --- a whole release over a real small folder ------------------------------------------------------------

async function release(overrides = {}) {
	const kernel = tempDir('kernel-src')
	writeTree(kernel, smallKernelFiles())
	const out = tempDir('kernel-rel')
	const packed = await packKernel({ kernelDir: kernel, outDir: out })
	const manifest = assembleManifest({
		entries: [packed.entry],
		issuedAt: '2026-11-12T10:00:00Z',
		floor: '1.0.0',
		...overrides,
	})
	const manifestPath = join(out, 'kernel-latest.json')
	writeFileSync(manifestPath, manifestBytes(manifest))
	const keys = pair()
	const keysPath = join(out, 'keys.json')
	writeFileSync(keysPath, JSON.stringify([keys.entry]))
	const signaturePath = `${manifestPath}.sig`
	writeFileSync(
		signaturePath,
		signManifest(readFileSync(manifestPath), privateKeyFromText(keys.privatePem), 'k1'),
	)
	return { out, packed, manifest, manifestPath, signaturePath, keysPath, keys }
}

test('verify: a manifest, its signature and its archive agree', async () => {
	const r = await release()
	const checked = await verifyRelease({
		manifestPath: r.manifestPath,
		signaturePath: r.signaturePath,
		keysPath: r.keysPath,
		archivePath: r.packed.archive,
		now: NOW,
	})
	assert.equal(checked.length, 4)
	assert.match(checked[3], /sha512 matches/)
	const described = await describeArchive(r.packed.archive)
	assert.deepEqual(described.bundle, {
		size: r.packed.entry.bundle.size,
		sha512: r.packed.entry.bundle.sha512,
		filesSha512: r.packed.entry.bundle.filesSha512,
		fileCount: r.packed.entry.bundle.fileCount,
		unpackedSize: r.packed.entry.bundle.unpackedSize,
	})
})

test('verify refuses: expired, issued in the future, empty key list, wrong key, changed manifest byte, changed archive byte, wrong archive name', async () => {
	const r = await release()
	const args = {
		manifestPath: r.manifestPath,
		signaturePath: r.signaturePath,
		keysPath: r.keysPath,
		archivePath: r.packed.archive,
		now: NOW,
	}
	await assert.rejects(
		verifyRelease({ ...args, now: Date.parse('2026-12-01T00:00:00Z') }),
		/expired/,
	)
	await verifyRelease({ ...args, now: Date.parse('2026-12-01T00:00:00Z'), allowExpired: true })
	await assert.rejects(
		verifyRelease({ ...args, now: Date.parse('2026-10-01T00:00:00Z') }),
		/future/,
	)
	const empty = join(r.out, 'empty.json')
	writeFileSync(empty, '[]')
	await assert.rejects(verifyRelease({ ...args, keysPath: empty }), /list is empty/)
	const other = join(r.out, 'other.json')
	writeFileSync(other, JSON.stringify([{ id: 'k1', publicKey: makeKeyPair('k1').entry.publicKey }]))
	await assert.rejects(verifyRelease({ ...args, keysPath: other }), /does not match/)
	const tampered = join(r.out, 'tampered.json')
	const bytes = Buffer.from(readFileSync(r.manifestPath))
	bytes[bytes.indexOf('"sequence"') + 12] ^= 1
	writeFileSync(tampered, bytes)
	writeFileSync(`${tampered}.sig`, readFileSync(r.signaturePath))
	await assert.rejects(
		verifyRelease({ ...args, manifestPath: tampered, signaturePath: `${tampered}.sig` }),
		/does not match/,
	)
	const bad = join(r.out, 'namzu-kernel-1.2.3-win32-x64.tar.gz')
	const archiveBytes = Buffer.from(readFileSync(r.packed.archive))
	archiveBytes[archiveBytes.length - 40] ^= 1
	writeFileSync(bad, archiveBytes)
	await assert.rejects(verifyRelease({ ...args, archivePath: bad }), /sha512|gzip|sha256/)
	const renamed = join(r.out, 'renamed.tar.gz')
	writeFileSync(renamed, readFileSync(r.packed.archive))
	await assert.rejects(verifyRelease({ ...args, archivePath: renamed }), /no bundle named/)
})

test('verify refuses an archive whose kernel.json disagrees with the manifest, and one that is not the size the manifest states', async () => {
	const r = await release()
	const args = {
		manifestPath: r.manifestPath,
		signaturePath: r.signaturePath,
		keysPath: r.keysPath,
		now: NOW,
	}
	// A kernel whose kernel.json says another engine, packed under the same name, signed with the manifest of the first.
	const other = tempDir('kernel-src2')
	writeTree(
		other,
		smallKernelFiles({
			'kernel.json': `${JSON.stringify({ schema: 1, commandLine: '1.2.3', engine: '9.9.9', desktopContract: 1, dataEpoch: 1, platform: 'win32', arch: 'x64' })}\n`,
		}),
	)
	const otherOut = tempDir('kernel-rel2')
	const packed = await packKernel({ kernelDir: other, outDir: otherOut })
	const m2 = assembleManifest({
		entries: [packed.entry],
		issuedAt: '2026-11-12T10:00:00Z',
		floor: '1.0.0',
	})
	// Same name, so the bundle is found; make the manifest claim the first kernel's engine but this archive's hashes.
	const forged = { ...m2, kernel: { ...m2.kernel, engine: '4.5.6' } }
	const path = join(otherOut, 'kernel-latest.json')
	writeFileSync(path, manifestBytes(forged))
	writeFileSync(
		`${path}.sig`,
		signManifest(readFileSync(path), privateKeyFromText(r.keys.privatePem), 'k1'),
	)
	await assert.rejects(
		verifyRelease({
			...args,
			manifestPath: path,
			signaturePath: `${path}.sig`,
			archivePath: packed.archive,
		}),
		/kernel\.json engine 9\.9\.9; the manifest says 4\.5\.6/,
	)
	const small = join(r.out, 'grown', r.packed.entry.bundle.file)
	mkdirSync(join(r.out, 'grown'))
	writeFileSync(small, Buffer.concat([readFileSync(r.packed.archive), Buffer.from('x')]))
	await assert.rejects(verifyRelease({ ...args, archivePath: small }), /bytes; the manifest says/)
})

test('verify refuses an archive with more files or bytes than its manifest bundle states', async () => {
	const r = await release()
	const lying = {
		...r.manifest,
		kernel: {
			...r.manifest.kernel,
			bundles: { 'win32-x64': { ...r.manifest.kernel.bundles['win32-x64'], fileCount: 2 } },
		},
	}
	const path = join(r.out, 'lying.json')
	writeFileSync(path, manifestBytes(lying))
	writeFileSync(
		`${path}.sig`,
		signManifest(readFileSync(path), privateKeyFromText(r.keys.privatePem), 'k1'),
	)
	await assert.rejects(
		verifyRelease({
			manifestPath: path,
			signaturePath: `${path}.sig`,
			keysPath: r.keysPath,
			archivePath: r.packed.archive,
			now: NOW,
		}),
		/allows 2/,
	)
})

// --- the private key never leaves the process ------------------------------------------------------------

function everythingUnder(root) {
	const found = []
	const visit = (dir) => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name)
			if (statSync(path).isDirectory()) visit(path)
			else found.push(path)
		}
	}
	visit(root)
	return found
}

function run(script, args, { env = {}, cwd } = {}) {
	return spawnSync(process.execPath, [join(scripts, script), ...args], {
		cwd,
		env: { PATH: process.env.PATH, HOME: cwd, ...env },
		encoding: 'utf8',
	})
}

test('the key never appears in anything a command prints or writes, on success or on failure', async () => {
	const keys = pair()
	const der = createPrivateKey(keys.privatePem)
		.export({ format: 'der', type: 'pkcs8' })
		.toString('base64')
	const body = keys.privatePem.replace(/-----[A-Z ]+-----|\s/g, '')
	assert.equal(body, der)
	const secrets = [
		keys.privatePem.trim(),
		body,
		Buffer.from(keys.privatePem).toString('base64'),
		body.slice(16, 48),
	]
	const r = await release()
	const work = tempDir('kernel-leak')
	const keysPath = join(work, 'keys.json')
	writeFileSync(keysPath, JSON.stringify([keys.entry]))
	const manifest = join(work, 'kernel-latest.json')
	writeFileSync(manifest, readFileSync(r.manifestPath))
	const outputs = []
	const keep = (result) => {
		outputs.push(result.stdout, result.stderr)
		return result
	}
	for (const form of [keys.privatePem, Buffer.from(keys.privatePem).toString('base64')]) {
		const env = { NAMZU_KERNEL_SIGNING_KEY: form }
		assert.equal(
			keep(run('sign.mjs', [manifest, '--keys', keysPath], { env, cwd: work })).status,
			0,
		)
		assert.equal(
			keep(
				run(
					'verify.mjs',
					[
						'--manifest',
						manifest,
						'--sig',
						`${manifest}.sig`,
						'--keys',
						keysPath,
						'--archive',
						r.packed.archive,
						'--now',
						'2026-11-12T12:00:00Z',
					],
					{ env, cwd: work },
				),
			).status,
			0,
		)
		assert.equal(
			keep(
				run(
					'assemble-manifest.mjs',
					[
						'--out',
						join(work, 'm2.json'),
						'--reissue',
						manifest,
						'--issued-at',
						'2026-11-19T10:00:00Z',
					],
					{ env, cwd: work },
				),
			).status,
			0,
		)
	}
	// Failures: a key that is not listed, a corrupt key, a key of the wrong kind, an unset key.
	const stranger = pair()
	const failures = [
		run('sign.mjs', [manifest, '--keys', keysPath], {
			env: { NAMZU_KERNEL_SIGNING_KEY: stranger.privatePem },
			cwd: work,
		}),
		run('sign.mjs', [manifest, '--keys', keysPath], {
			env: { NAMZU_KERNEL_SIGNING_KEY: `${keys.privatePem.slice(0, 80)}CORRUPTED` },
			cwd: work,
		}),
		run('sign.mjs', [manifest, '--keys', keysPath], {
			env: { NAMZU_KERNEL_SIGNING_KEY: 'plainly-secret-value-1234567890' },
			cwd: work,
		}),
		run('sign.mjs', [manifest, '--keys', join(work, 'missing.json')], {
			env: { NAMZU_KERNEL_SIGNING_KEY: keys.privatePem },
			cwd: work,
		}),
		run('sign.mjs', [manifest, '--key-id', 'bad id!'], {
			env: { NAMZU_KERNEL_SIGNING_KEY: keys.privatePem },
			cwd: work,
		}),
		run('sign.mjs', [manifest], { cwd: work }),
	]
	for (const result of failures) {
		assert.equal(keep(result).status, 1)
		assert.ok(result.stderr.length > 0)
	}
	secrets.push('plainly-secret-value-1234567890')
	for (const output of outputs)
		for (const secret of secrets)
			assert.equal(output.includes(secret), false, 'a command printed the key')
	for (const file of everythingUnder(work)) {
		const content = readFileSync(file, 'latin1')
		for (const secret of secrets)
			assert.equal(content.includes(secret), false, `${file} holds the key`)
	}
})

test('key: the public entry by default; --private writes only the PEM to standard output and no file', () => {
	const cwd = tempDir('kernel-key')
	const shown = run('key.mjs', ['--id', 'k7'], { cwd })
	assert.equal(shown.status, 0)
	const entry = JSON.parse(shown.stdout)
	assert.deepEqual(Object.keys(entry), ['id', 'publicKey'])
	assert.equal(entry.id, 'k7')
	assert.equal(Buffer.from(entry.publicKey, 'base64').length, 32)
	assert.equal(shown.stdout.includes('PRIVATE'), false)
	assert.equal(shown.stderr.includes('PRIVATE'), false)
	const made = run('key.mjs', ['--id', 'k8', '--private'], { cwd })
	assert.equal(made.status, 0)
	assert.match(
		made.stdout,
		/^-----BEGIN PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+-----END PRIVATE KEY-----\n$/,
	)
	assert.equal(
		made.stderr.includes('PRIVATE'),
		false,
		'the public entry goes to standard error, the key never does',
	)
	const publicEntry = JSON.parse(made.stderr.split('kernel-keys.json: ')[1])
	assert.equal(publicEntry.id, 'k8')
	// The PEM printed is the private half of the entry printed.
	assert.equal(
		keyIdFor(privateKeyFromText(made.stdout), parseKeyList(JSON.stringify([publicEntry]))),
		'k8',
	)
	assert.deepEqual(readdirSync(cwd), [])
	assert.notEqual(run('key.mjs', ['--id', 'bad id'], { cwd }).status, 0)
})

test('the writer is not involved in a refusal: describeArchive of a pack made by writeArchive directly', async () => {
	const root = tempDir('kernel-src')
	writeTree(root, smallKernelFiles())
	const out = tempDir('kernel-out')
	await writeArchive({ root, archivePath: join(out, 'namzu-kernel-1.2.3-win32-x64.tar.gz') })
	const described = await describeArchive(join(out, 'namzu-kernel-1.2.3-win32-x64.tar.gz'))
	assert.equal(described.target, 'win32-x64')
	assert.equal(described.kernel.engine, '4.5.6')
})

test('every broken signed pair of the shared list (also run against the app) is refused, and the good one is not', () => {
	const key = makePairKey('k1')
	const other = makePairKey('k1')
	const good = signedPair(goodManifest(), key)
	const keys = parseKeyList(JSON.stringify([publicOnly(key)]))
	const check = (candidate) => {
		verifySignature(candidate.manifest, candidate.signature, keys)
		parseManifest(candidate.manifest)
	}
	check(good)
	const cases = pairCases()
	assert.ok(cases.length > 40)
	for (const testCase of cases)
		assert.throws(() => check(testCase.make({ key, other, good })), undefined, testCase.label)
})
