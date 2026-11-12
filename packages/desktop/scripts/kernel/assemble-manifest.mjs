// Assemble the manifest kernel-<channel>.json (specification 4.3) from bundle entries, or re-issue
// the previous one.
//
//   node scripts/kernel/assemble-manifest.mjs --out <file> --bundle <entry.json> [--bundle <entry.json> ...]
//        [--previous <manifest.json>] [--channel latest] [--issued-at <ISO time>] [--lifetime-days 14]
//        [--floor 51.1.0] [--withdraw 51.2.0 ...] [--unwithdraw 51.2.0 ...]
//   node scripts/kernel/assemble-manifest.mjs --out <file> --reissue <manifest.json> [same time and list options]
//
// Refuses a sequence lower than the previous manifest's, a floor lower than the previous floor, and a
// kernel version that is not newer than the previous one (a re-issue is for that). With no --floor the
// previous floor is kept, or on a first manifest the kernel's own version is the floor. The withdrawn
// list is kept unless --withdraw / --unwithdraw change it. Prints the manifest's bytes' summary only.
import { readFileSync, writeFileSync } from 'node:fs'
import { isMain, parseFlags, runMain } from './cli.mjs'
import { assembleManifest, manifestBytes, parseManifest, reissueManifest } from './manifest.mjs'

async function main(args) {
	const { flags } = parseFlags(args, {
		out: 'string',
		bundle: 'list',
		previous: 'string',
		reissue: 'string',
		channel: 'string',
		'issued-at': 'string',
		'lifetime-days': 'string',
		floor: 'string',
		withdraw: 'list',
		unwithdraw: 'list',
	})
	if (!flags.out || (!flags.bundle && !flags.reissue) || (flags.bundle && flags.reissue))
		throw new Error(
			'Usage: assemble-manifest.mjs --out <file> (--bundle <entry.json>... [--previous <manifest>] | --reissue <manifest>) [options]',
		)
	const issuedAt = flags['issued-at'] ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
	const lifetimeDays =
		flags['lifetime-days'] === undefined ? undefined : Number(flags['lifetime-days'])
	if (lifetimeDays !== undefined && !(lifetimeDays > 0))
		throw new Error('--lifetime-days must be a number above 0.')
	const common = {
		issuedAt,
		lifetimeDays,
		floor: flags.floor,
		withdraw: flags.withdraw,
		unwithdraw: flags.unwithdraw,
	}
	const readManifest = (path) => parseManifest(readFileSync(path))
	const manifest = flags.reissue
		? reissueManifest({ previous: readManifest(flags.reissue), ...common })
		: assembleManifest({
				entries: flags.bundle.map((path) => JSON.parse(readFileSync(path, 'utf8'))),
				channel: flags.channel ?? 'latest',
				previous: flags.previous ? readManifest(flags.previous) : undefined,
				...common,
			})
	writeFileSync(flags.out, manifestBytes(manifest))
	console.log(
		`Manifest ${flags.out}: channel ${manifest.channel}, sequence ${manifest.sequence}, kernel ${manifest.kernel.commandLine}, floor ${manifest.minimumKernel}, withdrawn [${manifest.withdrawn.join(', ')}], expires ${manifest.expiresAt}`,
	)
}

if (isMain(import.meta.url)) await runMain(main)
