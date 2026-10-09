import { createContext, useContext } from 'react'
import type { ThreadState, TimelineEntry } from '../shared/projection.js'
import type { PalStartCard } from './pal-start-model.js'
import { palMessageName } from './tool-transcript-presentation.js'
import { Button } from './ui/button.js'
import './pal-message-receipts.css'

/** The completed message sends in a turn, with the tool call that made each one. */
export function palMessageSends(
	entries: readonly TimelineEntry[],
	thread: Pick<ThreadState, 'tools'>,
): { id: string; name: string }[] {
	const sends: { id: string; name: string }[] = []
	for (const entry of entries) {
		if (entry.kind !== 'tool') continue
		const tool = thread.tools[entry.id]
		if (!tool || tool.status !== 'completed' || tool.historicalStatus) continue
		const name = palMessageName(tool)
		if (name) sends.push({ id: entry.id, name })
	}
	return sends
}

/** The Pals a turn's completed messages went to, once each, in the order they were sent. */
export function palMessageRecipients(
	entries: readonly TimelineEntry[],
	thread: Pick<ThreadState, 'tools'>,
): string[] {
	return palMessageSends(entries, thread).map((send) => send.name)
}

/**
 * What the transcript needs to ask whether a Pal should start. Absent where the app cannot start
 * a Pal, so the line then reads as before.
 */
export interface PalStartControls {
	/** The card for a send; only the newest send to a Pal in the open conversation carries one. */
	card(palName: string, sendId: string): PalStartCard
	onStart(palName: string): void
	onNotNow(palName: string): void
	onResume(palName: string): void
	/** Opens the Pal's own tab, on the conversation its run wrote to. */
	onOpenPal(palName: string): void
}
export const PalStartContext = createContext<PalStartControls | undefined>(undefined)

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
	const sent = palMessageSends(entries, thread)
	const starts = useContext(PalStartContext)
	if (sent.length === 0) return null
	return (
		<ul className="pal-message-receipts" aria-label="Messages sent to Pals">
			{sent.map(({ id, name }) => (
				<li key={id}>
					<PalSentLine
						name={name}
						card={starts?.card(name, id) ?? { kind: 'none' }}
						starts={starts}
						onOpen={onOpen}
					/>
				</li>
			))}
		</ul>
	)
}

function PalSentLine({
	name,
	card,
	starts,
	onOpen,
}: {
	name: string
	card: PalStartCard
	starts: PalStartControls | undefined
	onOpen?: (palName: string) => void
}) {
	if (card.kind === 'none')
		return (
			<>
				<span>
					Sent to {name}’s inbox. {name} reads it the next time it runs.
				</span>
				{onOpen && (
					<Button variant="ghost-muted" size="xs" onClick={() => onOpen(name)}>
						See it in {name}’s messages
					</Button>
				)}
			</>
		)
	return (
		<>
			<span role={card.kind === 'failed' ? 'alert' : 'status'}>{card.text}</span>
			{card.kind === 'blocked' && (
				<>
					<Button variant="outline" size="xs" disabled>
						Start {name}
					</Button>
					{onOpen && (
						<Button variant="ghost-muted" size="xs" onClick={() => onOpen(name)}>
							See it in {name}’s messages
						</Button>
					)}
					<details className="pal-setup-help">
						<summary>How to set up</summary>
						<p>{card.help}</p>
					</details>
				</>
			)}
			{card.kind === 'ask' && (
				<>
					<Button variant="outline" size="xs" onClick={() => starts?.onStart(name)}>
						Start {name}
					</Button>
					<Button variant="ghost-muted" size="xs" onClick={() => starts?.onNotNow(name)}>
						Not now
					</Button>
					{onOpen && (
						<Button variant="ghost-muted" size="xs" onClick={() => onOpen(name)}>
							See it in {name}’s messages
						</Button>
					)}
				</>
			)}
			{card.kind === 'failed' && (
				<Button variant="outline" size="xs" onClick={() => starts?.onStart(name)}>
					Retry
				</Button>
			)}
			{card.kind === 'resume' && (
				<Button variant="outline" size="xs" onClick={() => starts?.onResume(name)}>
					Resume {name}
				</Button>
			)}
			{(card.kind === 'done' || (card.kind === 'reading' && card.openable)) && starts && (
				<Button variant="ghost-muted" size="xs" onClick={() => starts.onOpenPal(name)}>
					Open {name}
				</Button>
			)}
		</>
	)
}
