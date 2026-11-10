/**
 * Where files go: the standing guidance on where a session puts what it
 * creates, so durable things do not land in a folder the model invented.
 *
 * The runtime knows its platform at boot, so only that platform's lines are
 * rendered. The text depends on nothing but the platform, which keeps the
 * system prompt prefix byte-stable from turn to turn.
 */

const PLATFORM_LINES: Readonly<Record<'linux' | 'darwin' | 'win32', string>> = {
	linux:
		'- App data, config, caches, logs: ~/.config, ~/.local/share, ~/.local/state, ~/.cache. A system-wide service (as root): /opt/<app>, /etc/<app>, /var/lib/<app>, /var/log/<app>, run by systemd.',
	darwin:
		'- App data, config, caches, logs: ~/Library/Application Support, ~/Library/Caches, ~/Library/Logs. A system-wide service (as admin): /usr/local/<app> or /opt/<app>, a LaunchDaemon in /Library/LaunchDaemons.',
	win32:
		'- App data, config, caches, logs: %APPDATA% and %LOCALAPPDATA%. A system-wide service (as admin): Program Files and ProgramData, run as a Windows service.',
}

const COMMON_LINES: readonly string[] = [
	'- Temporary work: the session scratchpad, or the OS temp folder.',
	'- A container stack: its compose and config files in a dedicated, named project folder the person agrees to; its data in named volumes.',
	'- A repository the person will work on: their projects folder. Ask when you do not know it.',
]

const RULES: readonly string[] = [
	'- Never create or delete a top-level entry in the home folder or the filesystem root without asking first, even when tools run without approval.',
	'- Tell the person the full path of every folder you create. Use `rm -rf` only on a path this session created and that you checked first.',
	'- A service, daemon, container stack or agent that keeps running is a service, not a terminal job. Run through this checklist:',
	'  - Identity: a dedicated service account with no login, not the person’s own account.',
	'  - Configuration: /opt/<vendor>/<service> or /usr/local/..., owned by root (Windows: Program Files, ProgramData).',
	'  - Data: /var/lib/<service> or a dedicated volume or disk (containers: named volumes).',
	'  - Logs: /var/log/<service> or the system journal.',
	'  - Supervisor: the system init (a systemd system unit, a LaunchDaemon that starts at boot, a Windows service), not a per-user agent or a terminal.',
	'  - Secrets: a secret store or key manager; change default passwords before the service is reachable.',
	'  - State: retention limits and backups, so data does not grow forever.',
	'  - Monitoring: watch the service itself, so someone is told if it dies.',
	'  - Host: a stable address on a server or VM, not a developer desktop or personal account. If it must run on a personal machine, say so as a limitation.',
	'- When the person’s setup forces a deviation (no root, a personal machine), name each item that deviates and why.',
	'- When a setup finishes, give a short receipt: what was installed, where, how it starts, how to remove it.',
]

/** The section for one platform; any platform that is not listed gets the Linux lines. */
export function composeFilePlacementGuidance(platform: NodeJS.Platform): string {
	const platformLine =
		PLATFORM_LINES[platform === 'darwin' || platform === 'win32' ? platform : 'linux']
	return [
		'# Where files go',
		'Put what you create where this platform expects it:',
		COMMON_LINES[0],
		platformLine,
		COMMON_LINES[1],
		COMMON_LINES[2],
		...RULES,
	].join('\n')
}
