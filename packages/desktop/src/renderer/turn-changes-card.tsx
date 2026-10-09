import { Undo2 } from 'lucide-react'
import { useState } from 'react'
import { formatLineCount } from './changes-totals.js'
import { ChevronDownIcon, ChevronRightIcon, FileDiffIcon } from './icons.js'
import { clockLabel } from './time-format.js'
import type { TurnChanges } from './turn-changes.js'
import { Button } from './ui/button.js'
import { type UndoCardView, partialLabel } from './undo-model.js'
import './turn-changes-card.css'

function undoneAt(at: number): string {
	return clockLabel(at)
}

/** The one place a reply's undo state shows: only ever what the CLI's status says. */
function UndoControl({ view, onUndo }: { view: UndoCardView; onUndo: () => void }) {
	if (view.kind === 'undone')
		return (
			<span className="turn-changes-undone-chip" data-undo-state="undone">
				{view.at ? `Undone at ${undoneAt(view.at)}` : 'Undone'}
			</span>
		)
	if (view.kind === 'partial')
		return (
			<Button
				type="button"
				size="xs"
				variant="outline"
				className="turn-changes-open"
				data-undo-state="partial"
				onClick={onUndo}
			>
				{partialLabel(view.kept)}
			</Button>
		)
	const disabled = view.kind === 'disabled'
	return (
		<Button
			type="button"
			size="xs"
			variant={disabled ? 'ghost-muted' : 'ghost'}
			className="turn-changes-open"
			data-undo-state={disabled ? 'disabled' : 'enabled'}
			aria-disabled={disabled || undefined}
			title={disabled ? view.reason : 'Put the files this reply edited back'}
			onClick={disabled ? undefined : onUndo}
		>
			{disabled ? view.reason : 'Undo'}
			<Undo2 aria-hidden="true" />
		</Button>
	)
}

function Totals({ added, removed }: { added: number; removed: number }) {
	return (
		<span className="turn-changes-totals">
			<span className="turn-changes-added">
				<span aria-hidden="true">+</span>
				<span className="sr-only">Added </span>
				{formatLineCount(added)}
			</span>
			<span className="turn-changes-removed">
				<span aria-hidden="true">−</span>
				<span className="sr-only">Removed </span>
				{formatLineCount(removed)}
			</span>
		</span>
	)
}

/** What one reply edited, under that reply; the diffs themselves live in the Changes drawer. */
export function TurnChangesCard({
	changes,
	onOpen,
	onOpenFile,
	undo,
	onUndo,
}: {
	changes: TurnChanges
	onOpen: (receiptIds: string[], path?: string) => void
	/** Shows the file itself, not its diff; absent where the project's files are not available. */
	onOpenFile?: (path: string) => void
	/** Absent hides Undo: still streaming, nothing covered, or an older CLI. */
	undo?: UndoCardView
	onUndo?: () => void
}) {
	const [expanded, setExpanded] = useState(false)
	const [only] = changes.files.length === 1 ? changes.files : []
	return (
		<section
			className="turn-changes"
			aria-label="Files edited in this reply"
			data-turn-changes={changes.turn}
			data-changed-files-state={only ? 'single' : expanded ? 'tree' : 'collapsed'}
			data-undo={undo?.kind}
		>
			<div className="turn-changes-head">
				{only ? (
					<>
						<FileDiffIcon className="turn-changes-icon" aria-hidden="true" />
						<span className="turn-changes-title" title={only.path}>
							<span>Edited </span>
							<strong>{only.name}</strong>
						</span>
					</>
				) : (
					<button
						type="button"
						className="turn-changes-toggle"
						aria-expanded={expanded}
						onClick={() => setExpanded(!expanded)}
					>
						<FileDiffIcon className="turn-changes-icon" aria-hidden="true" />
						<span className="turn-changes-title">
							<span>Edited </span>
							<strong>{changes.files.length} files</strong>
						</span>
						{expanded ? (
							<ChevronDownIcon className="turn-changes-chevron" aria-hidden="true" />
						) : (
							<ChevronRightIcon className="turn-changes-chevron" aria-hidden="true" />
						)}
					</button>
				)}
				<Totals added={changes.added} removed={changes.removed} />
				{only && onOpenFile && (
					<Button
						type="button"
						size="xs"
						variant="ghost-muted"
						className="turn-changes-open"
						onClick={() => onOpenFile(only.path)}
					>
						Open file
					</Button>
				)}
				{undo && onUndo && <UndoControl view={undo} onUndo={onUndo} />}
				<Button
					type="button"
					size="xs"
					variant="outline"
					className="turn-changes-open"
					onClick={() => onOpen(changes.receiptIds)}
				>
					View changes
				</Button>
			</div>
			{!only && expanded && (
				<ul className="turn-changes-files">
					{changes.files.map((file, index) => (
						<li key={`${index}:${file.path}`} className="turn-changes-row">
							<button
								type="button"
								className="turn-changes-file"
								title={file.path}
								onClick={() => onOpen(changes.receiptIds, file.path)}
							>
								<span className="turn-changes-file-name">{file.name}</span>
								<Totals added={file.added} removed={file.removed} />
							</button>
							{onOpenFile && (
								<Button
									type="button"
									size="xs"
									variant="ghost-muted"
									className="turn-changes-open"
									aria-label={`Open ${file.name}`}
									onClick={() => onOpenFile(file.path)}
								>
									Open file
								</Button>
							)}
						</li>
					))}
				</ul>
			)}
		</section>
	)
}
