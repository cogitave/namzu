// kernel.json (specification 3.1): the facts of a staged kernel, written from what the kernel itself
// answers, never typed by hand. The kernel is started twice from its own folder, in a scratch home:
// `--version`, and the `initialize` exchange of `acp --desktop`, whose answer carries
// `kernel: { engine, dataEpoch, commandLine, desktopContract }`.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { childEnv, initializeReply, runToEnd } from '../check-staged-cli.mjs'

const VERSION = /^\d+\.\d+\.\d+$/

export class KernelFactsError extends Error {
	constructor(message) {
		super(message)
		this.name = 'KernelFactsError'
	}
}

const isCount = (value) => Number.isSafeInteger(value) && value >= 1

/**
 * Check the pieces and put them in the order the file is written in. Pure. `target` is
 * `{ platform, arch }`: the machine the kernel is FOR, which need not be the one that ran it.
 */
export function assembleKernelFacts({ packageVersion, versionOutput, kernel, target }) {
	const problems = []
	if (!VERSION.test(packageVersion ?? ''))
		problems.push(`package.json carries the version "${packageVersion}", which is not x.y.z`)
	if (versionOutput.trim() !== packageVersion)
		problems.push(
			`\`--version\` printed "${versionOutput.trim()}" but package.json says ${packageVersion}`,
		)
	if (!kernel || typeof kernel !== 'object')
		problems.push(
			'the answer to `initialize` has no `kernel` object (this command line does not state its facts)',
		)
	else {
		if (kernel.commandLine !== packageVersion)
			problems.push(
				`initialize says the command line is ${JSON.stringify(kernel.commandLine)}, not ${packageVersion}`,
			)
		if (!VERSION.test(kernel.engine ?? ''))
			problems.push(`initialize states the engine ${JSON.stringify(kernel.engine)}, not x.y.z`)
		if (!isCount(kernel.dataEpoch))
			problems.push(
				`initialize states the data epoch ${JSON.stringify(kernel.dataEpoch)}, not a whole number of 1 or more`,
			)
		if (!isCount(kernel.desktopContract))
			problems.push(
				`initialize states the desktop contract ${JSON.stringify(kernel.desktopContract)}, not a whole number of 1 or more (was it started with acp --desktop?)`,
			)
	}
	if (problems.length > 0)
		throw new KernelFactsError(
			`The staged kernel does not state its facts: ${problems.join('; ')}.`,
		)
	return {
		schema: 1,
		commandLine: kernel.commandLine,
		engine: kernel.engine,
		desktopContract: kernel.desktopContract,
		dataEpoch: kernel.dataEpoch,
		platform: target.platform,
		arch: target.arch,
	}
}

/** The bytes of kernel.json: compact JSON and one trailing newline. */
export const kernelJsonText = (facts) => `${JSON.stringify(facts)}\n`

/** Start the kernel in `cliDir` and say what it is. Throws KernelFactsError when it does not say. */
export async function readKernelFacts({ cliDir, target, node = process.execPath }) {
	const home = mkdtempSync(join(tmpdir(), 'namzu-kernel-facts-'))
	const project = join(home, 'project')
	mkdirSync(project)
	mkdirSync(join(home, 'namzu'))
	try {
		const options = { cwd: project, env: childEnv(home) }
		const bin = join(cliDir, 'dist', 'bin.js')
		const packageVersion = JSON.parse(readFileSync(join(cliDir, 'package.json'), 'utf8')).version
		const version = await runToEnd(node, [bin, '--version'], options)
		if (version.code !== 0)
			throw new KernelFactsError(
				`The staged kernel does not start: \`--version\` exited ${version.code}: ${version.stderr.trim().slice(-300)}`,
			)
		let reply
		try {
			reply = await initializeReply(node, [bin, 'acp', '--desktop'], options)
		} catch (error) {
			throw new KernelFactsError(`The staged kernel does not answer initialize: ${error.message}`)
		}
		if (reply.error || !reply.result)
			throw new KernelFactsError(
				`The staged kernel refused initialize: ${JSON.stringify(reply.error ?? reply).slice(0, 300)}`,
			)
		return assembleKernelFacts({
			packageVersion,
			versionOutput: version.stdout,
			kernel: reply.result.kernel,
			target,
		})
	} finally {
		rmSync(home, { recursive: true, force: true })
	}
}
