import type { ReactNode } from 'react'
import { CopyButton } from './copy-button.js'
import './message-actions.css'

/** Settled answer actions share one quiet, stable row. */
export function MessageActions({ text, children }: { text: string; children?: ReactNode }) {
	return (
		<div className="message-actions">
			{children}
			<CopyButton text={text} />
		</div>
	)
}
