import type { ThreadState, TimelineEntry } from '../shared/projection.js'
import { palMessageName } from './tool-transcript-presentation.js'
import { Button } from './ui/button.js'
import './pal-message-receipts.css'

/** The Pals a turn's completed messages went to, once each, in the order they were sent. */
export function palMessageRecipients(
	entries: readonly TimelineEntry[],
	thread: Pick<ThreadState, 'tools'>,
): string[] {
	const names: string[] = []
	for (const entry of entries) {
		if (entry.kind !== 'tool') continue
		const tool = thread.tools[entry.id]
		if (!tool || tool.status !== 'completed' || tool.historicalStatus) continue
		const name = palMessageName(tool)
		if (name) names.push(name)
	}
	return names
}

/**
 * The visible record that a message left this conversation. The tool step itself folds away with
 * the rest of the work, so this line stays in the transcript and leads to the Pal's messages.
 */
export function PalMessageReceipts({
	entries,
	thread,
	onOpen,
}: {
	entries: readonly TimelineEntry[]
	thread: Pick<ThreadState, 'tools'>
	onOpen?: (palName: string) => void
}) {
	const sent = palMessageRecipients(entries, thread)
	if (sent.length === 0) return null
	return (
		<ul className="pal-message-receipts" aria-label="Messages sent to Pals">
			{sent.map((name, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: the same Pal can be messaged twice in one turn
				<li key={`${name}:${index}`}>
					<span>
						Sent to {name}’s inbox. {name} reads it the next time it runs.
					</span>
					{onOpen && (
						<Button variant="ghost-muted" size="xs" onClick={() => onOpen(name)}>
							See it in {name}’s messages
						</Button>
					)}
				</li>
			))}
		</ul>
	)
}
