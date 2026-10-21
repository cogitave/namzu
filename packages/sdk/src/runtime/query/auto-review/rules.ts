/**
 * The rules the auto-review classifier judges by, and how an operator's own
 * wording is merged with the built-in set.
 *
 * Three lists carry the judgement. A HARD rule names something the user's own
 * words cannot clear: the harm does not depend on whether they meant it. A SOFT
 * rule names something that is fine when the user asked for it specifically
 * and not otherwise. An ALLOW entry names an ordinary action that is not to be
 * blocked even where a soft rule's wording could be stretched to cover it. A
 * fourth list, the environment, tells the classifier what is trusted in this
 * installation (the organization, its repositories, its buckets).
 */

/** The entry that keeps the built-in rules at that position of a list. */
export const AUTO_REVIEW_DEFAULTS_MARKER = '$defaults'

/** An operator's additions to, or replacement of, the built-in rule lists. */
export interface AutoReviewRules {
	/** Ordinary actions never to block. */
	readonly allow?: readonly string[]
	/** Blocked unless the user's own messages name the action and its dangerous parameter. */
	readonly softDeny?: readonly string[]
	/** Blocked whatever the user said. */
	readonly hardDeny?: readonly string[]
	/** What is trusted here: the organization, repositories, domains, buckets, services. */
	readonly environment?: readonly string[]
}

/** The lists after `$defaults` entries have been expanded. */
export interface ResolvedAutoReviewRules {
	readonly allow: readonly string[]
	readonly softDeny: readonly string[]
	readonly hardDeny: readonly string[]
	readonly environment: readonly string[]
}

/** Harms the user's consent does not clear. */
export const DEFAULT_HARD_DENY: readonly string[] = [
	'Secret exfiltration: sending credentials, tokens, private keys or the contents of files that hold them to anyone outside this machine and the user (a network request, a paste service, an upload, a commit to a public place), or printing them where a third party will read them.',
	'Disabling security controls: turning off or weakening an antivirus, firewall, audit log, endpoint protection, TLS or certificate verification, or the permission checks of this very agent.',
	'Acting against third parties: scanning, attacking, spamming, impersonating or probing systems or people the user does not own and has not said they are authorised to test.',
	'Destroying data outside the project the user did not ask about: deleting, overwriting or encrypting files, databases, volumes or repositories that lie beyond this project and were not named in the request.',
]

/** Actions that are acceptable only when the user asked for them in so many words. */
export const DEFAULT_SOFT_DENY: readonly string[] = [
	'Git history destruction: force pushing, deleting remote branches or tags, resetting shared history, or rewriting commits others have pulled.',
	'Irreversible local deletion: removing files or directories that existed before this session, outside what a build or test cleans up.',
	'Deleting outside the project: rm or an equivalent aimed at a path beyond the working directory, or at a target that a variable could leave empty or broad.',
	'Production change: deploying, migrating, scaling, restarting or reconfiguring anything that serves real users or holds real data.',
	'Publishing: releasing a package, image or artifact to a public or shared registry, or making a repository or bucket public.',
	'Credential use: using a credential the user did not hand to the task (found in the environment, a keychain, an unrelated config file) to reach a service.',
	'Sending local data out: posting files, logs, source or command output to a network destination the user has not named, including pastebins and chat webhooks.',
	'System configuration: changing global git or shell configuration, startup files, scheduled jobs, services, kernel or network settings, or machine-wide tool configuration.',
	'System packages: installing, removing or upgrading software with a system package manager, or with sudo-equivalent rights.',
	'Running code from outside: downloading a script or binary and executing it, or piping a remote file into an interpreter, when the user did not point at that source.',
	'Persistence: adding an SSH key, a shell alias or function, a git hook, a cron entry or a login item that will run later without anyone asking.',
	'Permission grants: widening who can access a resource, a role, a token scope, a share link, or file modes beyond what the task needs.',
	'Bypassing review: skipping hooks or required checks (for example --no-verify), merging without the required review, or the agent approving its own change.',
	'Cloud and infrastructure destruction: deleting or mass-modifying cloud resources, clusters, databases or storage, or applying infrastructure changes nobody has planned.',
	'Self-modification: editing the permission settings, instructions, hooks or approval configuration of this agent itself.',
	'Interfering with other work: killing processes, jobs or sessions this task did not start, or changing shared resources other people use.',
	'Real-world transactions: purchases, payments, sending messages or e-mail to people, posting publicly.',
]

/** Ordinary actions that are not to be blocked. */
export const DEFAULT_ALLOW: readonly string[] = [
	'Local build, test, lint, format and type-check commands, and the files they produce inside the project.',
	'Creating, editing and deleting files inside the working directory that this session created or was asked to change.',
	'Reading anything: listing, searching, printing files, inspecting git history, status and diffs, or looking at a process list.',
	'Installing dependencies the project already declares (a manifest or lock file) into directories that belong to the project.',
	'Local git operations (add, commit, branch, checkout, stash, merge of local branches) and pushing the current work to the branch it came from.',
	'Using the system temporary directory for scratch files this session creates.',
	'Starting and stopping a development server or watcher the task itself started.',
]

function expand(
	supplied: readonly string[] | undefined,
	defaults: readonly string[],
): readonly string[] {
	if (supplied === undefined) return defaults
	const out: string[] = []
	for (const entry of supplied) {
		if (entry === AUTO_REVIEW_DEFAULTS_MARKER) out.push(...defaults)
		else if (entry.trim() !== '') out.push(entry.trim())
	}
	return out
}

/**
 * Merges an operator's lists with the built-in ones.
 *
 * A list left out keeps the built-in entries (the environment has none). A
 * list that is given replaces them, except that the entry `"$defaults"` stands
 * for the built-in entries at that position, so an operator can add to them
 * (`["$defaults", "my rule"]`) or put their own first. An empty list removes
 * the built-ins for that list altogether.
 */
export function resolveAutoReviewRules(rules?: AutoReviewRules): ResolvedAutoReviewRules {
	return {
		allow: expand(rules?.allow, DEFAULT_ALLOW),
		softDeny: expand(rules?.softDeny, DEFAULT_SOFT_DENY),
		hardDeny: expand(rules?.hardDeny, DEFAULT_HARD_DENY),
		environment: expand(rules?.environment, []),
	}
}
