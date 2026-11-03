import type { DoctorCheck, DoctorCheckResult } from '@namzu/sdk'

import { type HostPty, type HostPtyModule, loadHostPty } from '../../terminal/pty.js'

/** How long the test program gets before the check gives up on it. */
const PROBE_MS = 10_000

/** Starts a program that ends at once, and resolves with how it ended. */
export async function tryOneSession(binding: HostPtyModule, timeoutMs = PROBE_MS): Promise<void> {
	let pty: HostPty | undefined
	let timer: ReturnType<typeof setTimeout> | undefined
	let exitWatch: { dispose(): void } | undefined
	try {
		await new Promise<void>((resolve, reject) => {
			pty = binding.spawn(process.execPath, ['-e', ''], {
				name: 'xterm-256color',
				cols: 20,
				rows: 5,
				cwd: process.cwd(),
				env: { ...(process.env as Record<string, string>) },
			})
			exitWatch = pty.onExit(({ exitCode }) =>
				exitCode === 0 ? resolve() : reject(new Error(`the test program stopped with ${exitCode}`)),
			)
			timer = setTimeout(
				() => reject(new Error('the test program did not finish in time')),
				timeoutMs,
			)
		})
	} finally {
		if (timer) clearTimeout(timer)
		try {
			exitWatch?.dispose()
			pty?.kill()
		} catch {
			// Already gone.
		}
	}
}

/**
 * Whether a pseudo-terminal can be opened here. `namzu workspaces` runs each session
 * in one; without it the command starts a single session instead, so this is a
 * warning with the way to get one, never a failure.
 */
export async function describePseudoTerminal(
	load: () => Promise<HostPtyModule> = () => loadHostPty(),
	probe: (binding: HostPtyModule) => Promise<void> = tryOneSession,
): Promise<DoctorCheckResult> {
	try {
		await probe(await load())
		return {
			status: 'pass',
			message:
				'A pseudo-terminal can be opened, so "namzu workspaces" can run sessions side by side.',
		}
	} catch (error) {
		const reason = (error instanceof Error ? error.message : String(error)).split('\n')[0]
		return {
			status: 'warn',
			message: `No pseudo-terminal can be opened here (${reason}), so "namzu workspaces" starts a single session instead.`,
			remediation:
				'Reinstall Namzu with optional packages enabled (npm install -g @namzu/cli, without --omit=optional). If your platform has no prebuilt component, install python3, make and a C++ compiler first, then reinstall.',
		}
	}
}

export const pseudoTerminalCheck: DoctorCheck = {
	id: 'terminal.pty',
	category: 'custom',
	run: (): Promise<DoctorCheckResult> => describePseudoTerminal(),
}
