import { Menu } from '@base-ui/react/menu'
import { useEffect, useState } from 'react'
import type { DesktopApi } from '../shared/protocol.js'
import './keep-awake.css'

/**
 * "Keep computer awake" in the conversation's menu: a switch that holds the computer awake while
 * this conversation lives. The host holds it (and lets go when the conversation or the window
 * goes), so what shows here is what the host says, read when the menu is made.
 */
export function KeepAwakeItem({
	api,
	sessionId,
}: {
	api: Pick<DesktopApi, 'keepAwake'>
	sessionId: string
}) {
	const ask = api.keepAwake
	const [on, setOn] = useState(false)
	useEffect(() => {
		let current = true
		setOn(false)
		void ask?.(sessionId)
			.then((held) => current && setOn(held))
			.catch(() => undefined)
		return () => {
			current = false
		}
	}, [ask, sessionId])
	if (!ask) return null
	return (
		<Menu.CheckboxItem
			className="conversation-actions-item keep-awake-item"
			checked={on}
			closeOnClick={false}
			onCheckedChange={(next) => {
				setOn(next)
				void ask(sessionId, next)
					.then(setOn)
					.catch(() => setOn(!next))
			}}
		>
			<span className="keep-awake-text">
				<span className="conversation-actions-label">Keep computer awake</span>
				<small>Only for this session</small>
			</span>
			<i className="keep-awake-switch" data-on={on || undefined} />
		</Menu.CheckboxItem>
	)
}
