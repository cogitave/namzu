// The decisions of .github/workflows/kernel-release.yml that are logic, kept here so they are tested:
// what a run should do, and which archives of the rolling release to remove.
//
//   node scripts/kernel/release-plan.mjs decide --event <name> --local-version <x.y.z> --on-registry <true|false>
//        --keys <kernel-keys.json> [--previous <kernel-latest.json>] [--floor <v>] [--withdraw <v>] [--unwithdraw <v>]
//     prints  mode=<build|reissue|none>  and  reason=<words>  (lines for $GITHUB_OUTPUT)
//   node scripts/kernel/release-plan.mjs prune --keep <v> < asset-names.json
//     prints the archive names to remove, one per line (all but the two newest versions, and never <v>)
//   node scripts/kernel/release-plan.mjs upload-plan --name <archive> --assets <asset-names.json> [--manifest <kernel-latest.json> ...]
//     prints  action=<upload|replace|refuse>  and  reason=<words>  for the archive about to be uploaded;
//     each --manifest is a signed manifest that VERIFIED (the feed's current one), never a half-uploaded one
import { readFileSync } from 'node:fs'
import { isMain, parseFlags, runMain } from './cli.mjs'
import { VERSION, compareVersions, parseManifest } from './manifest.mjs'
import { parseKeyList } from './signing.mjs'

/**
 * What a run does. `build`: the command line at this commit is newer than the current manifest's AND is on
 * the registry. `reissue`: renew the current manifest (the weekly schedule, or by hand, with any new floor or
 * withdrawn list). `none`: end quietly. With no public key listed nothing can be published, so it is `none`.
 */
export function decide({ event, localVersion, onRegistry, keyCount, previous, hasChange = false }) {
	if (keyCount === 0)
		return {
			mode: 'none',
			reason: 'no public key is listed in kernel-keys.json yet, so there is nothing to sign for',
		}
	if (!VERSION.test(localVersion))
		return { mode: 'none', reason: 'the command line version is not x.y.z' }
	const newer = !previous || compareVersions(localVersion, previous.kernel.commandLine) > 0
	if (newer && onRegistry)
		return {
			mode: 'build',
			reason: `command line ${localVersion} is newer than ${previous ? previous.kernel.commandLine : 'nothing published'} and is on the registry`,
		}
	if (previous && (event === 'schedule' || event === 'workflow_dispatch'))
		return {
			mode: 'reissue',
			reason:
				event === 'schedule'
					? 'weekly renewal of the current manifest'
					: hasChange
						? 'manual renewal with a changed floor or withdrawn list'
						: 'manual renewal of the current manifest',
		}
	if (newer)
		return { mode: 'none', reason: `command line ${localVersion} is not on the registry yet` }
	return {
		mode: 'none',
		reason: `command line ${localVersion} is not newer than the published ${previous.kernel.commandLine}`,
	}
}

const ARCHIVE = /^namzu-kernel-(\d+\.\d+\.\d+)-[a-z0-9]+-[a-z0-9]+\.tar\.gz$/

/** The archive names to remove: every version but the two newest, and never `keep`. */
export function pruneList(names, keep) {
	const versions = [...new Set(names.map((name) => ARCHIVE.exec(name)?.[1]).filter(Boolean))]
		.sort(compareVersions)
		.reverse()
	const kept = new Set([...versions.slice(0, 2), keep])
	return names.filter((name) => {
		const version = ARCHIVE.exec(name)?.[1]
		return version && !kept.has(version)
	})
}

/**
 * What to do with the archive about to be uploaded, given the names already on the rolling release and the
 * manifests that are published (verified: they name what clients may be fetching).
 *  - not on the release: `upload`.
 *  - on the release and a published manifest names it: `refuse`. Bytes under a name people may have
 *    downloaded stay as they were; bump the version instead.
 *  - on the release and no published manifest names it: `replace`. Nobody was ever pointed at it: it is what
 *    an upload cut between the archive and the signed pair leaves behind, and refusing it would make that
 *    version impossible to publish for good.
 */
export function archiveUploadAction({ name, assets, manifests = [] }) {
	if (!ARCHIVE.test(name)) return { action: 'refuse', reason: `${name} is not an archive name` }
	if (!assets.includes(name))
		return { action: 'upload', reason: `${name} is not on the release yet` }
	const named = manifests.some((manifest) =>
		Object.values(manifest.kernel.bundles).some((bundle) => bundle.file === name),
	)
	if (named)
		return {
			action: 'refuse',
			reason: `${name} is already on the release and a published manifest names it; bump the version instead`,
		}
	return {
		action: 'replace',
		reason: `${name} is on the release but no published manifest names it (an earlier upload was cut before the signed pair), so it is replaced`,
	}
}

async function main(args) {
	const [command, ...rest] = args
	if (command === 'prune') {
		const { flags } = parseFlags(rest, { keep: 'string' })
		if (!VERSION.test(flags.keep ?? '')) throw new Error('--keep must be a version like 1.2.3.')
		const names = JSON.parse(readFileSync(0, 'utf8'))
		if (!Array.isArray(names) || names.some((name) => typeof name !== 'string'))
			throw new Error('Standard input must be a JSON array of asset names.')
		for (const name of pruneList(names, flags.keep)) console.log(name)
		return
	}
	if (command === 'upload-plan') {
		const { flags } = parseFlags(rest, { name: 'string', assets: 'string', manifest: 'list' })
		if (!flags.name || !flags.assets)
			throw new Error(
				'Usage: release-plan.mjs upload-plan --name <archive> --assets <file> [--manifest <file> ...]',
			)
		const assets = JSON.parse(readFileSync(flags.assets, 'utf8'))
		if (!Array.isArray(assets) || assets.some((name) => typeof name !== 'string'))
			throw new Error('--assets must be a JSON array of asset names.')
		const manifests = (flags.manifest ?? []).map((file) => parseManifest(readFileSync(file)))
		const result = archiveUploadAction({ name: flags.name, assets, manifests })
		console.log(`action=${result.action}`)
		console.log(`reason=${result.reason}`)
		return
	}
	if (command !== 'decide') throw new Error('Usage: release-plan.mjs decide|prune|upload-plan ...')
	const { flags } = parseFlags(rest, {
		event: 'string',
		'local-version': 'string',
		'on-registry': 'string',
		keys: 'string',
		previous: 'string',
		floor: 'string',
		withdraw: 'string',
		unwithdraw: 'string',
	})
	for (const key of ['floor', 'withdraw', 'unwithdraw'])
		if (flags[key] && !VERSION.test(flags[key]))
			throw new Error(`--${key} must be a version like 1.2.3.`)
	if (!['workflow_run', 'workflow_dispatch', 'schedule'].includes(flags.event))
		throw new Error('--event must be workflow_run, workflow_dispatch or schedule.')
	const result = decide({
		event: flags.event,
		localVersion: flags['local-version'],
		onRegistry: flags['on-registry'] === 'true',
		keyCount: parseKeyList(readFileSync(flags.keys, 'utf8'), flags.keys).length,
		previous: flags.previous ? parseManifest(readFileSync(flags.previous)) : undefined,
		hasChange: Boolean(flags.floor || flags.withdraw || flags.unwithdraw),
	})
	console.log(`mode=${result.mode}`)
	console.log(`reason=${result.reason}`)
}

if (isMain(import.meta.url)) await runMain(main)
