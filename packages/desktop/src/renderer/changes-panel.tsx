import type { AcpSessionUpdate } from '@namzu/sdk'
import type { ThreadState } from '../shared/projection.js'
import { ChangesReview, type WorkingTreeSource } from './changes-review/review.js'

type Tool = Extract<AcpSessionUpdate, { kind: 'tool_call' }>

/**
 * The Changes tab: the exact before and after of completed edits, and, where the project is a
 * git repository, the working tree against HEAD. The review view lives in ./changes-review.
 */
export function ChangesPanel({
	tools,
	timeline,
	dark,
	receiptIds,
	focus,
	onShowAll,
	source,
	refreshToken,
	onOpenFile,
	onOpenInEditor,
	onOpenWorkingFile,
	onOpenWorkingInEditor,
	onCopy,
}: {
	tools: Record<string, Tool>
	/** Gives "Last reply" its meaning; without it only a chosen reply can be shown. */
	timeline?: ThreadState['timeline']
	dark: boolean
	/** Show this reply's receipts; `onShowAll` leaves it. */
	receiptIds?: readonly string[]
	/** The file to select first, when the person came from one file of that reply. */
	focus?: { path: string }
	onShowAll?: () => void
	source?: WorkingTreeSource
	refreshToken?: number
	onOpenFile?: (path: string) => void
	onOpenInEditor?: (path: string) => void
	onOpenWorkingFile?: (path: string) => void
	onOpenWorkingInEditor?: (path: string) => void
	onCopy?: (text: string, done: string) => void
}) {
	return (
		<ChangesReview
			tools={tools}
			timeline={timeline}
			dark={dark}
			receiptIds={receiptIds}
			focus={focus}
			onShowAll={onShowAll}
			source={source}
			refreshToken={refreshToken}
			onOpenFile={onOpenFile}
			onOpenInEditor={onOpenInEditor}
			onOpenWorkingFile={onOpenWorkingFile}
			onOpenWorkingInEditor={onOpenWorkingInEditor}
			onCopy={onCopy}
		/>
	)
}
