import { useId, useState } from 'react'
import type { RecordingReviewView } from '../shared/recording-protocol.js'
import { MonitorIcon, XIcon } from './icons.js'
import {
	NOTE_PLACEHOLDER,
	REVIEW_HINT,
	hasVoiceText,
	limitNotes,
	picturesLine,
} from './record-review-model.js'
import './composer-approval.css'
import './record-review.css'

export type ReviewEdit =
	| { kind: 'step'; id: number }
	| { kind: 'picture'; index: number }
	| { kind: 'pictures' }
	| { kind: 'voice' }

/**
 * A finished screen recording, waiting above the message box. It says what was recorded, lets the
 * person read every step and picture and remove any of them, and sends nothing until Send: Send puts
 * the recording into the message as an attachment, with the person's own note; Discard drops it.
 */
export function RecordingReview({
	view,
	onEdit,
	onSend,
	onDiscard,
	disabled = false,
}: {
	view: RecordingReviewView
	onEdit: (edit: ReviewEdit) => unknown
	onSend: (note: string) => Promise<unknown>
	onDiscard: () => unknown
	disabled?: boolean
}) {
	const [open, setOpen] = useState(false)
	const [note, setNote] = useState('')
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string>()
	const bodyId = useId()
	const send = () => {
		if (busy || disabled) return
		setBusy(true)
		setError(undefined)
		onSend(note)
			.catch((failure: unknown) =>
				setError(failure instanceof Error ? failure.message : 'The recording could not be added.'),
			)
			.finally(() => setBusy(false))
	}
	return (
		<section
			className="approval-surface recording-review"
			aria-label="Screen recording"
			data-testid="recording-review"
		>
			<div className="approval-card" data-kind="recording">
				<header className="approval-head">
					<MonitorIcon aria-hidden="true" className="approval-head-icon" />
					<h3 className="approval-title" title={view.summary}>
						{view.summary}
					</h3>
				</header>
				<p className="recording-review-hint">{REVIEW_HINT}</p>
				{limitNotes(view).map((line) => (
					<p key={line} className="recording-review-hint" data-testid="recording-review-limit">
						{line}
					</p>
				))}
				<input
					className="approval-note-field recording-review-note"
					type="text"
					value={note}
					maxLength={500}
					placeholder={NOTE_PLACEHOLDER}
					aria-label="Your note for this recording"
					onChange={(event) => setNote(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
							event.preventDefault()
							send()
						}
					}}
				/>
				{open && (
					<div className="recording-review-body" id={bodyId}>
						<div className="recording-review-block">
							<div className="recording-review-line">
								<span>{picturesLine(view)}</span>
								<span className="recording-review-buttons">
									{view.pictureCount > 0 && (
										<button
											type="button"
											className="recording-review-link"
											onClick={() => onEdit({ kind: 'pictures' })}
										>
											Remove pictures
										</button>
									)}
									{hasVoiceText(view) && (
										<button
											type="button"
											className="recording-review-link"
											onClick={() => onEdit({ kind: 'voice' })}
										>
											Remove voice text
										</button>
									)}
								</span>
							</div>
							{view.pictures.length > 0 && (
								<ul className="recording-review-strip" aria-label="Pictures">
									{view.pictures.map((picture) => (
										<li key={picture.index} className="recording-review-picture">
											{picture.thumb ? (
												<img src={picture.thumb} alt="" />
											) : (
												<span aria-hidden="true" />
											)}
											<span className="recording-review-time">{picture.time}</span>
											<button
												type="button"
												className="recording-review-x"
												aria-label={`Remove the picture at ${picture.time}`}
												onClick={() => onEdit({ kind: 'picture', index: picture.index })}
											>
												<XIcon aria-hidden="true" />
											</button>
										</li>
									))}
								</ul>
							)}
						</div>
						<ol className="recording-review-steps" aria-label="Steps">
							{view.steps.length === 0 && (
								<li className="recording-review-empty">No steps were recorded.</li>
							)}
							{view.steps.map((step) => (
								<li key={step.id} className="recording-review-step">
									<span className="recording-review-time">{step.time}</span>
									<span className="recording-review-label">{step.label}</span>
									<button
										type="button"
										className="recording-review-x"
										aria-label={`Remove the step: ${step.label}`}
										onClick={() => onEdit({ kind: 'step', id: step.id })}
									>
										<XIcon aria-hidden="true" />
									</button>
								</li>
							))}
						</ol>
						{view.cutLines.length > 0 && (
							<div className="recording-review-block">
								<p className="recording-review-heading">What was cut or removed</p>
								<ul className="recording-review-cut">
									{view.cutLines.map((line) => (
										<li key={line}>{line}</li>
									))}
								</ul>
							</div>
						)}
					</div>
				)}
				{error && (
					<p role="alert" className="recording-review-error">
						{error}
					</p>
				)}
				<footer className="approval-footer">
					<button
						type="button"
						className="recording-review-link recording-review-toggle"
						aria-expanded={open}
						aria-controls={open ? bodyId : undefined}
						onClick={() => setOpen((value) => !value)}
					>
						{open ? 'Hide' : 'View'}
					</button>
					<div className="approval-actions">
						<button
							type="button"
							className="approval-button"
							data-action="discard"
							disabled={busy}
							onClick={() => onDiscard()}
						>
							Discard
						</button>
						<button
							type="button"
							className="approval-button"
							data-action="send"
							data-tone="accept"
							disabled={disabled || busy}
							onClick={send}
						>
							Send
						</button>
					</div>
				</footer>
			</div>
		</section>
	)
}
