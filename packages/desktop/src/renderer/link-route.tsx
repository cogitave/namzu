import { type ReactNode, type RefObject, createContext } from 'react'
import { PaneToasts } from './toast.js'

/**
 * Where a link in a reply goes. The window that shows the conversation provides a function that
 * takes a web address and answers whether it opened it in the built-in browser; a link that is
 * not taken there falls through to the system's browser. Without a provider every link is left to
 * the system, as before.
 */
export type LinkRoute = (url: string) => boolean

export const LinkRouteContext = createContext<LinkRoute | null>(null)

/** The pane's toasts, with the link route provided to everything inside. */
export function LinkRoutedToasts({
	route,
	focused,
	pane,
	children,
}: {
	route: LinkRoute
	focused: boolean
	pane: RefObject<HTMLElement | null>
	children?: ReactNode
}) {
	return (
		<LinkRouteContext.Provider value={route}>
			<PaneToasts focused={focused} pane={pane}>
				{children}
			</PaneToasts>
		</LinkRouteContext.Provider>
	)
}
