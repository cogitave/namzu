/* Adapted UI component. License and provenance: packages/desktop/THIRD-PARTY-NOTICES.txt. */
import type { AcpSessionUpdate } from '@namzu/sdk'
import { useState } from 'react'
import { ChevronDownIcon, ChevronRightIcon, FileDiffIcon } from './icons.js'
import { Button } from './ui/button.js'

type Tool = Extract<AcpSessionUpdate, { kind: 'tool_call' }>
export function ChangedFilesCard({
	tools,
	onOpen,
}: { tools: Record<string, Tool>; onOpen: () => void }) {
	const [expanded, setExpanded] = useState(false)
	const changes = Object.entries(tools).filter(
		([, tool]) => tool.status === 'completed' && tool.view.kind === 'diff',
	)
	if (!changes.length) return null
	return (
		<div
			className="@container/changed-files mt-4 rounded-lg bg-secondary dark:bg-input/20"
			data-changed-files-state={expanded ? 'tree' : 'collapsed'}
		>
			<div
				data-changed-files-header
				className="sticky top-2 z-10 flex items-center justify-between gap-2 rounded-t-lg bg-secondary px-3 py-2 dark:bg-background dark:bg-linear-to-b dark:from-input/20 dark:to-input/20"
			>
				<button
					type="button"
					aria-expanded={expanded}
					onClick={() => setExpanded(!expanded)}
					className="flex min-w-0 items-center gap-2 rounded-sm text-xs font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
				>
					{expanded ? (
						<ChevronDownIcon className="size-3" />
					) : (
						<ChevronRightIcon className="size-3" />
					)}
					<span>
						{changes.length} completed file {changes.length === 1 ? 'change' : 'changes'}
					</span>
				</button>
				<Button
					type="button"
					size="xs"
					variant="ghost-muted"
					aria-label="Open diff"
					onClick={onOpen}
				>
					<FileDiffIcon className="size-3" />
					<span className="hidden @[24rem]/changed-files:inline">Open diff</span>
				</Button>
			</div>
			{expanded && (
				<div className="px-2 pb-2">
					{changes.map(
						([receiptId, tool]) =>
							tool.view.kind === 'diff' && (
								<button
									key={receiptId}
									type="button"
									className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
									onClick={onOpen}
								>
									<FileDiffIcon className="size-3.5 shrink-0" />
									<span className="truncate">{tool.view.path || tool.view.label || 'File'}</span>
								</button>
							),
					)}
				</div>
			)}
		</div>
	)
}
