import { Check, Copy, LoaderCircle, TriangleAlert } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { copyTextPayload } from '../shared/clipboard-text.js'
import { cn } from './lib/utils.js'
import { Button } from './ui/button.js'
import { Tooltip, TooltipPopup, TooltipTrigger } from './ui/tooltip.js'

export type CopyState = 'idle' | 'pending' | 'copied' | 'error'

/** Only an explicit clicked write is exposed; never inspect the user's clipboard. */
export async function copyPlainText(text: string): Promise<void> {
	const payload = copyTextPayload(text)
	if (typeof window === 'undefined' || !window.namzu?.copyText)
		throw new Error('Copy is unavailable in this version of Namzu.')
	await window.namzu.copyText(payload)
}

/** A deferred result cannot update another message or a retired component. */
export class CopyAction {
	private generation = 0
	private active = false
	private pending: number | undefined
	constructor(
		private readonly write: (text: string) => Promise<void>,
		private readonly changed: (state: CopyState) => void,
	) {}
	activate(): void {
		this.generation++
		this.active = true
		this.pending = undefined
		this.changed('idle')
	}
	reset(): void {
		this.generation++
		if (this.active) this.changed(this.pending === undefined ? 'idle' : 'pending')
	}
	dispose(): void {
		this.generation++
		this.active = false
	}
	async copy(text: string): Promise<void> {
		if (!this.active || this.pending !== undefined) return
		const admitted = ++this.generation
		this.pending = admitted
		this.changed('pending')
		try {
			await this.write(text)
			if (this.active && this.generation === admitted) this.changed('copied')
		} catch {
			if (this.active && this.generation === admitted) this.changed('error')
		} finally {
			if (this.pending === admitted) {
				this.pending = undefined
				if (this.active && this.generation !== admitted) this.changed('idle')
			}
		}
	}
}

export function CopyButton({
	text,
	label = 'Copy reply',
	className,
	writeText = copyPlainText,
}: {
	text: string
	label?: string
	className?: string
	/** An explicit writer seam for isolated rendering; native uses its owned bridge. */
	writeText?: (text: string) => Promise<void>
}) {
	const [state, setState] = useState<CopyState>('idle')
	const writer = useRef(writeText)
	const previousText = useRef(text)
	writer.current = writeText
	const action = useMemo(() => new CopyAction((value) => writer.current(value), setState), [])
	useEffect(() => {
		action.activate()
		return () => action.dispose()
	}, [action])
	useEffect(() => {
		if (previousText.current !== text) {
			previousText.current = text
			action.reset()
		}
	}, [action, text])
	useEffect(() => {
		if (state !== 'copied') return
		const timer = setTimeout(() => action.reset(), 2000)
		return () => clearTimeout(timer)
	}, [action, state])
	const feedback =
		state === 'copied'
			? 'Copied to clipboard.'
			: state === 'error'
				? 'Could not copy. Try again.'
				: ''
	const tooltip = state === 'pending' ? 'Copying…' : feedback || label
	return (
		<span className={cn('message-copy-action relative inline-flex size-6 shrink-0', className)}>
			<Tooltip>
				<TooltipTrigger
					render={
						<Button
							size="icon-xs"
							variant="ghost-muted"
							className="message-copy-button size-6"
							aria-label={label}
							aria-busy={state === 'pending'}
							data-copy-state={state}
							disabled={state === 'pending' || text.length === 0}
							onClick={() => {
								void action.copy(text)
							}}
						/>
					}
				>
					{state === 'pending' ? (
						<LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
					) : state === 'copied' ? (
						<Check aria-hidden="true" />
					) : state === 'error' ? (
						<TriangleAlert aria-hidden="true" />
					) : (
						<Copy aria-hidden="true" />
					)}
				</TooltipTrigger>
				<TooltipPopup>{tooltip}</TooltipPopup>
			</Tooltip>
			<output className="sr-only" aria-live="polite" aria-atomic="true">
				{feedback}
			</output>
		</span>
	)
}
