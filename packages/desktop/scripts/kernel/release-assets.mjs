// The asset names on the rolling release, one per line, for .github/workflows/kernel-release.yml.
//
//   node scripts/kernel/release-assets.mjs <tag>
//
// A release that does not exist yet has no assets: that prints nothing and succeeds. Any other failure
// (a rate limit, a server error, no network) exits non-zero. It must never read as "no assets": the run
// would then take a published archive for an orphan and replace it, and start the manifest chain over.
import { execFile } from 'node:child_process'
import { isMain, runMain } from './cli.mjs'

/** `run(args)` resolves `{ code, stdout, stderr }`; injected so the decision is tested without gh. */
export async function listAssets(tag, run) {
	const { code, stdout, stderr } = await run([
		'release',
		'view',
		tag,
		'--json',
		'assets',
		'--jq',
		'.assets[].name',
	])
	if (code === 0) return stdout.split('\n').filter(Boolean)
	if (/release not found/i.test(stderr)) return []
	throw new Error(
		`Could not list the assets of ${tag}: ${stderr.trim() || `gh exited ${code}`}. Not treating that as an empty release.`,
	)
}

function runGh(args) {
	return new Promise((resolve) => {
		execFile('gh', args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
			resolve({
				code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
				stdout,
				stderr: error && typeof error.code !== 'number' ? `${stderr}${error.message}` : stderr,
			})
		})
	})
}

async function main(args) {
	const [tag] = args
	if (!tag) throw new Error('Usage: release-assets.mjs <tag>')
	for (const name of await listAssets(tag, runGh)) console.log(name)
}

if (isMain(import.meta.url)) await runMain(main)
