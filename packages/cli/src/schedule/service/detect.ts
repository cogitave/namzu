/**
 * Which supervisor `schedule install --platform auto` picks.
 *
 * macOS → launchd; Windows → Task Scheduler; WSL → Task Scheduler through
 * `wsl.exe` (even when the distro runs systemd, because a unit inside the
 * distro cannot start the distro after a reboot); other Linux with a systemd
 * user manager → systemd. Anything else has no supported supervisor, and the
 * answer says to run `namzu schedule daemon` under one of your own.
 */

import { detectWsl } from '../../context/environment.js'
import type { ServicePlatform } from './manifest.js'

export type PlatformChoice = ServicePlatform | 'auto'

export function detectPlatform(
	options: {
		readonly platform?: NodeJS.Platform
		readonly env?: NodeJS.ProcessEnv
		readonly systemdUser?: boolean
	} = {},
): { platform: ServicePlatform } | { platform: null; reason: string } {
	const platform = options.platform ?? process.platform
	if (platform === 'darwin') return { platform: 'launchd' }
	if (platform === 'win32') return { platform: 'windows-task' }
	if (platform === 'linux') {
		if (detectWsl(options.env ?? process.env)) return { platform: 'wsl-windows-task' }
		if (options.systemdUser) return { platform: 'systemd-user' }
		return {
			platform: null,
			reason:
				'no systemd user manager answers here; run `namzu schedule daemon` under a supervisor of your own',
		}
	}
	return { platform: null, reason: `${platform} has no supported supervisor` }
}
