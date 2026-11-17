import type { ReactNode } from 'react'

/** A menu row's label with its hint at the end; the hint lives inside the label so the check stays last. */
export function MenuLabel({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
	return (
		<span className="changes-menu-label">
			<span className="changes-menu-text">{children}</span>
			{hint ? <span className="changes-menu-hint">{hint}</span> : null}
		</span>
	)
}
