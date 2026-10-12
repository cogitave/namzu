import type { ConversationView, ProjectView } from '../shared/protocol.js'
import { ArchiveRestoreIcon } from './file-panel/file-icons.js'
import { ROW_TITLE_CHARS, shortenTitle } from './short-title.js'
import { relativeAge } from './sidebar-hover-card.js'
import { Button } from './ui/button.js'
import { Tooltip, TooltipPopup, TooltipTrigger } from './ui/tooltip.js'
import './thread-card.css'

/**
 * An archived conversation drawn like a Recents row. The app cannot open a conversation without
 * bringing it back, so the row is not a button: Restore, on hover or focus, is its one action.
 */
export function ArchivedThreadRow({
	conversation,
	project,
	busy,
	onRestore,
}: {
	conversation: ConversationView
	project: ProjectView
	/** A restore is running; no second one starts until it ends. */
	busy: boolean
	onRestore: (view: ConversationView) => void
}) {
	return (
		<li
			className="sidebar-thread-item sidebar-archived-row relative list-none"
			data-thread-item
			data-archived-row={conversation.id}
			data-removable
			data-action-count="1"
		>
			<div className="sidebar-conversation-button relative w-full overflow-hidden rounded-md text-left text-sidebar-foreground select-none hover:bg-sidebar-row-hover">
				<div className="conversation-row">
					<span className="conversation-row-title" title={conversation.title}>
						{shortenTitle(conversation.title, ROW_TITLE_CHARS)}
					</span>
					<span className="conversation-row-project" title={project.name}>
						{project.name}
					</span>
					<span className="conversation-row-state">
						<span className="conversation-age">
							{relativeAge(conversation.updatedAt, Date.now())}
						</span>
					</span>
				</div>
			</div>
			<div className="sidebar-thread-actions">
				<Tooltip>
					<TooltipTrigger
						render={
							<Button
								variant="ghost-muted"
								size="icon-xs"
								className="sidebar-thread-action"
								aria-label={`Restore ${conversation.title}`}
								aria-disabled={busy || undefined}
								onClick={() => {
									if (!busy) onRestore(conversation)
								}}
							/>
						}
					>
						<ArchiveRestoreIcon aria-hidden="true" />
					</TooltipTrigger>
					<TooltipPopup side="right" sideOffset={8}>
						Restore
					</TooltipPopup>
				</Tooltip>
			</div>
		</li>
	)
}
