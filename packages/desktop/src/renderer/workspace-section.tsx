import { ChevronDown, ChevronRight } from 'lucide-react'
/* Adapted UI component. License and provenance: packages/desktop/THIRD-PARTY-NOTICES.txt. */
import type { ReactNode } from 'react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible.js'

export function WorkspaceSection({
	title,
	open,
	onOpenChange,
	action,
	children,
}: {
	title: string
	open: boolean
	onOpenChange: (open: boolean) => void
	action?: ReactNode
	children: ReactNode
}) {
	return (
		<section className="group/purpose-section relative" aria-label={title}>
			<Collapsible open={open} onOpenChange={onOpenChange}>
				<div className="flex h-7 min-w-0 items-center">
					<CollapsibleTrigger className="flex h-7 min-w-0 flex-1 items-center gap-1 px-2.5 text-left text-ui-caption font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30">
						<span className="min-w-0 truncate">{title}</span>
						{open ? (
							<ChevronDown
								aria-hidden="true"
								className="size-3.5 shrink-0 opacity-0 transition-opacity group-hover/purpose-section:opacity-100 group-focus-within/purpose-section:opacity-100"
							/>
						) : (
							<ChevronRight aria-hidden="true" className="size-3.5 shrink-0" />
						)}
					</CollapsibleTrigger>
					<div className="flex shrink-0 items-center pr-1.5">{action}</div>
				</div>
				<CollapsibleContent>{children}</CollapsibleContent>
			</Collapsible>
		</section>
	)
}
