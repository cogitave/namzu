import { Menu } from '@base-ui/react/menu'
import { type Ref, useEffect, useRef, useState } from 'react'
import type { ProjectGitView, ProjectView } from '../shared/protocol.js'
import { type ChangeTotals, formatLineCount } from './changes-totals.js'
import type { ConversationSource } from './conversation-actions.js'
import { copyPlainText } from './copy-button.js'
import {
	FileDiffIcon,
	FileTextIcon,
	FolderIcon,
	GitBranchIcon,
	GitCommitIcon,
	ImageIcon,
	ListTodoIcon,
	MoreHorizontalIcon,
	PlusIcon,
	TerminalIcon,
} from './icons.js'
import { Button } from './ui/button.js'
import { Popover, PopoverPopup, PopoverTrigger } from './ui/popover.js'
import './conversation-details-popover.css'

export type DetailsWork =
	| { state: 'checking' }
	| { state: 'unavailable' }
	| { state: 'known'; running: number; needsAttention: boolean }

/** The icon button's label carries the count so the dot is not the only signal. */
export function detailsTriggerLabel(work: DetailsWork): string {
	if (work.state !== 'known') return 'Conversation details'
	const parts: string[] = []
	if (work.running > 0)
		parts.push(`${work.running} ${work.running === 1 ? 'process' : 'processes'} running`)
	if (work.needsAttention) parts.push('background work needs attention')
	return parts.length ? `Conversation details, ${parts.join(', ')}` : 'Conversation details'
}

function workSummary(work: DetailsWork): string {
	if (work.state === 'checking') return 'Checking…'
	if (work.state === 'unavailable') return 'Unavailable'
	if (work.needsAttention) return 'Needs attention'
	return work.running > 0 ? `${work.running} running` : 'None'
}

function SourceIcon({ kind }: { kind: 'image' | 'text' }) {
	return kind === 'image' ? <ImageIcon aria-hidden="true" /> : <FileTextIcon aria-hidden="true" />
}

const COLLAPSED_SOURCES = 3

export interface ConversationDetailsProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	triggerRef?: Ref<HTMLButtonElement>
	/** Absent for a conversation without a project, which then has no header or path. */
	project?: ProjectView
	totals: ChangeTotals
	/** Null hides the repository row. */
	git: ProjectGitView | null
	work: DetailsWork
	sources: readonly ConversationSource[]
	/** Why the "+" is unavailable, or undefined when it works. */
	attachReason?: string
	onOpenChanges: () => void
	onOpenWork: () => void
	onAttach: () => void
}

