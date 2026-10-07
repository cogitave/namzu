import { useState } from 'react'
import { formatLineCount } from './changes-totals.js'
import { ChevronDownIcon, ChevronRightIcon, FileDiffIcon } from './icons.js'
import type { TurnChanges } from './turn-changes.js'
import { Button } from './ui/button.js'
import './turn-changes-card.css'

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
}: {
	changes: TurnChanges
	onOpen: (receiptIds: string[]) => void
	/** Shows the file itself, not its diff; absent where the project's files are not available. */
	onOpenFile?: (path: string) => void
}) {
	const [expanded, setExpanded] = useState(false)
	const [only] = changes.files.length === 1 ? changes.files : []
	return (
		<section
			className="turn-changes"
			aria-label="Files edited in this reply"
			data-turn-changes={changes.turn}
			data-changed-files-state={only ? 'single' : expanded ? 'tree' : 'collapsed'}
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
								onClick={() => onOpen(file.receiptIds)}
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
