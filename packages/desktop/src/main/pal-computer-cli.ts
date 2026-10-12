import { spawn } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { ComputerLineParser } from './pal-computer-lines.js'
import type { ComputerCli } from './pal-computer-setup.js'

export interface ComputerCliCommand {
	program: string
	/** Everything that goes before `computer ...`: Node flags and the CLI entry. */
	prefix: string[]
	env: NodeJS.ProcessEnv
}

type Spawn = (program: string, args: string[], options: SpawnOptions) => ChildProcess

/**
 * Runs the same CLI the runtime uses, as its own short process, so a setup never shares a pipe with
 * a conversation. Output that is not a JSON line is dropped; the child's error text is never read.
 */
export function createComputerCli(
	command: ComputerCliCommand,
	spawnProcess: Spawn = spawn,
): ComputerCli {
	return {
		run: (args, onLine) =>
			new Promise((resolve, reject) => {
				const child = spawnProcess(command.program, [...command.prefix, ...args], {
					env: command.env,
					windowsHide: true,
					stdio: ['ignore', 'pipe', 'ignore'],
				})
				const parser = new ComputerLineParser()
				child.stdout?.setEncoding?.('utf8')
				child.stdout?.on('data', (chunk: string | Buffer) => {
					for (const line of parser.push(String(chunk))) onLine(line)
				})
				child.once('error', reject)
				child.once('close', (exitCode: number | null) => {
					for (const line of parser.end()) onLine(line)
					resolve({ exitCode })
				})
			}),
	}
}
