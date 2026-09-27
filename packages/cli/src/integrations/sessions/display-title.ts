/** Preserve saved titles while replacing the old scheduled-run clock in text output. */
export function displayConversationTitle(title: string): string {
	return /^⏲ .+ · .+$/u.test(title) ? `Scheduled: ${title.slice(2)}` : title
}