/** The single home of a conversation's project, changes, repository, background work and sources. */
export function ConversationDetailsPopover({
	open,
	onOpenChange,
	triggerRef,
	project,
	totals,
	git,
	work,
	sources,
	attachReason,
	onOpenChanges,
	onOpenWork,
	onAttach,
}: ConversationDetailsProps) {
	const [showAll, setShowAll] = useState(false)
	const [copied, setCopied] = useState<'' | 'done' | 'failed'>('')
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
	useEffect(() => () => clearTimeout(timer.current), [])
	useEffect(() => {
		if (!open) {
			setShowAll(false)
			setCopied('')
		}
	}, [open])
	const dot =
		work.state === 'known'
			? work.needsAttention
				? 'attention'
				: work.running > 0
					? 'running'
					: undefined
			: undefined
	const visible = showAll ? sources : sources.slice(0, COLLAPSED_SOURCES)
	const hasChanges = totals.added + totals.removed > 0
	const copyPath = async () => {
		if (!project) return
		try {
			await copyPlainText(project.path)
			setCopied('done')
		} catch {
			setCopied('failed')
		}
		clearTimeout(timer.current)
		timer.current = setTimeout(() => setCopied(''), 2000)
	}
	return (
		<Popover open={open} onOpenChange={onOpenChange}>
			<PopoverTrigger
				ref={triggerRef}
				render={
					<Button variant="ghost-muted" size="icon-sm" className="conversation-details-trigger" />
				}
				aria-label={detailsTriggerLabel(work)}
				title="Conversation details"
			>
				<ListTodoIcon className="size-4" aria-hidden="true" />
				{dot && <span className="conversation-details-dot" data-state={dot} aria-hidden="true" />}
			</PopoverTrigger>
			<PopoverPopup
				aria-label="Conversation details"
				align="end"
				padding="none"
				className="conversation-details-popup"
			>
				<div className="conversation-details">
					{project && (
						<div className="conversation-details-heading">
							<FolderIcon aria-hidden="true" />
							<h2 title={project.path}>{project.name}</h2>
							<Menu.Root>
								<Menu.Trigger
									render={<Button variant="ghost-muted" size="icon-xs" />}
									aria-label="Project actions"
								>
									<MoreHorizontalIcon aria-hidden="true" />
								</Menu.Trigger>
								<Menu.Portal>
									<Menu.Positioner
										className="conversation-actions-positioner"
										align="end"
										sideOffset={4}
									>
										<Menu.Popup className="conversation-actions-popup" aria-label="Project actions">
											<Menu.Item
												className="conversation-actions-item"
												onClick={() => void copyPath()}
											>
												<FolderIcon aria-hidden="true" />
												<span className="conversation-actions-label">Copy path</span>
											</Menu.Item>
										</Menu.Popup>
									</Menu.Positioner>
								</Menu.Portal>
							</Menu.Root>
						</div>
					)}
					<output className="conversation-details-status" aria-live="polite">
						{copied === 'done'
							? 'Path copied.'
							: copied === 'failed'
								? 'Could not copy the path.'
								: ''}
					</output>
					<button type="button" className="conversation-details-row" onClick={onOpenChanges}>
						<FileDiffIcon aria-hidden="true" />
						<span className="conversation-details-label">Changes</span>
						{hasChanges ? (
							<span className="conversation-details-totals">
								<span className="conversation-details-added">
									<span aria-hidden="true">+</span>
									<span className="sr-only">Added </span>
									{formatLineCount(totals.added)}
								</span>
								<span className="conversation-details-removed">
									<span aria-hidden="true">−</span>
									<span className="sr-only">Removed </span>
									{formatLineCount(totals.removed)}
								</span>
							</span>
						) : (
							<span className="conversation-details-value">No file changes yet</span>
						)}
					</button>
					{git && (
						<div
							className="conversation-details-row conversation-details-static"
							title={[git.branch ?? 'Detached', git.subject].filter(Boolean).join(' · ')}
						>
							{git.branch === null ? (
								<GitCommitIcon aria-hidden="true" />
							) : (
								<GitBranchIcon aria-hidden="true" />
							)}
							<span className="conversation-details-label">
								<span className="conversation-details-branch">{git.branch ?? 'Detached'}</span>
								{git.subject && <span className="conversation-details-subject">{git.subject}</span>}
							</span>
						</div>
					)}
					<button type="button" className="conversation-details-row" onClick={onOpenWork}>
						<TerminalIcon aria-hidden="true" />
						<span className="conversation-details-label">Background work</span>
						<span
							className="conversation-details-value"
							data-attention={work.state === 'known' && work.needsAttention ? '' : undefined}
						>
							{workSummary(work)}
						</span>
					</button>
					<section className="conversation-details-sources" aria-label="Sources">
						<div className="conversation-details-sources-heading">
							<h3>Sources</h3>
							<Button
								variant="ghost-muted"
								size="icon-xs"
								aria-label="Add files to the next message"
								title={attachReason ?? 'Add files to the next message'}
								disabled={!!attachReason}
								onClick={onAttach}
							>
								<PlusIcon aria-hidden="true" />
							</Button>
						</div>
						{sources.length === 0 ? (
							<p className="conversation-details-empty">Nothing attached yet</p>
						) : (
							<ul>
								{visible.map(({ key, attachment }) => (
									<li key={key} title={attachment.name}>
										<SourceIcon kind={attachment.kind} />
										<span>{attachment.name}</span>
									</li>
								))}
							</ul>
						)}
						{sources.length > COLLAPSED_SOURCES && (
							<button
								type="button"
								className="conversation-details-more"
								aria-expanded={showAll}
								onClick={() => setShowAll((value) => !value)}
							>
								{showAll ? 'Show fewer' : `View all (${sources.length})`}
							</button>
						)}
					</section>
				</div>
			</PopoverPopup>
		</Popover>
	)
}
