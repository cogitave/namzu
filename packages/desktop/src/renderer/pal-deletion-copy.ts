/** What deleting a Pal removes and what it leaves, one consequence per line. */
export function palDeletionCopy(pal: { name: string; workspace: string }): {
	description: string
	details: string[]
} {
	return {
		description: `Here is what happens when you delete ${pal.name}.`,
		details: [
			`${pal.name} disappears from the sidebar and its computer is stopped.`,
			`Its conversations and files are not deleted. They stay in ${pal.workspace}.`,
		],
	}
}
