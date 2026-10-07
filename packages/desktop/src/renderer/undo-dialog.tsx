import { Dialog } from '@base-ui/react/dialog'
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
	DesktopUndoFile,
	DesktopUndoOptions,
	DesktopUndoPreview,
	DesktopUndoResult,
} from '../shared/protocol.js'
import { Button } from './ui/button.js'
import {
	SHELL_WARNING,
	type UndoChoices,
	canKeepCopy,
	conflictText,
	normalizeChoices,
	primaryLabel,
	queuedWarning,
	resolutionsFor,
	skipText,
	summarize,
} from './undo-model.js'
import './undo-dialog.css'

function actionLabel(file: DesktopUndoFile): string {
	if (file.action === 'restore') return 'Restore'
	if (file.action === 'delete') return 'Delete'
	if (file.action === 'noop') return 'Already as before'
	return 'Conflict'
}

function Row({
	file,
	choice,
	onChoice,
	disabled,
}: {
	file: DesktopUndoFile
	choice: 'skip' | 'keep_copy'
	onChoice: (choice: 'skip' | 'keep_copy') => void
	disabled: boolean
}) {
	const name = `undo-choice:${file.turnId}:${file.path}`
	return (
		<li className="undo-row" data-action={file.action} data-reason={file.reason}>
			<span className="undo-row-action" data-kind={file.action}>
				{actionLabel(file)}
			</span>
			<span className="undo-row-path" title={file.path}>
				{file.rel}
			</span>
			{file.action === 'conflict' && (
				<div className="undo-row-conflict">
					<span className="undo-row-reason">
						{file.reason ? conflictText[file.reason] : 'Left alone'}
					</span>
					{canKeepCopy(file) ? (
						<fieldset className="undo-choices" disabled={disabled}>
							<legend className="sr-only">What to do with {file.rel}</legend>
							<label>
								<input
									type="radio"
									name={name}
									checked={choice === 'skip'}
									onChange={() => onChoice('skip')}
								/>
								Skip
							</label>
							<label>
								<input
									type="radio"
									name={name}
									checked={choice === 'keep_copy'}
									onChange={() => onChoice('keep_copy')}
								/>
								Restore anyway, keep my copy
							</label>
						</fieldset>
					) : (
						<span className="undo-row-skipped">Skipped</span>
					)}
				</div>
			)}
		</li>
	)
}

/** The plan, as the CLI computed it. Presentational so every state renders without a window. */
export function UndoPlanBody({
	preview,
	choices,
	onChoice,
	alsoLater,
	onAlsoLater,
	queued,
	notice,
	disabled = false,
}: {
	preview: DesktopUndoPreview
	choices: UndoChoices
	onChoice: (path: string, choice: 'skip' | 'keep_copy') => void
	alsoLater: boolean
	onAlsoLater: (value: boolean) => void
	queued: number
	notice?: string
	disabled?: boolean
}) {
	const own = preview.files.filter((file) => file.turnId === preview.turnId)
	const later = preview.files.filter((file) => file.turnId !== preview.turnId)
	const queuedText = queuedWarning(queued)
	return (
		<div className="undo-body">
			{notice && <output className="undo-notice">{notice}</output>}
			{own.length > 0 && (
				<ul className="undo-rows" aria-label="Files in this reply">
					{own.map((file) => (
						<Row
							key={`${file.turnId}:${file.path}`}
							file={file}
							choice={choices[file.path] ?? 'skip'}
							onChoice={(choice) => onChoice(file.path, choice)}
							disabled={disabled}
						/>
					))}
				</ul>
			)}
			{preview.laterTurnsOnSameFiles.length > 0 && (
				<label className="undo-later">
					<input
						type="checkbox"
						checked={alsoLater}
						disabled={disabled}
						onChange={(event) => onAlsoLater(event.target.checked)}
					/>
					<span>
						Also undo later replies
						<span className="undo-later-hint">
							{preview.laterTurnsOnSameFiles.length === 1
								? ' (1 later reply changed the same files)'
								: ` (${preview.laterTurnsOnSameFiles.length} later replies changed the same files)`}
						</span>
					</span>
				</label>
			)}
			{later.length > 0 && (
				<>
					<h3 className="undo-heading">From later replies</h3>
					<ul className="undo-rows" aria-label="Files from later replies">
						{later.map((file) => (
							<Row
								key={`${file.turnId}:${file.path}`}
								file={file}
								choice={choices[file.path] ?? 'skip'}
								onChoice={(choice) => onChoice(file.path, choice)}
								disabled={disabled}
							/>
						))}
					</ul>
				</>
			)}
			{preview.skipped.length > 0 && (
				<>
					<h3 className="undo-heading">Not covered</h3>
					<ul className="undo-rows" aria-label="Files undo does not cover">
						{preview.skipped.map((item) => (
							<li key={item.path} className="undo-row" data-action="skipped">
								<span className="undo-row-path" title={item.path}>
									{item.path}
								</span>
								<span className="undo-row-reason">{skipText[item.reason]}</span>
							</li>
						))}
					</ul>
				</>
			)}
			{preview.uncoveredShell && (
				<p className="undo-warning" role="note">
					{SHELL_WARNING}
				</p>
			)}
			{queuedText && (
				<p className="undo-warning" role="note">
					{queuedText}
				</p>
			)}
			<p className="undo-fine">
				Undo covers files the edit and write tools changed. Edits made by sub-agents are not
				covered. Your own changes are never overwritten without keeping a copy.
			</p>
		</div>
	)
}

