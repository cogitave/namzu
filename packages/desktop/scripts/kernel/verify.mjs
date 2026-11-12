// The publisher's last check (specification 4.5): a manifest, its signature against a list of public
// keys, and an archive against the manifest, using the READER of archive-reader.mjs.
//
//   node scripts/kernel/verify.mjs --manifest kernel-latest.json --sig kernel-latest.json.sig
//        [--keys packages/desktop/kernel-keys.json] [--archive <file.tar.gz>] [--now <ISO time>]
//        [--allow-expired]
//
// Exit 0 and one line per check on success; exit 1 and the first refusal on stderr otherwise.
import { createHash } from 'node:crypto'
import { createReadStream, readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { ArchiveRefusal, readArchive } from './archive-reader.mjs'
import { isMain, parseFlags, runMain } from './cli.mjs'
import { ManifestError, VERSION, parseManifest, parseTime } from './manifest.mjs'
import { DEFAULT_KEYS_FILE, readKeyList, verifySignature } from './signing.mjs'

function sha512File(path) {
	return new Promise((resolve, reject) => {
		const hash = createHash('sha512')
		createReadStream(path)
			.on('data', (chunk) => hash.update(chunk))
			.on('error', reject)
			.on('end', () => resolve(hash.digest('hex')))
	})
}

/** What kernel.json says, checked for shape. */
function parseKernelJson(bytes) {
	let value
	try {
		value = JSON.parse(bytes.toString('utf8'))
	} catch {
		throw new ArchiveRefusal('kernel.json is not valid JSON.')
	}
	const keys = 'schema,commandLine,engine,desktopContract,dataEpoch,platform,arch'
	if (
		value === null ||
		typeof value !== 'object' ||
		Object.keys(value).sort().join() !== keys.split(',').sort().join() ||
		value.schema !== 1
	)
		throw new ArchiveRefusal(`kernel.json does not have the fields ${keys}.`)
	if (
		!VERSION.test(value.commandLine) ||
		!VERSION.test(value.engine) ||
		!Number.isSafeInteger(value.desktopContract) ||
		!Number.isSafeInteger(value.dataEpoch)
	)
		throw new ArchiveRefusal('kernel.json has a bad version or number.')
	return value
}

/**
 * Read an archive with the reader and build what the manifest says about it (the bundle entry) from
 * the archive alone. Used by the publish job, which trusts nothing the build job wrote beside it.
 * Returns `{ target, kernel, bundle, kernelJson }`.
 */
export async function describeArchive(archivePath, { limits } = {}) {
	let kernelBytes = []
	const result = await readArchive(archivePath, {
		limits,
		sink: {
			begin(path) {
				this.keep = path === 'kernel.json'
			},
			write(chunk) {
				if (this.keep) kernelBytes.push(Buffer.from(chunk))
			},
			end() {},
		},
	})
	if (!result.files.has('kernel.json')) throw new ArchiveRefusal('The archive has no kernel.json.')
	const kernelJson = parseKernelJson(Buffer.concat(kernelBytes))
	kernelBytes = []
	const target = `${kernelJson.platform}-${kernelJson.arch}`
	return {
		target,
		kernel: {
			commandLine: kernelJson.commandLine,
			engine: kernelJson.engine,
			desktopContract: kernelJson.desktopContract,
			dataEpoch: kernelJson.dataEpoch,
		},
		bundle: {
			size: statSync(archivePath).size,
			sha512: await sha512File(archivePath),
			filesSha512: createHash('sha512').update(result.filesJson).digest('hex'),
			fileCount: result.list.files.length,
			unpackedSize: result.list.files.reduce((sum, file) => sum + file.size, 0),
		},
		kernelJson,
	}
}

/**
 * Verify. Throws SigningError, ManifestError or ArchiveRefusal (all with plain messages) on the first
 * failed check; returns the list of what was checked. `now` is a time in ms (injected by tests).
 */
export async function verifyRelease({
	manifestPath,
	signaturePath,
	keysPath = DEFAULT_KEYS_FILE,
	archivePath,
	now = Date.now(),
	allowExpired = false,
}) {
	const checked = []
	const keys = readKeyList(keysPath)
	const bytes = readFileSync(manifestPath)
	const { keyId } = verifySignature(bytes, readFileSync(signaturePath), keys)
	checked.push(`signature: valid under the key "${keyId}" (${keys.length} listed)`)
	const manifest = parseManifest(bytes)
	checked.push(
		`manifest: channel ${manifest.channel}, sequence ${manifest.sequence}, kernel ${manifest.kernel.commandLine} (engine ${manifest.kernel.engine}), floor ${manifest.minimumKernel}, ${manifest.withdrawn.length} withdrawn`,
	)
	if (!allowExpired && parseTime(manifest.expiresAt, 'expiresAt') < now)
		throw new ManifestError(`The manifest expired at ${manifest.expiresAt}.`)
	if (parseTime(manifest.issuedAt, 'issuedAt') > now + 24 * 3600 * 1000)
		throw new ManifestError(`The manifest is issued in the future (${manifest.issuedAt}).`)
	checked.push(`times: issued ${manifest.issuedAt}, expires ${manifest.expiresAt}`)
	if (archivePath) {
		const name = basename(archivePath)
		const found = Object.entries(manifest.kernel.bundles).find(([, bundle]) => bundle.file === name)
		if (!found) throw new ManifestError(`The manifest has no bundle named ${name}.`)
		const [target, bundle] = found
		const size = statSync(archivePath).size
		if (size !== bundle.size)
			throw new ArchiveRefusal(`${name} is ${size} bytes; the manifest says ${bundle.size}.`)
		if ((await sha512File(archivePath)) !== bundle.sha512)
			throw new ArchiveRefusal(`${name} does not match the sha512 in the manifest.`)
		const described = await describeArchive(archivePath, {
			limits: { fileCount: bundle.fileCount, unpackedSize: bundle.unpackedSize },
		})
		const same = (label, a, b) => {
			if (a !== b)
				throw new ArchiveRefusal(`The archive says ${label} ${a}; the manifest says ${b}.`)
		}
		same('files.json sha512', described.bundle.filesSha512, bundle.filesSha512)
		same('file count', described.bundle.fileCount, bundle.fileCount)
		same('unpacked size', described.bundle.unpackedSize, bundle.unpackedSize)
		same('target', described.target, target)
		for (const key of ['commandLine', 'engine', 'desktopContract', 'dataEpoch'])
			same(`kernel.json ${key}`, described.kernel[key], manifest.kernel[key])
		checked.push(
			`archive ${name}: ${size} bytes, sha512 matches, ${bundle.fileCount} files, ${bundle.unpackedSize} bytes unpacked, files.json and kernel.json agree with the manifest`,
		)
	}
	return checked
}

async function main(args) {
	const { flags } = parseFlags(args, {
		manifest: 'string',
		sig: 'string',
		keys: 'string',
		archive: 'string',
		now: 'string',
		'allow-expired': 'boolean',
	})
	if (!flags.manifest || !flags.sig)
		throw new Error(
			'Usage: verify.mjs --manifest <file> --sig <file> [--keys <file>] [--archive <file.tar.gz>] [--now <time>] [--allow-expired]',
		)
	const now = flags.now ? Date.parse(flags.now) : Date.now()
	if (Number.isNaN(now)) throw new Error('--now must be a time like 2026-11-12T10:00:00Z.')
	const checked = await verifyRelease({
		manifestPath: flags.manifest,
		signaturePath: flags.sig,
		keysPath: flags.keys,
		archivePath: flags.archive,
		now,
		allowExpired: Boolean(flags['allow-expired']),
	})
	for (const line of checked) console.log(`ok  ${line}`)
}

if (isMain(import.meta.url)) await runMain(main)
