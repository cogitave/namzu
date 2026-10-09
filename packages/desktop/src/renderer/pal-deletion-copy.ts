/** One consequence line. `title` is the longer form a pointer shows over it, never in the line. */
export interface DeletionLine {
	text: string
	title?: string
}

/** What deleting a Pal removes and what it leaves, one consequence per line. */
export function palDeletionCopy(pal: { name: string; workspace: string }): {
	description: string
	details: DeletionLine[]
} {
	return {
		description: `Here is what happens when you delete ${pal.name}.`,
		details: [
			{ text: `${pal.name} disappears from the sidebar and its computer is stopped.` },
			// The folder is a UUID path; the person sees a name, and the path lives in the tooltip and
			// behind Copy path.
			{
				text: `Its conversations are not deleted, and ${pal.name}’s files stay in its folder.`,
				title: pal.workspace,
			},
		],
	}
}
