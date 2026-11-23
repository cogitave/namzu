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
		"Keep your folders to what was asked for. Everything else goes in the session's scratch folder, never in the working directory or the home folder: logs, saved output, helper and reproduction scripts, intermediate data (a merged or converted copy included), backup copies, staging folders. Use the shared temp folder only when the person asks. A file they asked for goes where they said, or where the project keeps such files. A backup copy goes in the scratch folder, not beside the file.",
		"Do not create documentation, report or README files unless the person asked for one; answer in the reply. A file they ask for follows the project's own file names and folders; with none, a lowercase, hyphenated English name with no spaces in a docs folder. If the project's README or docs list its files, add the new one to that list. A file that must hold a command's output gets the real output by redirect or copy, never retyped.",
		'Give a full path only when the person needs it, such as where a file was saved. Never create or delete a top-level entry in the home folder or the filesystem root without asking first.',
	].join('\n')
}
