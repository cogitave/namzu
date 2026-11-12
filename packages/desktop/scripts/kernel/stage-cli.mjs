// The steps that turn the workspace's command line into a folder that starts with dist/bin.js and
// runs from its own files. ONE function, used by the installer staging (extra/cli, the bundled
// engine) and by the kernel staging (the engine the app fetches), so the two can never drift:
//   deploy for the target -> lean -> target natives -> drop dead weight -> start it and check it.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { STAGED_CLI_FILES, checkStagedCli } from '../check-staged-cli.mjs'
import { leanCli, loadExternals, measure } from '../lean-cli.mjs'

/**
 * A copy of an environment without the release signing key. Staging runs `pnpm deploy` (third-party
 * install code) and starts the staged program; neither is given the key, even when the person running
 * the whole local release has it set for the signing step.
 */
export function withoutSigningKey(env) {
	const copy = { ...env }
	delete copy.NAMZU_KERNEL_SIGNING_KEY
	return copy
}

function prune(directory, remove) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name)
		if (remove(entry, path)) rmSync(path, { recursive: true, force: true })
		else if (entry.isDirectory()) prune(path, remove)
	}
}

export { prune }

/**
 * Files in a staged node_modules that a running program never reads: source maps, type
 * declarations, test files and the README, CHANGELOG and HISTORY notes. Licence and notice
 * files are never matched. The TypeScript package is left whole, since its compiler reads
 * its own lib.*.d.ts files at run time. Pure, so it is tested without staging anything.
 */
export function isDeadWeight(path) {
	const parts = path.split(/[\\/]/)
	const name = parts[parts.length - 1]
	const index = parts.lastIndexOf('node_modules')
	if (index >= 0 && parts[index + 1] === 'typescript') return false
	if (/\.(map|d\.ts|d\.cts|d\.mts)$/.test(name)) return true
	if (/\.test\.(c|m)?(j|t)s$/.test(name)) return true
	return /^(readme|changelog|changes|history)(\.(md|markdown|txt))?$/i.test(name)
}

/** Remove the dead weight under a node_modules folder; returns how many files went. */
export function pruneDeadWeight(directory) {
	let removed = 0
	prune(directory, (entry, path) => {
		if (!entry.isFile() || !isDeadWeight(path)) return false
		removed += 1
		return true
	})
	return removed
}

/** `linux-x64`, `linux-x64-musl`, `win32-x64`: the name a target goes by in file names and checks. */
export const targetName = (target) =>
	`${target.platform}-${target.arch}${target.libc === 'musl' ? '-musl' : ''}`

/**
 * Stage the workspace command line into `cli` for `target`, then start it and check it works from
 * its own files. Returns `{ cli, externals, report, lean, before, after, targetName }`; throws when
 * the staged folder does not work. `run` and `log` are injectable for tests.
 */
export async function stageCliFolder({
	repoRoot,
	cli,
	target,
	log = console.log,
	run = (program, args, options) =>
		execFileSync(program, args, {
			stdio: 'inherit',
			env: withoutSigningKey(process.env),
			...options,
		}),
}) {
	// Deployed for the target, not for this machine: without --os, --cpu and --libc pnpm fetches the
	// optional packages of the staging machine (Linux on a runner), and a Windows installer would
	// carry no sharp, oxc-parser or node-pty binding.
	run(
		'pnpm',
		[
			'--filter',
			'@namzu/cli',
			'deploy',
			'--prod',
			'--legacy',
			'--config.node-linker=hoisted',
			`--os=${target.platform}`,
			`--cpu=${target.arch}`,
			...(target.libc ? [`--libc=${target.libc}`] : []),
			cli,
		],
		{ cwd: repoRoot },
	)
	prune(cli, (entry) => entry.name === '.bin' || entry.isSymbolicLink())
	// The bundle inlines most of what the deploy installed. Keep the packages it leaves external, what
	// they depend on and the target's native binaries; the rest is never loaded.
	const before = measure(cli)
	const externals = await loadExternals(join(repoRoot, 'packages/cli'))
	const lean = leanCli({ root: cli, externals, target })
	pruneDeadWeight(join(cli, 'node_modules'))
	pruneDeadWeight(join(cli, 'dist'))
	const after = measure(cli)
	log(
		`CLI runtime: ${(before.bytes / 1e6).toFixed(1)} MB in ${before.files} files -> ${(after.bytes / 1e6).toFixed(1)} MB in ${after.files} files; ${lean.keep.size} packages kept, ${lean.removedPackages} removed (${lean.foreignPrebuilds} foreign prebuild folders), skipped for ${target.platform}-${target.arch}: ${lean.skippedForTarget.join(', ') || 'none'}`,
	)
	// Terminals need node-pty, an optional dependency of the CLI that a deploy on a machine without a
	// compiler can silently omit. The target's binaries ship inside the package, so check for them here
	// rather than finding an installer whose terminals are all unavailable.
	const name = targetName(target)
	if (
		target.platform === 'win32' &&
		!existsSync(join(cli, `node_modules/node-pty/prebuilds/${name}/pty.node`))
	)
		throw new Error(
			`The staged CLI runtime has no node-pty ${name} binary; terminals would not work.`,
		)
	// The staged CLI must work from its own files: version, the Desktop's first call, every import.
	const { failures, report } = await checkStagedCli({
		cliDir: cli,
		externals,
		target,
		requiredFiles: STAGED_CLI_FILES,
	})
	log(
		`Staged CLI check: --version ${report.version} in ${report.timings.versionMs?.toFixed(0)} ms, initialize in ${report.timings.initializeMs?.toFixed(0)} ms, ${report.specifiers} specifiers resolved, ${report.imported} imported${report.notImported.length ? `, not imported on this host (assert files for ${name}): ${report.notImported.join(', ')}` : ''}${report.notShipped.length ? `; deliberately not shipped: ${report.notShipped.join(', ')}` : ''}`,
	)
	if (failures.length > 0)
		throw new Error(`The staged CLI does not work from its own files:\n  ${failures.join('\n  ')}`)
	return { cli, externals, report, lean, before, after, targetName: name }
}
