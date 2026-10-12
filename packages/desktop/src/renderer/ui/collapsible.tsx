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
	...props
}: CollapsiblePrimitive.Panel.Props & {
	/** Opens and closes without travel: for a panel that is already open when it first appears. */
	instant?: boolean
}) {
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
		/>
	)
}

export { Collapsible, CollapsibleTrigger, CollapsiblePanel, CollapsiblePanel as CollapsibleContent }
