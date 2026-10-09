import { useEffect, useRef, useState } from 'react'
import { afterQuietPeriod } from './project-stage.js'
import { Button } from './ui/button.js'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from './ui/empty.js'
import './project-views.css'

let retryHadFocus = false

function useAfterQuietPeriod(): boolean {
	const [elapsed, setElapsed] = useState(false)
	useEffect(() => afterQuietPeriod(() => setElapsed(true)), [])
	return elapsed
}

export function ProjectConnecting({ name }: { name: string }) {
	const visible = useAfterQuietPeriod()
	const stage = useRef<HTMLDivElement>(null)
	useEffect(() => {
		// Try again unmounts the button that had focus; keep focus in the stage instead of losing it.
		if (retryHadFocus) stage.current?.focus()
		retryHadFocus = false
	}, [])
	return (
		<Empty
			ref={stage}
			tabIndex={-1}
			className="welcome project-connecting"
			aria-busy="true"
			data-visible={visible}
		>
			{/* Mounted from the start so the text, added later, is announced once and politely. */}
			<output className="project-connecting-note" data-visible={visible}>
				{visible && (
					<>
						<span className="project-connecting-spinner" aria-hidden="true" />
						Opening {name}…
					</>
				)}
			</output>
		</Empty>
	)
}

export function ProjectOpenError({
	message,
	onRetry,
}: {
	message: string
	onRetry: () => void
}) {
	return (
		<Empty className="welcome project-open-error">
			<EmptyHeader className="max-w-lg px-8">
				<EmptyTitle>
					<h1>Couldn’t open this folder</h1>
				</EmptyTitle>
				<EmptyDescription>{message}</EmptyDescription>
			</EmptyHeader>
			<Button
				type="button"
				className="primary"
				size="default"
				onClick={() => {
					retryHadFocus = true
					onRetry()
				}}
			>
				Try again
			</Button>
		</Empty>
	)
}

/** The folder was moved or deleted. Not a trust problem, so no trust words: find it, or let it go. */
export function ProjectMissing({
	name,
	path,
	onLocate,
	onRemove,
	removeDisabled,
}: {
	name: string
	path: string
	onLocate: () => void
	onRemove?: (trigger: HTMLElement | null) => void
	removeDisabled?: boolean
}) {
	return (
		<Empty className="welcome project-open-error project-missing">
			<EmptyHeader className="max-w-lg px-8">
				<EmptyTitle>
					<h1>{name} can’t be found</h1>
				</EmptyTitle>
				<EmptyDescription>
					This folder no longer exists. It may have been moved, renamed or deleted.
				</EmptyDescription>
				<EmptyDescription className="project-path">{path}</EmptyDescription>
			</EmptyHeader>
			<div className="project-missing-actions">
				<Button type="button" className="primary" size="default" onClick={onLocate}>
					Locate folder…
				</Button>
				{onRemove && (
					<Button
						type="button"
						variant="outline"
						size="default"
						disabled={removeDisabled}
						onClick={(event) => onRemove(event.currentTarget)}
					>
						Remove project…
					</Button>
				)}
			</div>
		</Empty>
	)
}
