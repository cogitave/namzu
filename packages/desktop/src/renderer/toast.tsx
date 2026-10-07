import { Toast } from '@base-ui/react/toast'
import { X } from 'lucide-react'
import { type ReactNode, type RefObject, useEffect, useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { createPaneToastManager, toastHub } from './notify.js'
import './toast.css'

function ToastList() {
	const { toasts } = Toast.useToastManager()
	return toasts.map((toast) => (
		<Toast.Root key={toast.id} toast={toast} className="toast-root" swipeDirection="down">
			<Toast.Content className="toast-content">
				<Toast.Title className="toast-title" />
				<Toast.Action className="toast-action" />
				<Toast.Close className="toast-close" aria-label="Dismiss notification">
					<X aria-hidden="true" />
				</Toast.Close>
			</Toast.Content>
		</Toast.Root>
	))
}

/**
 * The viewport sits in the conversation lane, which carries --composer-height, so it rides
 * above the composer and stays clear of the side panel. A page without a lane uses the pane.
 */
function PaneViewport({ pane }: { pane: RefObject<HTMLElement | null> }) {
	const [host, setHost] = useState<Element | null>(null)
	// The lane comes and goes with the page, so look again after every render.
	useLayoutEffect(() => {
		const next = pane.current?.querySelector('.conversation-lane') ?? pane.current ?? null
		setHost((current) => (current === next ? current : next))
	})
	if (!host) return null
	return createPortal(
		<Toast.Viewport className="toast-viewport">
			<ToastList />
		</Toast.Viewport>,
		host,
	)
}

/** One toast provider per pane; `notify` from ./notify.js reaches the pane focused last. */
export function PaneToasts({
	focused,
	pane,
	children,
}: {
	focused: boolean
	pane: RefObject<HTMLElement | null>
	children: ReactNode
}) {
	const [manager] = useState(createPaneToastManager)
	const [seat, setSeat] = useState<ReturnType<typeof toastHub.register>>()
	useEffect(() => {
		const joined = toastHub.register(manager)
		setSeat(joined)
		return joined.dispose
	}, [manager])
	useEffect(() => {
		if (focused) seat?.focus()
	}, [focused, seat])
	return (
		<Toast.Provider toastManager={manager} limit={3}>
			{children}
			<PaneViewport pane={pane} />
		</Toast.Provider>
	)
}
