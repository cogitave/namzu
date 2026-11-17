import { Dialog } from '@base-ui/react/dialog'
import { useEffect, useRef, useState } from 'react'
import type {
	CommitOutcomeView,
	CommitPreviewView,
	CommitRequestView,
	CommitResultView,
} from '../shared/commit-protocol.js'
import { commitDialogModel } from './commit-model.js'
import { copyPlainText } from './copy-button.js'
import { plainErrorText } from './plain-error.js'
import { Button } from './ui/button.js'
import './commit-dialog.css'
import './dialog.css'

type Stage =
	| { name: 'loading' }
	| { name: 'ready'; preview: CommitPreviewView }
	| { name: 'failed'; error: string }
	| { name: 'done'; result: CommitResultView }

const STATE_WORD = { modified: 'Changed', added: 'New', deleted: 'Deleted', renamed: 'Renamed' }

/**
 * Commit what this conversation changed: the files, an editable message, and the branch. Nothing is
 * committed until the person presses Commit. The message may come from the small model, which sees
 * only these files' changes; the dialog says so. Namzu never pushes.
 */
export function CommitDialog({
	load,
	run,
	onClose,
	returnFocus,
}: {
	load: () => Promise<CommitPreviewView | null>
	run: (request: CommitRequestView) => Promise<CommitOutcomeView>
	onClose: () => void
	returnFocus: () => HTMLElement | null
}) {
	const [stage, setStage] = useState<Stage>({ name: 'loading' })
	const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set())
	const [message, setMessage] = useState('')
	const [pending, setPending] = useState(false)
	const [error, setError] = useState('')
	const [copied, setCopied] = useState(false)
	const mounted = useRef(true)
	const loadRef = useRef(load)
	loadRef.current = load
	const inFlight = useRef(false)
	useEffect(() => {
		mounted.current = true
		void loadRef.current().then(
			(preview) => {
				if (!mounted.current) return
				if (!preview) {
					setStage({ name: 'failed', error: 'This engine cannot commit from here.' })
					return
				}
				setTicked(new Set(preview.files.map((file) => file.path)))
				setMessage(preview.suggestedMessage)
				setStage({ name: 'ready', preview })
			},
			(failure) => {
				if (mounted.current)
					setStage({ name: 'failed', error: plainErrorText(failure, 'check the changes') })
			},
		)
		return () => {
			mounted.current = false
		}
	}, [])
	const preview = stage.name === 'ready' ? stage.preview : undefined
	const model = preview ? commitDialogModel(preview, ticked, message) : undefined
	const commit = async () => {
		if (!preview || !model?.canCommit || inFlight.current) return
		inFlight.current = true
		setPending(true)
		setError('')
		try {
			const result = await run({
				paths: model.paths,
				message,
				fingerprints: Object.fromEntries(
					preview.files.filter((f) => ticked.has(f.path)).map((f) => [f.path, f.fingerprint]),
				),
			})
			if (!mounted.current) return
			if (result.ok) setStage({ name: 'done', result })
			else setError(result.reason)
		} catch (failure) {
			if (mounted.current) setError(plainErrorText(failure, 'commit'))
		} finally {
			inFlight.current = false
			if (mounted.current) setPending(false)
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
				<Dialog.Backdrop className="dialog-scrim" />
				<Dialog.Viewport className="dialog-viewport">
					<Dialog.Popup
						className="dialog-popup commit-dialog"
						data-commit-dialog={stage.name}
						finalFocus={returnFocus}
					>
						<Dialog.Title className="dialog-title">
							{stage.name === 'done' ? 'Committed' : 'Commit changes'}
						</Dialog.Title>
						{stage.name === 'loading' && <p className="dialog-body">Checking what changed…</p>}
						{stage.name === 'failed' && (
							<p className="dialog-body" role="alert">
								{stage.error}
							</p>
						)}
						{stage.name === 'done' && (
							<div className="dialog-body">
								<p data-commit-result>
									<code>{stage.result.hash}</code> {stage.result.subject}
								</p>
								<p className="commit-note">
									The totals count this conversation’s edits, so they do not change.
								</p>
								<Button
									type="button"
									variant="ghost-muted"
									size="xs"
									onClick={() => {
										void copyPlainText(stage.result.hash).then(() => setCopied(true))
									}}
								>
									{copied ? 'Copied' : 'Copy the hash'}
								</Button>
							</div>
						)}
						{preview && model && (
							<>
								<p className="commit-branch" data-commit-branch>
									{preview.detached
										? 'Not on a branch'
										: `On ${preview.branch ?? 'the current branch'}`}
								</p>
								{preview.blocker && (
									<p className="commit-note" role="alert">
										{preview.blocker}
									</p>
								)}
								{preview.files.length > 0 && (
									<ul className="commit-files" aria-label="Files to commit">
										{preview.files.map((file) => (
											<li key={file.path}>
												<label>
													<input
														type="checkbox"
														checked={ticked.has(file.path)}
														disabled={pending}
														onChange={(event) =>
															setTicked((all) => {
																const next = new Set(all)
																if (event.target.checked) next.add(file.path)
																else next.delete(file.path)
																return next
															})
														}
													/>
													<span className="commit-file-name" title={file.path}>
														{file.path}
													</span>
													<span className="commit-file-state">{STATE_WORD[file.state]}</span>
												</label>
											</li>
										))}
									</ul>
								)}
								<label className="commit-message">
									<span>Message</span>
									<textarea
										aria-label="Commit message"
										value={message}
										rows={4}
										disabled={pending}
										onChange={(event) => setMessage(event.target.value)}
									/>
								</label>
								{preview.messageSource === 'model' && (
									<p className="commit-note">
										Suggested by the small model, which saw only these files’ changes.
									</p>
								)}
								<ul className="commit-lines">
									{model.lines.map((line) => (
										<li key={line}>{line}</li>
									))}
								</ul>
								{error && (
									<pre className="commit-error" role="alert">
										{error}
									</pre>
								)}
							</>
						)}
						<div className="dialog-actions">
							<Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
								{stage.name === 'done' ? 'Close' : 'Cancel'}
							</Button>
							{preview && model && (
								<Button
									type="button"
									disabled={!model.canCommit || pending}
									title={model.reason}
									onClick={() => void commit()}
								>
									{pending ? 'Committing…' : 'Commit'}
								</Button>
							)}
						</div>
					</Dialog.Popup>
				</Dialog.Viewport>
			</Dialog.Portal>
		</Dialog.Root>
	)
}
