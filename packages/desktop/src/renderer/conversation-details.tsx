import { useMemo } from 'react'
import type { ThreadUsage } from '../shared/projection.js'
import { CUT_NOTE, type ChangeTotals, formatLineCount } from './changes-totals.js'
import { contextPanelModel } from './context-panel-model.js'
import { ContextInline, type ContextPanelSource, useContextPanel } from './context-panel.js'
import type { DetailsWork } from './conversation-details-popover.js'
import { FolderIcon, GitBranchIcon, MonitorIcon, TerminalIcon } from './icons.js'
import type { OutputFile } from './outputs-model.js'
import { OutputRow } from './outputs-panel.js'
import { Button } from './ui/button.js'
import './conversation-details.css'

const NO_SOURCE: ContextPanelSource = { ask: () => Promise.resolve(null) }

/** The tool servers a conversation has loaded, from the context report: a name and a tool count. */
export function toolServerRows(
	servers: { name: string; count: number }[] | undefined,
): { name: string; label: string }[] {
	return (servers ?? []).map((server) => ({
		name: server.name,
		label: `${server.count} ${server.count === 1 ? 'tool' : 'tools'}`,
	}))
}

export interface ConversationDetailsBodyProps {
	/** Where the conversation runs, in words: "This computer" unless it runs somewhere else. */
	where: string
	/** Absent for a conversation without a project, which then has no folder or branch row. */
	project?: { name: string; path: string }
	/** Null or absent hides the branch row. */
	branch?: string | null
	context?: ContextPanelSource
	usage?: ThreadUsage | undefined
	outputs: readonly OutputFile[]
	onOpenOutput: (path: string) => void
	totals: ChangeTotals
	onOpenChanges: () => void
	work: DetailsWork
	onOpenWork: () => void
}

/**
 * What a conversation is made of, in one column: where it runs, the context, the tool servers, the files
 * it wrote and the changes. The same body is a 320 px column beside the conversation on a wide window and
 * a tab of the side panel on a narrow one, so the two never differ.
 */
export function ConversationDetailsBody({
	where,
	project,
	branch,
	context,
	usage,
	outputs,
	onOpenOutput,
	totals,
	onOpenChanges,
	work,
	onOpenWork,
}: ConversationDetailsBodyProps) {
	const read = useContextPanel(context ?? NO_SOURCE, usage, Boolean(context))
	const servers = useMemo(
		() => (read.report ? contextPanelModel({ report: read.report }).servers : undefined),
		[read.report],
	)
	const tools = toolServerRows(servers?.list)
	const hasChanges = totals.added + totals.removed > 0
	const workShown = work.state === 'known' && (work.running > 0 || work.needsAttention)
	return (
		<div className="conversation-details-column" data-details-body>
			<section className="details-section" aria-label="Environment">
				<h3 className="details-heading">Environment</h3>
				<div className="details-row" data-details-row="where">
					<MonitorIcon aria-hidden="true" />
					<span className="details-row-text">{where}</span>
				</div>
				{project && (
					<div className="details-row" data-details-row="folder" title={project.path}>
						<FolderIcon aria-hidden="true" />
						<span className="details-row-text">{project.name}</span>
					</div>
				)}
				{branch ? (
					<div className="details-row" data-details-row="branch" title={branch}>
						<GitBranchIcon aria-hidden="true" />
						<span className="details-row-text">{branch}</span>
					</div>
				) : null}
			</section>
			{context ? (
				<section className="details-section details-context" aria-label="Context">
					<ContextInline read={read} usage={usage} compacting={context.compacting} />
				</section>
			) : null}
			{tools.length > 0 ? (
				<section className="details-section" aria-label="Tool servers">
					<h3 className="details-heading">Tool servers</h3>
					{tools.map((server) => (
						<div className="details-row" data-details-row="server" key={server.name}>
							<span className="details-dot" aria-hidden="true" />
							<span className="details-row-text">{server.name}</span>
							<span className="details-row-value">{server.label}</span>
						</div>
					))}
				</section>
			) : null}
			<section className="details-section" aria-label="Outputs">
				<h3 className="details-heading">Outputs</h3>
				{outputs.length === 0 ? (
					<p className="details-empty">Files this conversation writes show up here.</p>
				) : (
					<ul
						className="outputs-list details-outputs"
						aria-label="Files written in this conversation"
					>
						{outputs.map((file) => (
							<OutputRow key={file.path} file={file} onOpen={onOpenOutput} />
						))}
					</ul>
				)}
			</section>
			<section className="details-section" aria-label="Changes">
				<h3 className="details-heading">Changes</h3>
				{hasChanges ? (
					<div className="details-changes">
						<span className="details-added">
							<span aria-hidden="true">+</span>
							<span className="sr-only">Added </span>
							{formatLineCount(totals.added)}
						</span>
						<span className="details-removed">
							<span aria-hidden="true">−</span>
							<span className="sr-only">Removed </span>
							{formatLineCount(totals.removed)}
						</span>
						{totals.cut ? <span className="details-row-value">{CUT_NOTE}</span> : null}
					</div>
				) : (
					<p className="details-empty">No file changes yet.</p>
				)}
				<Button
					type="button"
					size="sm"
					variant="outline"
					className="details-changes-button"
					onClick={onOpenChanges}
				>
					{hasChanges ? 'Review changes' : 'Open changes'}
				</Button>
			</section>
			{workShown ? (
				<section className="details-section" aria-label="Background work">
					<h3 className="details-heading">Background work</h3>
					<button type="button" className="details-row details-row-button" onClick={onOpenWork}>
						<TerminalIcon aria-hidden="true" />
						<span className="details-row-text">
							{work.state === 'known' && work.needsAttention
								? 'Needs attention'
								: `${work.state === 'known' ? work.running : 0} running`}
						</span>
					</button>
				</section>
			) : null}
		</div>
	)
}
