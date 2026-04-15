import type { DisplayServer } from '@namzu/sdk'

/**
 * Inspects the runtime platform + environment variables to identify the
 * display server. On linux, prefers explicit `XDG_SESSION_TYPE`, then falls
 * back to `WAYLAND_DISPLAY`/`DISPLAY` env presence. Headless ssh sessions and
 * unknown platforms return 'unknown'.
 */
export function detectDisplayServer(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): DisplayServer {
	if (platform === 'darwin') return 'darwin'
	if (platform === 'win32') return 'win32'
	if (platform !== 'linux') return 'unknown'

	const sessionType = env.XDG_SESSION_TYPE?.toLowerCase()
	if (sessionType === 'wayland') return 'wayland'
	if (sessionType === 'x11') return 'x11'

	if (env.WAYLAND_DISPLAY) return 'wayland'
	if (env.DISPLAY) return 'x11'

	return 'unknown'
}
