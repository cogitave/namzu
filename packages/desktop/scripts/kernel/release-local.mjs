// The whole release, locally, into an output folder, without publishing anything: stage, pack, manifest,
// sign (when NAMZU_KERNEL_SIGNING_KEY is set), verify. A person can run it and look at every file.
//
//   node scripts/kernel/release-local.mjs --out <dir> [--target win32-x64 ...] [--keys <kernel-keys.json>]
//        [--previous <manifest.json>] [--floor 51.1.0] [--withdraw <v> ...] [--unwithdraw <v> ...]
//        [--issued-at <ISO time>] [--lifetime-days 14] [--key-id <id>] [--keep-stage]
//
// <dir>/release/ holds what would be uploaded (the archives, kernel-latest.json and its .sig); <dir>/pack/
// holds the per-target files.json and bundle entries; <dir>/stage/ the staged folders (removed unless
// --keep-stage). Without a signing key in the environment it stops after the manifest and says so.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseTarget } from '../lean-cli.mjs'
import { isMain, parseFlags, runMain } from './cli.mjs'
import { assembleManifest, manifestBytes, parseManifest } from './manifest.mjs'
import { packKernel } from './pack.mjs'
import { signFile } from './sign.mjs'
import { DEFAULT_KEYS_FILE, SIGNING_KEY_ENV } from './signing.mjs'
import { targetName } from './stage-cli.mjs'
import { stageKernel } from './stage.mjs'
import { verifyRelease } from './verify.mjs'

async function timed(label, fn, log) {
	const started = process.hrtime.bigint()
	const value = await fn()
	log(`${label}: ${(Number(process.hrtime.bigint() - started) / 1e3 / 1e6).toFixed(1)} s`)
	return value
}

export async function releaseLocal({
	out,
	targets,
	keysPath = DEFAULT_KEYS_FILE,
	previousPath,
	floor,
	withdraw,
	unwithdraw,
	issuedAt,
	lifetimeDays,
	keyId,
	keepStage = false,
	env = process.env,
	log = console.log,
}) {
	const root = resolve(out)
	const release = join(root, 'release')
	rmSync(release, { recursive: true, force: true })
	mkdirSync(release, { recursive: true })
	const entries = []
	for (const target of targets) {
		const name = targetName(target)
		const stage = join(root, 'stage', name)
		await timed(`stage ${name}`, () => stageKernel({ out: stage, target, log }), log)
		const packed = await timed(
			`pack ${name}`,
			() => packKernel({ kernelDir: stage, outDir: join(root, 'pack', name) }),
			log,
		)
		log(
			`  ${packed.entry.bundle.file}: ${packed.entry.bundle.size} bytes, ${packed.entry.bundle.fileCount} files, ${packed.entry.bundle.unpackedSize} bytes unpacked`,
		)
		renameSync(packed.archive, join(release, packed.entry.bundle.file))
		entries.push({ ...packed.entry, archive: join(release, packed.entry.bundle.file) })
		if (!keepStage) rmSync(stage, { recursive: true, force: true })
	}
	const manifest = assembleManifest({
		entries,
		previous: previousPath ? parseManifest(readFileSync(previousPath)) : undefined,
		issuedAt: issuedAt ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
		lifetimeDays,
		floor,
		withdraw,
		unwithdraw,
	})
	const manifestPath = join(release, `kernel-${manifest.channel}.json`)
	writeFileSync(manifestPath, manifestBytes(manifest))
	log(
		`manifest: sequence ${manifest.sequence}, kernel ${manifest.kernel.commandLine}, floor ${manifest.minimumKernel}, expires ${manifest.expiresAt}`,
	)
	if (!env[SIGNING_KEY_ENV]) {
		log(
			`no signature: ${SIGNING_KEY_ENV} is not set, so the manifest is unsigned and nothing was verified against a key.`,
		)
		return { release, manifestPath, signed: false }
	}
	const { out: signaturePath, keyId: usedKey } = signFile({ manifestPath, keysPath, keyId, env })
	log(`signed with the key "${usedKey}"`)
	for (const entry of entries) {
		const checked = await verifyRelease({
			manifestPath,
			signaturePath,
			keysPath,
			archivePath: entry.archive,
		})
		for (const line of checked) log(`  ok ${line}`)
	}
	return { release, manifestPath, signaturePath, signed: true }
}

async function main(args) {
	const { flags } = parseFlags(args, {
		out: 'string',
		target: 'list',
		keys: 'string',
		previous: 'string',
		floor: 'string',
		withdraw: 'list',
		unwithdraw: 'list',
		'issued-at': 'string',
		'lifetime-days': 'string',
		'key-id': 'string',
		'keep-stage': 'boolean',
	})
	if (!flags.out)
		throw new Error(
			'Usage: release-local.mjs --out <dir> [--target <platform>-<arch> ...] [options]; see the header of this file.',
		)
	await releaseLocal({
		out: flags.out,
		targets: (flags.target ?? ['win32-x64']).map(parseTarget),
		keysPath: flags.keys,
		previousPath: flags.previous,
		floor: flags.floor,
		withdraw: flags.withdraw,
		unwithdraw: flags.unwithdraw,
		issuedAt: flags['issued-at'],
		lifetimeDays: flags['lifetime-days'] === undefined ? undefined : Number(flags['lifetime-days']),
		keyId: flags['key-id'],
		keepStage: Boolean(flags['keep-stage']),
	})
}

if (isMain(import.meta.url)) await runMain(main)
