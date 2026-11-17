import { type ReactNode, createContext, useContext } from 'react'

/**
 * The pane's own menu rows (move, close the others). A pane that draws its own "..." menu, as
 * Changes does, reads them here and adds them to the end of that menu, so a header never carries
 * two "..." buttons.
 */
export const PaneMenuItemsContext = createContext<ReactNode>(null)

export function usePaneMenuItems(): ReactNode {
	return useContext(PaneMenuItemsContext)
}
