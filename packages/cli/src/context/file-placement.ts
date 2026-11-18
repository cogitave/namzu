/**
 * Where files go: the standing guidance on where a session puts what it
 * creates, so durable things do not land in a folder the model invented.
 *
 * Two lines, the same on every platform and every turn, so the system prompt
 * prefix stays byte-stable. The longer advice about running a service (its
 * account, its supervisor, its logs and backups) is only needed by the few
 * turns that install one, so it is not carried here.
 */

export function composeFilePlacementGuidance(): string {
	return [
		'# Where files go',
		'Put temporary work in the session scratchpad or the OS temp folder, and tell the person the full path of every folder you create. Never create or delete a top-level entry in the home folder or the filesystem root without asking first.',
	].join('\n')
}
