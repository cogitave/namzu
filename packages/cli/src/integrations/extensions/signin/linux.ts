import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWrite } from '../store.js'
import {
	type RegisterResult,
	type SigninRegistrar,
	type SigninSpec,
	XDG_FILE,
} from './registrar.js'

/**
 * Linux: an XDG autostart file. It runs in a desktop session only; a server or an ssh login does not
 * start it (there `namzu extension run` under the owner's own service manager is the answer).
 * `Hidden=true` or `X-GNOME-Autostart-enabled=false` set by the person is respected.
 */

/**
 * A path in an `Exec=` line: quoted, with the quote, backtick and dollar sign escaped by one backslash,
 * a literal backslash written as four (the entry format applies its own escape first), and `%` doubled
 * so it is not read as a field code.
 */
export function desktopQuote(path: string): string {
	const body = path
		.replace(/\\/g, '\\\\\\\\')
		.replace(/(["`$])/g, '\\$1')
		.replace(/%/g, '%%')
	return `"${body}"`
}

export function desktopEntry(spec: SigninSpec): string {
	return [
		'[Desktop Entry]',
		'Type=Application',
		'Name=Namzu extension runner',
		'Comment=Starts the extensions you chose to run when you sign in',
		`Exec=${desktopQuote(spec.launcher)}`,
		'Terminal=false',
		'X-GNOME-Autostart-enabled=true',
		'',
	].join('\n')
}

export function autostartDir(env: { XDG_CONFIG_HOME?: string; HOME?: string }): string {
	const base = env.XDG_CONFIG_HOME || join(env.HOME ?? '', '.config')
	return join(base, 'autostart')
}

export class LinuxRegistrar implements SigninRegistrar {
	constructor(private readonly dir: string) {}
	private get file(): string {
		return join(this.dir, XDG_FILE)
	}
	async status() {
		if (!existsSync(this.file)) return { registered: false }
		let text = ''
		try {
			text = readFileSync(this.file, 'utf8')
		} catch {
			return { registered: false }
		}
		const off =
			/^Hidden\s*=\s*true\s*$/im.test(text) ||
			/^X-GNOME-Autostart-enabled\s*=\s*false\s*$/im.test(text)
		return { registered: true, kind: 'xdg' as const, ...(off ? { disabledByOs: true } : {}) }
	}
	async register(spec: SigninSpec): Promise<RegisterResult> {
		try {
			mkdirSync(this.dir, { recursive: true })
			// A file the person switched off is left exactly as they left it.
			if (existsSync(this.file)) {
				const cur = readFileSync(this.file, 'utf8')
				if (
					/^Hidden\s*=\s*true\s*$/im.test(cur) ||
					/^X-GNOME-Autostart-enabled\s*=\s*false\s*$/im.test(cur)
				)
					return { ok: true, kind: 'xdg' }
			}
			atomicWrite(this.file, desktopEntry(spec), 0o644)
			return { ok: true, kind: 'xdg' }
		} catch (e) {
			return { ok: false, reason: (e as Error).message }
		}
	}
	async unregister(): Promise<void> {
		rmSync(this.file, { force: true })
	}
}