const resultText = {
	restored: 'Restored',
	removed: 'Deleted',
	skipped: 'Skipped',
	failed: 'Failed',
	noop: 'Already as before',
} as const

/** What an undo did, per file, so a partial result says exactly what was kept. */
export function UndoResultBody({
	result,
	names,
}: {
	result: DesktopUndoResult
	names: Record<string, string>
}) {
	const groups = [
		['this reply', result.files] as const,
		...Object.values(result.later ?? {}).map(
			(files, index) => [`later reply ${index + 1}`, files] as const,
		),
	]
	return (
		<div className="undo-body">
			<p className="undo-result-line" data-status={result.status}>
				{result.status === 'undone'
					? 'Undone.'
					: 'Partly undone. Run Undo again to finish the files that were kept.'}
			</p>
			{groups.map(([label, files], index) => (
				<ul key={label} className="undo-rows" aria-label={`Result for ${label}`} data-group={index}>
					{Object.entries(files).map(([path, outcome]) => (
						<li key={path} className="undo-row" data-outcome={outcome}>
							<span className="undo-row-action" data-kind={outcome}>
								{resultText[outcome]}
							</span>
							<span className="undo-row-path" title={path}>
								{names[path] ?? path}
							</span>
						</li>
					))}
				</ul>
			))}
			{result.copies && result.copies.length > 0 && (
				<>
					<h3 className="undo-heading">Copies kept</h3>
					<ul className="undo-rows" aria-label="Copies of your versions">
						{result.copies.map((copy) => (
							<li key={`${copy.path}:${copy.sha256}`} className="undo-row">
								<span className="undo-row-path" title={copy.path}>
									{names[copy.path] ?? copy.path}
								</span>
								<span className="undo-row-reason">
									Your version was saved before it was replaced
								</span>
							</li>
						))}
					</ul>
				</>
			)}
		</div>
	)
}

type Phase =
	| { kind: 'loading' }
	| { kind: 'error'; message: string }
	| { kind: 'plan'; preview: DesktopUndoPreview; notice?: string }
	| { kind: 'done'; result: DesktopUndoResult }

/**
 * Confirmation for one reply's undo. Nothing is written until the primary button; a plan that
 * moved since the preview is shown again in place and never applied silently.
 */
