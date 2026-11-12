/** The one line a skipped plugin part adds to its message, for a plugin whose folder is not at hand. */
export const CHECK_HINT = 'Run `namzu plugin validate` in the plugin folder to see every problem.'

/** The same line naming the folder, when it is known. */
export function checkHint(folder: string): string {
	const shown = /^[\w@%+=:,./-]+$/.test(folder)
		? folder
		: `"${folder.replace(/(["\\$`])/g, '\\$1')}"`
	return `Run \`namzu plugin validate ${shown}\` to see every problem.`
}
