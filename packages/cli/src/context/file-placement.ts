/**
 * Where files go: the standing guidance on where a session puts what it
 * creates, so nothing the person did not ask for lands in their project or
 * their home folder, and durable things do not land in a folder the model
 * invented.
 *
 * The same on every platform and every turn, so the system prompt prefix stays
 * byte-stable. The session's scratch folder is a path that differs for every
 * session, so it is named in the environment facts and not here. The longer
 * advice about running a service (its account, its supervisor, its logs and
 * backups) is only needed by the few turns that install one, so it is not
 * carried here.
 */

export function composeFilePlacementGuidance(): string {
	return [
		'# Where files go',
		"Keep your folders to what was asked for. Everything else goes in the session's scratch folder, never in the working directory or the home folder: logs, saved output, helper and reproduction scripts, intermediate data (a merged or converted copy included), backup copies, staging folders. Use the shared temp folder only when the person asks. A file they asked for goes where they said, or where the project keeps such files. Edits can be rewound, so leave no backup beside a file.",
		'Give the person the full path of any file or folder you name to them. Never create or delete a top-level entry in the home folder or the filesystem root without asking first.',
	].join('\n')
}