export function UndoDialog({
	loadPreview,
	apply,
	queued,
	onClose,
	returnFocus,
}: {
	loadPreview: (options: { alsoUndoLater: boolean }) => Promise<DesktopUndoPreview>
	apply: (planToken: string, options: DesktopUndoOptions) => Promise<DesktopUndoResult>
	queued: number
	onClose: () => void
	returnFocus: () => HTMLElement | null
}) {
	const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
	const [choices, setChoices] = useState<UndoChoices>({})
	const [alsoLater, setAlsoLater] = useState(false)
	const [applying, setApplying] = useState(false)
	// While a new plan loads over the old one, the old one must not be confirmable.
	const [refreshing, setRefreshing] = useState(false)
	const cancel = useRef<HTMLButtonElement>(null)
	const names = useRef<Record<string, string>>({})
	const inFlight = useRef(false)
	const mounted = useRef(true)
	// The parent builds a new loader every render; the plan must not reload because of that.
	const loader = useRef(loadPreview)
	loader.current = loadPreview
	// A slower earlier preview must not replace the plan the person is looking at.
	const generation = useRef(0)
	useEffect(() => {
		mounted.current = true
		return () => {
			mounted.current = false
		}
	}, [])
	const load = useCallback(async (later: boolean, notice?: string) => {
		const mine = ++generation.current
		setPhase((current) => (current.kind === 'plan' ? current : { kind: 'loading' }))
		setRefreshing(true)
		try {
			const preview = await loader.current({ alsoUndoLater: later })
			if (!mounted.current || generation.current !== mine) return
			for (const file of preview.files) names.current[file.path] = file.rel
			setChoices((current) => normalizeChoices(preview, current))
			setPhase({ kind: 'plan', preview, ...(notice ? { notice } : {}) })
			setRefreshing(false)
		} catch (failure) {
			if (mounted.current && generation.current === mine) {
				setRefreshing(false)
				setPhase({
					kind: 'error',
					message: failure instanceof Error ? failure.message : String(failure),
				})
			}
		}
	}, [])
	useEffect(() => {
		void load(false)
	}, [load])
	const preview = phase.kind === 'plan' ? phase.preview : undefined
	const summary = preview ? summarize(preview, choices) : undefined
	const confirm = async () => {
		if (!preview || refreshing || inFlight.current || !summary || summary.changing === 0) return
		inFlight.current = true
		setApplying(true)
		try {
			const result = await apply(preview.planToken, {
				...(Object.keys(resolutionsFor(preview, choices)).length
					? { resolutions: resolutionsFor(preview, choices) }
					: {}),
				...(alsoLater ? { alsoUndoLater: true } : {}),
			})
			if (!mounted.current) return
			if (result.status === 'plan-changed' && result.replan) {
				const replan = result.replan
				for (const file of replan.files) names.current[file.path] = file.rel
				setChoices((current) => normalizeChoices(replan, current))
				setPhase({
					kind: 'plan',
					preview: replan,
					notice: 'The files changed since this preview. Review the updated plan before undoing.',
				})
			} else setPhase({ kind: 'done', result })
		} catch (failure) {
			if (mounted.current)
				setPhase({
					kind: 'error',
					message: failure instanceof Error ? failure.message : String(failure),
				})
		} finally {
			inFlight.current = false
			if (mounted.current) setApplying(false)
		}
	}
	return (
		<Dialog.Root
			open
			onOpenChange={(open) => {
				if (!open && !inFlight.current) onClose()
			}}
		>
			<Dialog.Portal>
				<Dialog.Backdrop className="fixed inset-0 z-[160] bg-black/50" />
				<Dialog.Viewport className="fixed inset-0 z-[161] grid place-items-center overflow-y-auto p-4">
					<Dialog.Popup
						initialFocus={cancel}
						finalFocus={returnFocus}
						className="undo-dialog w-full max-w-xl rounded-2xl border border-border bg-background p-5 text-foreground shadow-xl outline-none"
					>
						<Dialog.Title className="text-lg font-semibold">
							{phase.kind === 'done' ? 'Undo finished' : 'Undo this reply’s file changes?'}
						</Dialog.Title>
						<Dialog.Description className="mt-1 text-sm text-muted-foreground">
							{phase.kind === 'done'
								? 'Here is what happened to each file.'
								: 'Files go back to how they were before this reply edited them. Nothing changes until you confirm.'}
						</Dialog.Description>
						{phase.kind === 'loading' && (
							<output className="undo-status">Checking the files…</output>
						)}
						{phase.kind === 'error' && (
							<p role="alert" className="undo-status undo-error">
								{phase.message}
							</p>
						)}
						{phase.kind === 'plan' && (
							<UndoPlanBody
								preview={phase.preview}
								choices={choices}
								onChoice={(path, choice) =>
									setChoices((current) => ({ ...current, [path]: choice }))
								}
								alsoLater={alsoLater}
								onAlsoLater={(value) => {
									setAlsoLater(value)
									void load(value)
								}}
								queued={queued}
								notice={phase.notice}
								disabled={applying || refreshing}
							/>
						)}
						{phase.kind === 'done' && (
							<UndoResultBody result={phase.result} names={names.current} />
						)}
						<div className="mt-5 flex justify-end gap-2">
							<Button
								ref={cancel}
								type="button"
								variant="outline"
								disabled={applying}
								onClick={onClose}
							>
								{phase.kind === 'done' ? 'Close' : 'Cancel'}
							</Button>
							{phase.kind !== 'done' && (
								<Button
									type="button"
									disabled={applying || refreshing || !summary || summary.changing === 0}
									onClick={() => void confirm()}
								>
									{applying ? 'Undoing…' : primaryLabel(summary?.changing ?? 0)}
								</Button>
							)}
						</div>
					</Dialog.Popup>
				</Dialog.Viewport>
			</Dialog.Portal>
		</Dialog.Root>
	)
}
