/**
 * Whether a delegated child is told the parent's scratch folder.
 *
 * The folder is on the host. A sandboxed session's tools run elsewhere and do
 * not have it, and an ephemeral session's children are not given one, so in
 * both cases the child is told nothing rather than a path that does not exist
 * where it runs.
 */
export function childScratchpadFact(
	fact: () => { readonly scratchpadDirectory?: string },
	opts: { readonly ephemeral?: boolean; readonly sandboxed: boolean },
): { readonly scratchpadDirectory?: string } {
	return opts.ephemeral || opts.sandboxed ? {} : fact()
}
