import type { AcpSessionUpdate } from '@namzu/sdk'
import type { ThreadState } from '../shared/projection.js'
import { ChangesReview, type WorkingTreeSource } from './changes-review/review.js'

type Tool = Extract<AcpSessionUpdate, { kind: 'tool_call' }>

/**
 * The Changes pane: the files a conversation changed, stacked, against a base the person picks.
 * The review itself lives in ./changes-review; its controls sit in the pane's header.
 */
export function ChangesPanel({
	tools,
	timeline,
	dark,
	focus,
	source,
	refreshToken,
	scopeKey,
	projectRoot,
	onOpenFile,
	onOpenInEditor,
	onOpenWorkingFile,
	onOpenWorkingInEditor,
	onShowInFolder,
	onCopy,
}: {
	tools: Record<string, Tool>
	timeline?: ThreadState['timeline']
	dark: boolean
	/** The file to scroll to, when the person came from one file of a reply. */
	focus?: { path: string }
	source?: WorkingTreeSource
	refreshToken?: number
	scopeKey?: string
	projectRoot?: string
	onOpenFile?: (path: string) => void
	onOpenInEditor?: (path: string) => void
	onOpenWorkingFile?: (path: string) => void
	onOpenWorkingInEditor?: (path: string) => void
	onShowInFolder?: (path: string) => void
	onCopy?: (text: string, done: string) => void
}) {
	return (
		<ChangesReview
			tools={tools}
			timeline={timeline}
			dark={dark}
			focus={focus}
			source={source}
			refreshToken={refreshToken}
			scopeKey={scopeKey}
			projectRoot={projectRoot}
			onOpenFile={onOpenFile}
			onOpenInEditor={onOpenInEditor}
			onOpenWorkingFile={onOpenWorkingFile}
			onOpenWorkingInEditor={onOpenWorkingInEditor}
			onShowInFolder={onShowInFolder}
			onCopy={onCopy}
		/>
	)
}
