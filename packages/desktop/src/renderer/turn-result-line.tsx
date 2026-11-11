import { Menu } from '@base-ui/react/menu'
import { Undo2 } from 'lucide-react'
import { largestFile } from './changes-review/model.js'
import { CUT_NOTE, formatLineCount } from './changes-totals.js'
import { ChevronRightIcon, CopyIcon, MoreHorizontalIcon } from './icons.js'
import type { TurnChanges } from './turn-changes.js'
import type { ResultLineModel } from './turn-result-model.js'
import { type UndoCardView, partialLabel } from './undo-model.js'
import './conversation-actions-menu.css'
import './turn-result-line.css'

/** The most files the "..." menu lists by name; the rest are one click away in the changes pane. */
const MENU_FILES = 8

function UndoItem({ view, onUndo }: { view: UndoCardView; onUndo: () => void }) {
	if (view.kind === 'undone') return null
	const disabled = view.kind === 'disabled'
	return (
		<Menu.Item
			className="conversation-actions-item"
			disabled={disabled}
			data-undo-state={view.kind === 'partial' ? 'partial' : disabled ? 'disabled' : 'enabled'}
			title={disabled ? view.reason : 'Put the files this reply edited back'}
			onClick={onUndo}
		>
			<Undo2 aria-hidden="true" />
			<span className="conversation-actions-label">
				{disabled ? view.reason : view.kind === 'partial' ? partialLabel(view.kept) : 'Undo'}
			</span>
		</Menu.Item>
	)
}

/**
 * The foot of a finished turn: one 40 px row that says how it ended, how big the change is and
 * what the kernel's record says about checking it. The row opens the changes pane; Undo, Open
 * file and Copy summary are in the "..." at its end.
 */
export function TurnResultLine({
	model,
	changes,
	onOpen,
	onOpenFile,
	undo,
	onUndo,
	onCopy,
}: {
	model: ResultLineModel
	/** Absent when no receipt carried the edits: there is no pane to open. */
	changes?: TurnChanges
	onOpen?: (receiptIds: string[], path?: string) => void
	/** Shows the file itself, not its diff; absent where the project's files are not available. */
	onOpenFile?: (path: string) => void
	/** Absent hides Undo: still streaming, nothing covered, or an older CLI. */
	undo?: UndoCardView
	onUndo?: () => void
	onCopy?: (text: string) => void
}) {
	const opens = changes && onOpen
	const body = (
		<>
			<span className="turn-result-mark" data-tone={model.tone} aria-hidden="true" />
			<span className="turn-result-lead">
				{model.lead}
				{model.duration ? ` in ${model.duration}` : ''}
			</span>
			{model.files > 0 && (
				<span className="turn-result-size" aria-hidden="true">
					<span className="turn-result-files">
						{model.files} {model.files === 1 ? 'file' : 'files'}
					</span>
					{model.added !== undefined && model.removed !== undefined && (
						<span className="turn-result-counts">
							<span className="turn-result-added">+{formatLineCount(model.added)}</span>
							<span className="turn-result-removed">−{formatLineCount(model.removed)}</span>
						</span>
					)}
				</span>
			)}
			{model.cut && (
				<span className="turn-result-cut" aria-hidden="true">
					{CUT_NOTE}
				</span>
			)}
			{model.check && (
				<span
					className="turn-result-check"
					data-tone={model.check.tone}
					title={model.check.text}
					aria-hidden="true"
				>
					{model.check.text}
				</span>
			)}
			{opens && <ChevronRightIcon className="turn-result-chevron" aria-hidden="true" />}
		</>
	)
	const listed = changes?.files.slice(0, MENU_FILES) ?? []
	const only = changes?.files.length === 1 ? changes.files[0] : undefined
	return (
		<section
			className="turn-result"
			aria-label="Result of this reply"
			data-turn-result={changes?.turn}
			data-tone={model.tone}
			data-check={model.check?.tone}
			data-undo={undo?.kind}
		>
			{opens ? (
				<button
					type="button"
					className="turn-result-main"
					aria-label={`${model.label}. Open changes`}
					onClick={() => onOpen(changes.receiptIds, largestFile(changes.files)?.path)}
				>
					{body}
				</button>
			) : (
				<p className="turn-result-main" data-static>
					<span className="sr-only">{model.label}</span>
					{body}
				</p>
			)}
			<Menu.Root>
				<Menu.Trigger
					className="turn-result-more"
					aria-label="More about this reply"
					title="Undo, open a file, copy a summary"
				>
					<MoreHorizontalIcon aria-hidden="true" />
				</Menu.Trigger>
				<Menu.Portal>
					<Menu.Positioner className="conversation-actions-positioner" align="end" sideOffset={6}>
						<Menu.Popup className="conversation-actions-popup" aria-label="This reply">
							{undo && onUndo && <UndoItem view={undo} onUndo={onUndo} />}
							{onOpenFile &&
								listed.map((file) => (
									<Menu.Item
										key={file.path}
										className="conversation-actions-item"
										title={file.path}
										onClick={() => onOpenFile(file.path)}
									>
										<span className="conversation-actions-label">
											{only ? 'Open file' : `Open ${file.name}`}
										</span>
									</Menu.Item>
								))}
							{onCopy && (
								<Menu.Item
									className="conversation-actions-item"
									onClick={() => onCopy(model.summary)}
								>
									<CopyIcon aria-hidden="true" />
									<span className="conversation-actions-label">Copy summary</span>
								</Menu.Item>
							)}
						</Menu.Popup>
					</Menu.Positioner>
				</Menu.Portal>
			</Menu.Root>
		</section>
	)
}
