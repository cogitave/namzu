import { statSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Native Windows cannot execute npm.cmd with shell:false. Use the npm CLI
 * bundled with the Node runtime running Namzu, keeping every argument literal.
 * Custom PATH wrappers are not interpreted or silently selected in its place.
 */
export function resolveNpmInvocation(
	executable: string,
	args: readonly string[],
	platform: NodeJS.Platform = process.platform,
	nodeExecutable: string = process.execPath,
): { readonly executable: string; readonly args: readonly string[] } {
	if (platform !== 'win32' || (executable !== 'npm' && executable !== 'npm.cmd')) {
		return { executable, args }
	}
	const npmCli = join(dirname(nodeExecutable), 'node_modules', 'npm', 'bin', 'npm-cli.js')
	try {
		if (statSync(npmCli).isFile()) {
			return { executable: nodeExecutable, args: [npmCli, ...args] }
		}
	} catch {
		// Give the same actionable refusal for absent or unreadable bundles.
	}
	throw new Error(
		`npm's JavaScript entry point is unavailable at ${npmCli}. Namzu uses the npm bundled with its Node runtime on Windows. Repair that Node installation or run npm manually; custom PATH wrappers are not used.`,
	)
}
