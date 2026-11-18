import { useEffect, useId, useRef, useState } from 'react'
import { type ComputerFrameView, appLabel } from '../shared/computer-protocol.js'
import './computer-frame-thumb.css'

/** The picture as an address the page can draw; the host's bytes are already checked to be base64 PNG. */
function source(frame: ComputerFrameView): string {
	return `data:${frame.mimeType};base64,${frame.data}`
}

/** What a screen reader hears for the picture. */
export function frameDescription(frame: ComputerFrameView): string {
	const where = frame.app ? ` in ${appLabel(frame.app)}` : ''
	const click = frame.point ? ' The click point is marked.' : ''
	return `What the model saw after: ${frame.action}${where}.${click}`
}

function Marker({ frame }: { frame: ComputerFrameView }) {
	if (!frame.point) return null
	return (
		<span
			className="computer-frame-point"
			data-testid="computer-frame-point"
			style={{ left: `${frame.point.x * 100}%`, top: `${frame.point.y * 100}%` }}
			aria-hidden="true"
		/>
	)
}

/**
 * A small picture of what the model received after a computer action, with the click point marked
 * when the action was a click. A click opens it large; Escape or another click closes it.
 */
export function ComputerFrameThumb({ frame }: { frame: ComputerFrameView }) {
	const [open, setOpen] = useState(false)
	const titleId = useId()
	const closeButton = useRef<HTMLButtonElement>(null)
	const opener = useRef<HTMLButtonElement>(null)
	useEffect(() => {
		if (!open) return
		closeButton.current?.focus()
		const onKey = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				event.stopPropagation()
				setOpen(false)
				opener.current?.focus()
			}
		}
		window.addEventListener('keydown', onKey, true)
		return () => window.removeEventListener('keydown', onKey, true)
	}, [open])
	return (
		<>
			<button
				ref={opener}
				type="button"
				className="computer-frame-thumb"
				data-testid="computer-frame-thumb"
				aria-label={`${frameDescription(frame)} Open larger.`}
				onClick={() => setOpen(true)}
			>
				<span className="computer-frame-box">
					<img src={source(frame)} alt="" width={frame.width} height={frame.height} />
					<Marker frame={frame} />
				</span>
			</button>
			{open && (
				<div className="computer-frame-backdrop" data-testid="computer-frame-large">
					<button
						type="button"
						className="computer-frame-scrim"
						aria-label="Close the picture"
						tabIndex={-1}
						onClick={() => setOpen(false)}
					/>
					<dialog
						open
						className="computer-frame-dialog"
						aria-modal="true"
						aria-labelledby={titleId}
					>
						<p id={titleId} className="computer-frame-caption">
							{frame.app ? `${appLabel(frame.app)}: ` : ''}
							{frame.action}
						</p>
						<span className="computer-frame-box computer-frame-large-box">
							<img src={source(frame)} alt={frameDescription(frame)} />
							<Marker frame={frame} />
						</span>
						<button
							ref={closeButton}
							type="button"
							className="computer-frame-close"
							onClick={() => setOpen(false)}
						>
							Close
						</button>
					</dialog>
				</div>
			)}
		</>
	)
}
