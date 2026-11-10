'use client'

import { Collapsible as CollapsiblePrimitive } from '@base-ui/react/collapsible'

import { cn } from '../lib/utils.js'

function Collapsible({ ...props }: CollapsiblePrimitive.Root.Props) {
	return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />
}

function CollapsibleTrigger({ className, ...props }: CollapsiblePrimitive.Trigger.Props) {
	return (
		<CollapsiblePrimitive.Trigger
			className={cn('cursor-pointer', className)}
			data-slot="collapsible-trigger"
			{...props}
		/>
	)
}

function CollapsiblePanel({
	className,
	instant,
	rows,
	children,
	...props
}: CollapsiblePrimitive.Panel.Props & {
	/** Opens and closes without travel: for a panel that is already open when it first appears. */
	instant?: boolean
	/**
	 * Travel by grid rows (0fr to 1fr) with a fade, so the panel needs no measured height and the
	 * content can change size while it moves. The children are wrapped in one box that clips only while the panel travels.
	 */
	rows?: boolean
}) {
	if (rows) {
		return (
			<CollapsiblePrimitive.Panel
				className={cn(
					// A closed panel is [hidden]: the grid display must not override that, or its content stays reachable.
					'grid grid-rows-[1fr] opacity-100 transition-[grid-template-rows,opacity] duration-(--dur-base) ease-(--ease-settle) motion-reduce:transition-none [&[hidden]]:hidden data-ending-style:grid-rows-[0fr] data-ending-style:opacity-0 data-starting-style:grid-rows-[0fr] data-starting-style:opacity-0',
					instant && 'transition-none',
					className,
				)}
				data-slot="collapsible-panel"
				{...props}
			>
				{/* Clip only while the panel travels; when open, a focus ring or popover at the edge stays visible. */}
				<div className="min-h-0 in-data-ending-style:overflow-hidden in-data-starting-style:overflow-hidden">
					{children}
				</div>
			</CollapsiblePrimitive.Panel>
		)
	}
	// Skip height travel when the operator requests reduced motion.
	return (
		<CollapsiblePrimitive.Panel
			className={cn(
				'h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-200 motion-reduce:transition-none data-ending-style:h-0 data-starting-style:h-0 data-open:data-ending-style:[height:var(--collapsible-panel-height)]',
				instant && 'transition-none data-starting-style:h-auto',
				className,
			)}
			data-slot="collapsible-panel"
			{...props}
		>
			{children}
		</CollapsiblePrimitive.Panel>
	)
}

export { Collapsible, CollapsibleTrigger, CollapsiblePanel, CollapsiblePanel as CollapsibleContent }
