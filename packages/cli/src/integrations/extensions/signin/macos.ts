import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWrite } from '../store.js'
import {
	type Exec,
	LAUNCH_LABEL,
	type RegisterResult,
	type SigninRegistrar,
	type SigninSpec,
} from './registrar.js'

/** macOS: a LaunchAgent in the person's own folder, loaded for their own session only. */

const esc = (s: string): string =>
	s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function launchAgentPlist(spec: SigninSpec, label = LAUNCH_LABEL): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${esc(label)}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${esc(spec.launcher)}</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>ProcessType</key>
	<string>Background</string>
	<key>LimitLoadToSessionType</key>
	<string>Aqua</string>
</dict>
</plist>
`
}

export const bootstrapArgs = (uid: number, plist: string): string[] => [
	'bootstrap',
	`gui/${uid}`,
	plist,
]
export const bootoutArgs = (uid: number, label = LAUNCH_LABEL): string[] => [
	'bootout',
	`gui/${uid}/${label}`,
]

export class MacRegistrar implements SigninRegistrar {
	constructor(
		private readonly agentsDir: string,
		private readonly uid: number,
		private readonly exec: Exec,
		private readonly label = LAUNCH_LABEL,
	) {}
	private get plist(): string {
		return join(this.agentsDir, `${this.label}.plist`)
	}
	async status() {
		if (!existsSync(this.plist)) return { registered: false }
		const r = await this.exec('launchctl', ['print-disabled', `gui/${this.uid}`]).catch(
			() => undefined,
		)
		const off = r
			? new RegExp(`"${this.label.replace(/\./g, '\\.')}"\\s*=>\\s*(?:true|disabled)`).test(
					r.stdout,
				)
			: false
		return {
			registered: true,
			kind: 'launchagent' as const,
			...(off ? { disabledByOs: true } : {}),
		}
	}
	async register(spec: SigninSpec): Promise<RegisterResult> {
		try {
			mkdirSync(this.agentsDir, { recursive: true })
			atomicWrite(this.plist, launchAgentPlist(spec, this.label), 0o644)
			await this.exec('launchctl', bootoutArgs(this.uid, this.label)).catch(() => undefined)
			const r = await this.exec('launchctl', bootstrapArgs(this.uid, this.plist))
			// The agent is in place for the next sign-in even when loading it now failed.
			return r.code === 0 || existsSync(this.plist)
				? { ok: true, kind: 'launchagent' }
				: { ok: false, reason: r.stderr }
		} catch (e) {
			return { ok: false, reason: (e as Error).message }
		}
	}
	async unregister(): Promise<void> {
		await this.exec('launchctl', bootoutArgs(this.uid, this.label)).catch(() => undefined)
		rmSync(this.plist, { force: true })
	}
}
