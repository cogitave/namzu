import type { DoctorCheck, DoctorCheckResult } from '@namzu/sdk'

import { type HostPtyModule, loadHostPty } from '../../terminal/pty.js'

/** Starts a program that ends at once, and resolves with how it ended. */
async function tryOneSession(binding: HostPtyModule): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const pty = binding.spawn(process.execPath, ['-e', ''], {
			name: 'xterm-256color',
			cols: 20,
			rows: 5,
			cwd: process.cwd(),
			env: { ...(process.env as Record<string, string>) },
		})
		pty.onExit(({ exitCode }) =>
			exitCode === 0 ? resolve() : reject(new Error(`the test program stopped with ${exitCode}`)),
		)
	})
}

/**
 * Whether a pseudo-terminal can be opened here. `namzu spaces` runs each session
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
			message: 'A pseudo-terminal can be opened, so "namzu spaces" can run sessions side by side.',
		}
	} catch (error) {
		const reason = (error instanceof Error ? error.message : String(error)).split('\n')[0]
		return {
			status: 'warn',
			message: `No pseudo-terminal can be opened here (${reason}), so "namzu spaces" starts a single session instead.`,
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
