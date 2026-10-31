import { spawn } from 'node:child_process'
import { SpacesHost } from '../spaces/host.js'
import { createPeerSource } from '../spaces/peers.js'
import { DEFAULT_PREFIX, parsePrefix } from '../spaces/prefix.js'
import { type HostPtyModule, buildPtyEnv, loadHostPty } from '../terminal/pty.js'
import type { CommandDef } from './types.js'

export const SPACES_HELP = `Usage: namzu spaces [options]

(preview) Run Namzu sessions side by side. The sidebar lists your spaces (project
folders) on top, each with one dot for the most urgent thing in it, and the sessions
of the selected space below. Each session is a full Namzu in its own terminal, so one
that stops does not affect the others. The options after "spaces" go to the first
session, so "namzu spaces --model <name>" starts it on that model.

Dots: red needs approval, blue finished and not seen yet, yellow working, green idle.

Keys:
  ctrl+b            navigate (change the key with tui.spacesPrefix in your config)
  ctrl+b ctrl+b     send a literal ctrl+b to the session
  j / k, arrows     move between the sessions of a space
  J / K, 1-9        move between spaces
  n                 new session in this space
  N                 new space from a folder
  r / R             rename the session / the space
  d / D             close the session / the space
  enter, l          back to the session
  b                 hide or show the sidebar
  q                 quit
  esc               leave navigate mode

The mouse works too: click a space or a session, scroll the sidebar, or scroll a
session's history.
`

export interface SpacesDeps {
	readonly stdin: NodeJS.ReadStream
	readonly stdout: NodeJS.WriteStream
	readonly stderr: { write(text: string): unknown }
	readonly env: NodeJS.ProcessEnv
	readonly cwd: string
	readonly entry: string
	readonly loadPty: () => Promise<HostPtyModule>
	/** Runs one plain session on this terminal and resolves with its exit code. */
	readonly runPlain: (file: string, args: string[]) => Promise<number>
}

export function realDeps(): SpacesDeps {
	return {
		stdin: process.stdin,
		stdout: process.stdout,
		stderr: process.stderr,
		env: process.env,
		cwd: process.cwd(),
		entry: process.argv[1] as string,
		loadPty: () => loadHostPty(),
		runPlain: (file, args) =>
			new Promise((resolve) => {
				const child = spawn(file, args, { stdio: 'inherit' })
				child.on('error', () => resolve(1))
				child.on('exit', (code) => resolve(code ?? 1))
			}),
	}
}

export async function runSpaces(
	rawArgs: readonly string[],
	prefixSetting: string | undefined,
	deps: SpacesDeps,
): Promise<number> {
	if (!deps.stdin.isTTY || !deps.stdout.isTTY) {
		deps.stderr.write('namzu spaces needs an interactive terminal.\n')
		return 1
	}
	const args = [deps.entry, ...rawArgs]
	let binding: HostPtyModule
	try {
		binding = await deps.loadPty()
	} catch (error) {
		const reason = (error instanceof Error ? error.message : String(error)).split('\n')[0]
		deps.stderr.write(
			`Spaces needs a terminal component that is not available here (${reason}). Starting a single session instead.\n`,
		)
		return deps.runPlain(process.execPath, args)
	}
	const prefix =
		(prefixSetting !== undefined ? parsePrefix(prefixSetting) : undefined) ?? DEFAULT_PREFIX
	const peers = createPeerSource(deps.env)
	const host = new SpacesHost({
		input: deps.stdin,
		output: deps.stdout,
		binding,
		spec: ({ cwd, slot, first }) => ({
			file: process.execPath,
			args: first ? args : [deps.entry],
			cwd,
			env: buildPtyEnv(deps.env, { NAMZU_SPACE_SLOT: slot }),
		}),
		folder: { cwd: deps.cwd, name: deps.cwd.split(/[\\/]/u).filter(Boolean).pop() ?? 'session' },
		prefix,
		...(peers ? { peers } : {}),
	})
	const stop = (): void => host.quit()
	process.on('SIGTERM', stop)
	process.on('SIGHUP', stop)
	host.start()
	try {
		return await host.done
	} finally {
		process.off('SIGTERM', stop)
		process.off('SIGHUP', stop)
	}
}

export const spacesCommand: CommandDef = {
	name: 'spaces',
	description: 'Run Namzu sessions side by side in one terminal (preview)',
	passThrough: true,
	help: SPACES_HELP,
	handler: async ({ ctx, rawArgs }) => runSpaces(rawArgs, ctx.config.tui?.spacesPrefix, realDeps()),
}
