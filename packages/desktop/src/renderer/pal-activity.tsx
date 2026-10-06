import type { ThreadState } from '../shared/projection.js'
import { ToolTranscriptRow } from './tool-transcript-row.js'

/** Tool receipts stay in their admitted order and retain their actual presentation. */
export function palToolActivity(thread: ThreadState) {
	return thread.timeline.flatMap((entry) => {
		const tool = entry.kind === 'tool' ? thread.tools[entry.id] : undefined
		return tool && entry.kind === 'tool' ? [{ id: entry.id, tool }] : []
	})
}

export function PalActivity({ thread }: { thread: ThreadState }) {
	const activity = palToolActivity(thread)
	return (
		<section aria-label="Pal actions" className="pal-activity">
			{activity.length === 0 ? (
				<p className="quiet">No retained actions in this view.</p>
			) : (
				<div className="tool-list">
					{activity.map(({ id }) => (
						<ToolTranscriptRow key={id} thread={thread} id={id} />
					))}
				</div>
			)}
		</section>
	)
}
