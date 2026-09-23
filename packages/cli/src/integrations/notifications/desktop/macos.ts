/**
 * A macOS notification through `osascript`. The title and body are argv
 * items the script reads (`item 1 of argv`), never text spliced into it.
 */
export function osascriptArguments(title: string, body: string): string[] {
	return [
		'-e',
		'on run argv',
		'-e',
		'display notification (item 2 of argv) with title (item 1 of argv)',
		'-e',
		'end run',
		title,
		body,
	]
}
