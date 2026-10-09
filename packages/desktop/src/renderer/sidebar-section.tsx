import { type ReactNode, useCallback, useEffect, useId, useState } from 'react'
import type { DesktopApi } from '../shared/protocol.js'
import { type SidebarSectionId, collapsedSectionsFrom } from '../shared/sidebar-sections.js'
import { ChevronDownIcon } from './icons.js'
import './sidebar-section.css'

/**
 * One foldable group in the sidebar. The heading is a button (label and chevron) that opens and
 * closes the body; `actions` sit beside it and never fold the section. While folded, `attention`
 * puts a small dot on the heading so something that needs the person is not missed. The body is
 * hidden, not unmounted, so folding never closes a tab or changes the open conversation.
 */
export function SidebarSection({
	label,
	collapsed,
	onCollapsedChange,
	attention,
	actions,
	className,
	headingClassName,
	titleClassName = 'sidebar-section-title',
	ariaLabel,
	children,
}: {
	label: string
	/** Absent: the section keeps its own state and is not remembered. */
	collapsed?: boolean
	onCollapsedChange?: (collapsed: boolean) => void
	attention?: string
	actions?: ReactNode
	className?: string
	headingClassName?: string
	titleClassName?: string
	ariaLabel?: string
	children: ReactNode
}) {
	const [local, setLocal] = useState(false)
	const folded = collapsed ?? local
	const bodyId = useId()
	const toggle = () => {
		if (onCollapsedChange) onCollapsedChange(!folded)
		else setLocal(!folded)
	}
	return (
		<section className={className} aria-label={ariaLabel ?? label} data-sidebar-section={label}>
			<div className={`sidebar-section-head ${headingClassName ?? ''}`.trim()}>
				<h2 className={titleClassName}>
					<button
						type="button"
						className="sidebar-section-toggle"
						aria-expanded={!folded}
						aria-controls={bodyId}
						onClick={toggle}
					>
						<span>{label}</span>
						<ChevronDownIcon className="sidebar-section-chevron" aria-hidden="true" />
						{folded && attention && (
							<i className="sidebar-section-attention" title={attention} data-attention>
								<span className="sr-only">{attention}</span>
							</i>
						)}
					</button>
				</h2>
				{actions}
			</div>
			<div id={bodyId} className="sidebar-section-body" hidden={folded}>
				{children}
			</div>
		</section>
	)
}

/**
 * Which sidebar sections are folded. Main keeps the answer, so a restart brings it back; a
 * failed read leaves every section open, and a failed save keeps the choice for this window.
 */
export function useSidebarSections(
	api: Pick<DesktopApi, 'sidebarCollapsed' | 'setSidebarSectionCollapsed'>,
) {
	const [collapsed, setCollapsed] = useState<ReadonlySet<SidebarSectionId>>(() => new Set())
	useEffect(() => {
		if (!api.sidebarCollapsed) return
		let current = true
		void api
			.sidebarCollapsed()
			.then((ids) => {
				if (current) setCollapsed(new Set(collapsedSectionsFrom(ids)))
			})
			.catch(() => {})
		return () => {
			current = false
		}
	}, [api])
	const setSectionCollapsed = useCallback(
		(id: SidebarSectionId, next: boolean) => {
			setCollapsed((previous) => {
				const copy = new Set(previous)
				if (next) copy.add(id)
				else copy.delete(id)
				return copy
			})
			void api.setSidebarSectionCollapsed?.(id, next).catch(() => {})
		},
		[api],
	)
	return { collapsed, setSectionCollapsed }
}
