/**
 * Add a Codex account by running the official `codex login` with a fresh,
 * private `CODEX_HOME`. Namzu never handles the sign-in itself: it starts the
 * tool, shows the address the tool prints, waits for it to finish, and checks
 * that a usable `auth.json` was written. If the person cancels, or the tool
 * fails, the folder it was given is removed.
 */

import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { readCodexCredentialFile } from '../providers/harness-credentials.js'

export type CodexLoginResult =
	| { readonly kind: 'signed-in'; readonly accountId: string }
	| { readonly kind: 'cancelled' }
	| {
			readonly kind: 'failed'
			readonly message: string
			/** The `codex` command is not on this computer. */
			readonly missing?: boolean
	  }

export interface CodexLoginOptions {
	/** The fresh folder the sign-in is written to. Created here, removed on failure. */
	readonly dir: string
	readonly signal: AbortSignal
	readonly command?: string
	readonly env?: NodeJS.ProcessEnv
	readonly spawn?: (
		command: string,
		args: string[],
		options: Record<string, unknown>,
	) => ChildProcess
	/** Each line the tool prints, in order. */
	readonly onOutput?: (line: string) => void
}

/** The address a sign-in prints for the browser, if this line carries one. */
export function loginAddressIn(line: string): string | undefined {
	return /https?:\/\/[^\s"'<>]+/.exec(line)?.[0]
}

function lines(sink: (line: string) => void): (chunk: Buffer | string) => void {
	let rest = ''
	return (chunk) => {
		rest += chunk.toString()
		const parts = rest.split(/\r?\n/)
		rest = parts.pop() ?? ''
		for (const part of parts) if (part.trim().length > 0) sink(part)
	}
}

export async function runCodexLogin(options: CodexLoginOptions): Promise<CodexLoginResult> {
	const cleanup = (): void => {
		rmSync(options.dir, { recursive: true, force: true })
	}
	if (options.signal.aborted) return { kind: 'cancelled' }
	mkdirSync(options.dir, { recursive: true, mode: 0o700 })
	const start = options.spawn ?? (nodeSpawn as NonNullable<CodexLoginOptions['spawn']>)
	let child: ChildProcess
	try {
		child = start(options.command ?? 'codex', ['login'], {
			env: { ...(options.env ?? process.env), CODEX_HOME: options.dir },
			stdio: ['ignore', 'pipe', 'pipe'],
		})
	} catch (error) {
		cleanup()
		return {
			kind: 'failed',
			message: error instanceof Error ? error.message : String(error),
		}
	}
	const sink = options.onOutput ?? (() => undefined)
	child.stdout?.on('data', lines(sink))
	child.stderr?.on('data', lines(sink))
	const outcome = await new Promise<
		{ kind: 'exit'; code: number | null } | { kind: 'error'; error: NodeJS.ErrnoException }
	>((resolveOutcome) => {
		child.once('error', (error) => resolveOutcome({ kind: 'error', error }))
		child.once('exit', (code) => resolveOutcome({ kind: 'exit', code }))
		options.signal.addEventListener('abort', () => child.kill('SIGTERM'), {
			once: true,
		})
	})
	if (options.signal.aborted) {
		cleanup()
		return { kind: 'cancelled' }
	}
	if (outcome.kind === 'error') {
		cleanup()
		return outcome.error.code === 'ENOENT'
			? {
					kind: 'failed',
					missing: true,
					message:
						'Codex is not installed on this computer. Install it, then add the account again.',
				}
			: { kind: 'failed', message: outcome.error.message }
	}
	const credential = readCodexCredentialFile(join(options.dir, 'auth.json'))
	if (outcome.code !== 0 || !credential) {
		cleanup()
		return {
			kind: 'failed',
			message:
				outcome.code === 0
					? 'The Codex sign-in finished without signing in. Try adding the account again.'
					: 'The Codex sign-in did not finish. Try adding the account again.',
		}
	}
	return { kind: 'signed-in', accountId: credential.accountId }
}
