import './restore-skeleton.css'

/**
 * Stands in for a conversation that is being brought back after a start: the outline of a
 * transcript and a composer, with no text claiming anything about the conversation.
 */
export function RestoreSkeleton() {
	return (
		<div className="restore-skeleton" data-skeleton="restore" aria-busy="true" aria-live="polite">
			<span className="sr-only">Restoring your conversation…</span>
			<div className="restore-skeleton-lane" aria-hidden="true">
				<div className="restore-skeleton-line restore-skeleton-line-short" />
				<div className="restore-skeleton-line" />
				<div className="restore-skeleton-line" />
				<div className="restore-skeleton-line restore-skeleton-line-medium" />
				<div className="restore-skeleton-composer" />
			</div>
		</div>
	)
}
