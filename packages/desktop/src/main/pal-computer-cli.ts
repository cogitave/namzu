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
		run: (args, onLine, options) =>
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
				let timer: ReturnType<typeof setTimeout> | undefined
				let settled = false
				const settle = (finish: () => void) => {
					if (settled) return
					settled = true
					if (timer) clearTimeout(timer)
					finish()
				}
				if (options?.timeoutMs !== undefined) {
					// A wedged child must never hold the caller: stop waiting and stop the child.
					timer = setTimeout(() => {
						settle(() => {
							try {
								child.kill()
							} catch {
								// Already gone.
							}
							resolve({ exitCode: null })
						})
					}, options.timeoutMs)
					timer.unref?.()
				}
				child.once('error', (error) => settle(() => reject(error)))
				child.once('close', (exitCode: number | null) =>
					settle(() => {
						for (const line of parser.end()) onLine(line)
						resolve({ exitCode })
					}),
				)
			}),
	}
}
