'use client'

import { PreviewCard as PreviewCardPrimitive } from '@base-ui/react/preview-card'

import { cn } from '../lib/utils.js'

const PreviewCardCreateHandle = PreviewCardPrimitive.createHandle

const PreviewCard = PreviewCardPrimitive.Root

function PreviewCardTrigger<Payload>({
	className,
	children,
	...props
}: PreviewCardPrimitive.Trigger.Props<Payload>) {
	return (
		<PreviewCardPrimitive.Trigger className={className} data-slot="preview-card-trigger" {...props}>
			{children}
		</PreviewCardPrimitive.Trigger>
	)
}

function PreviewCardPopup({
	children,
	className,
	positionerClassName,
	side = 'bottom',
	align = 'start',
	sideOffset = 6,
	...props
}: PreviewCardPrimitive.Popup.Props & {
	positionerClassName?: string
	side?: PreviewCardPrimitive.Positioner.Props['side']
	align?: PreviewCardPrimitive.Positioner.Props['align']
	sideOffset?: PreviewCardPrimitive.Positioner.Props['sideOffset']
}) {
	return (
		<PreviewCardPrimitive.Portal>
			<PreviewCardPrimitive.Positioner
				align={align}
				className={cn('z-[130] max-w-(--available-width)', positionerClassName)}
				data-slot="preview-card-positioner"
				side={side}
				sideOffset={sideOffset}
			>
				<PreviewCardPrimitive.Popup
					className={cn(
						'dropdown-glass relative origin-(--transform-origin) rounded-lg text-popover-foreground outline-none transition-[opacity,transform] duration-150 ease-(--motion-ease) before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] data-starting-style:translate-y-0.5 data-starting-style:scale-[0.98] data-starting-style:opacity-0 data-ending-style:translate-y-0.5 data-ending-style:scale-[0.98] data-ending-style:opacity-0 motion-reduce:data-starting-style:translate-y-0 motion-reduce:data-starting-style:scale-100 motion-reduce:data-ending-style:translate-y-0 motion-reduce:data-ending-style:scale-100 shadow-[0_16px_40px_-18px_rgb(0_0_0/55%)] dark:shadow-[0_18px_44px_-18px_rgb(0_0_0/80%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)]',
						className,
					)}
					data-slot="preview-card-popup"
					{...props}
				>
					{children}
				</PreviewCardPrimitive.Popup>
			</PreviewCardPrimitive.Positioner>
		</PreviewCardPrimitive.Portal>
	)
}

export { PreviewCardCreateHandle, PreviewCard, PreviewCardTrigger, PreviewCardPopup }
