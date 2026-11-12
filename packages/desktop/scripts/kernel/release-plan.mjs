// The decisions of .github/workflows/kernel-release.yml that are logic, kept here so they are tested:
// what a run should do, and which archives of the rolling release to remove.
//
//   node scripts/kernel/release-plan.mjs decide --event <name> --local-version <x.y.z> --on-registry <true|false> [--tag-published <true|false>]
//        --keys <kernel-keys.json> [--previous <kernel-latest.json>] [--floor <v>] [--withdraw <v>] [--unwithdraw <v>]
//     prints  mode=<build|reissue|none>  and  reason=<words>  (lines for $GITHUB_OUTPUT)
//   node scripts/kernel/release-plan.mjs tag-commit --version <x.y.z> < git-ls-remote-output
//     prints the commit the tag @namzu/cli@<x.y.z> points at (nothing when there is no such tag)
//   node scripts/kernel/release-plan.mjs registry-wait --version <x.y.z> --event <name>
//     prints  on=<true|false>  after asking the npm registry (a long, quiet wait only for workflow_run)
//   node scripts/kernel/release-plan.mjs prune --keep <v> < asset-names.json
//     prints the archive names to remove, one per line (all but the two newest versions, and never <v>)
//   node scripts/kernel/release-plan.mjs upload-plan --name <archive> --assets <asset-names.json> [--manifest <kernel-latest.json> ...]
//     prints  action=<upload|replace|refuse>  and  reason=<words>  for the archive about to be uploaded;
//     each --manifest is a signed manifest that VERIFIED (the feed's current one), never a half-uploaded one
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { isMain, parseFlags, runMain } from './cli.mjs'
import { VERSION, compareVersions, parseManifest } from './manifest.mjs'
import { parseKeyList } from './signing.mjs'

/**
 * What a run does. `build`: the command line at this commit is newer than the current manifest's AND is on
 * the registry. `reissue`: renew the current manifest (the weekly schedule, or by hand, with any new floor or
 * withdrawn list). `none`: end quietly. With no public key listed nothing can be published, so it is `none`.
 */
export function decide({
	event,
	localVersion,
	onRegistry,
	tagPublished = false,
	keyCount,
	previous,
	hasChange = false,
}) {
	if (keyCount === 0)
		return {
			mode: 'none',
			reason: 'no public key is listed in kernel-keys.json yet, so there is nothing to sign for',
		}
	if (!VERSION.test(localVersion))
		return { mode: 'none', reason: 'the command line version is not x.y.z' }
	const newer = !previous || compareVersions(localVersion, previous.kernel.commandLine) > 0
	if (newer && (onRegistry || tagPublished)) {
		const proof =
			onRegistry && tagPublished
				? 'is on the registry and carries its release tag on main'
				: onRegistry
					? 'is on the registry'
					: 'carries its release tag on main (the registry may not answer yet)'
		return {
			mode: 'build',
			reason: `command line ${localVersion} is newer than ${previous ? previous.kernel.commandLine : 'nothing published'} and ${proof}`,
		}
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
		return {
			mode: 'none',
			reason: `command line ${localVersion} is not on the registry yet and has no release tag on main`,
		}
	return {
		mode: 'none',
		reason: `command line ${localVersion} is not newer than the published ${previous.kernel.commandLine}`,
	}
}

const TAG_PREFIX = 'refs/tags/@namzu/cli@'

/**
 * The commit that the release tag `@namzu/cli@<version>` points at, read from `git ls-remote --tags` output
 * (lines of `<sha> <ref>`; an annotated tag also lists `<ref>^{}` with the commit it wraps, which wins).
 * The name must match exactly: a tag for another version, or a longer version that starts with this one,
 * never counts. Returns '' when there is no such tag.
 */
export function tagCommit(lsRemote, version) {
	const want = `${TAG_PREFIX}${version}`
	let found = ''
	for (const line of lsRemote.split('\n')) {
		const [sha, ref, ...extra] = line.trim().split(/\s+/)
		if (extra.length || !/^[0-9a-f]{40,64}$/.test(sha ?? '')) continue
		if (ref === `${want}^{}`) return sha
		if (ref === want) found = sha
	}
	return found
}

/**
 * Ask whether the registry has the version, again and again until it does or `totalMs` has passed on the
 * clock. `ask` answers true or false; `sleep` and `now` are injected, so a test never waits. Nothing is
 * printed per attempt.
 */
export async function waitForRegistry({ ask, sleep, now, totalMs, intervalMs }) {
	const deadline = now() + totalMs
	for (;;) {
		if (await ask()) return true
		if (now() + intervalMs > deadline) return false
		await sleep(intervalMs)
	}
}

// Measured lag between a good publish and the registry answering is up to about 13 minutes; 25 covers it.
const REGISTRY_WAIT_MS = 25 * 60_000
const REGISTRY_INTERVAL_MS = 60_000
const exec = promisify(execFile)

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
	if (command === 'tag-commit') {
		const { flags } = parseFlags(rest, { version: 'string' })
		if (!VERSION.test(flags.version ?? ''))
			throw new Error('--version must be a version like 1.2.3.')
		console.log(tagCommit(readFileSync(0, 'utf8'), flags.version))
		return
	}
	if (command === 'registry-wait') {
		const { flags } = parseFlags(rest, { version: 'string', event: 'string' })
		if (!VERSION.test(flags.version ?? ''))
			throw new Error('--version must be a version like 1.2.3.')
		const ask = async () => {
			try {
				const { stdout } = await exec('npm', ['view', `@namzu/cli@${flags.version}`, 'version'])
				return stdout.trim() === flags.version
			} catch {
				return false
			}
		}
		// Only the run the package publish started waits long; every other start asks once.
		const on = await waitForRegistry({
			ask,
			sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
			now: Date.now,
			totalMs: flags.event === 'workflow_run' ? REGISTRY_WAIT_MS : 0,
			intervalMs: REGISTRY_INTERVAL_MS,
		})
		console.log(`on=${on}`)
		return
	}
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
	if (command !== 'decide')
		throw new Error('Usage: release-plan.mjs decide|tag-commit|registry-wait|prune|upload-plan ...')
	const { flags } = parseFlags(rest, {
		event: 'string',
		'local-version': 'string',
		'on-registry': 'string',
		'tag-published': 'string',
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
		tagPublished: flags['tag-published'] === 'true',
		keyCount: parseKeyList(readFileSync(flags.keys, 'utf8'), flags.keys).length,
		previous: flags.previous ? parseManifest(readFileSync(flags.previous)) : undefined,
		hasChange: Boolean(flags.floor || flags.withdraw || flags.unwithdraw),
	})
	console.log(`mode=${result.mode}`)
	console.log(`reason=${result.reason}`)
}

if (isMain(import.meta.url)) await runMain(main)
