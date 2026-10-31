import { ATTR_BOLD, ATTR_DIM, ATTR_INVERSE } from '../terminal/host/cell.js'
import type { CellStyle, Frame, Rect } from '../terminal/host/frame.js'
import type { ChildSession } from './session.js'

const GREY = 8
const GREEN = 2
const CYAN = 6

export interface SidebarModel {
	readonly sessions: readonly ChildSession[]
	readonly selected: number
	readonly mode: 'terminal' | 'navigate'
	readonly prefixName: string
	/** Set while "quit" is waiting for a yes. */
	readonly confirmingQuit: boolean
}

/** The plain words under a row for a session that is not simply running. */
export function sessionNote(session: ChildSession): string | undefined {
	if (session.status === 'starting') return 'starting'
	if (session.status !== 'exited') return undefined
	if (session.ending === 'could-not-start') return 'could not start'
	return session.ending === 'finished' ? 'ended' : 'stopped'
}

/** What the session area says over a session that is gone. */
export function endedMessage(session: ChildSession, prefixName: string): string {
	const leave = `Leave with ${prefixName} q`
	if (session.ending === 'could-not-start') return `This session could not start. ${leave}.`
	if (session.ending === 'finished') return `This session has ended. ${leave}.`
	return `This session stopped. Its conversation is saved. ${leave}.`
}

export function drawSidebar(frame: Frame, rect: Rect, model: SidebarModel): void {
	frame.fillRect(rect)
	frame.writeText(rect, 0, ' spaces', { attrs: ATTR_BOLD })
	let row = 2
	model.sessions.forEach((session, index) => {
		if (row >= rect.height - 4) return
		const focused = index === model.selected
		const gone = session.status === 'exited'
		const style: CellStyle = gone
			? { fg: GREY, attrs: ATTR_DIM }
			: model.mode === 'navigate' && focused
				? { attrs: ATTR_INVERSE }
				: {}
		if (model.mode === 'navigate' && focused && !gone)
			frame.fillRect({ ...rect, y: rect.y + row, height: 1 }, style)
		const bar = focused ? '▌' : ' '
		const dot = session.status === 'running' ? '○' : '·'
		const dotColor = session.status === 'running' ? GREEN : GREY
		frame.writeText(rect, row, bar, { fg: CYAN, ...(style.attrs ? { attrs: style.attrs } : {}) })
		const label = ` ${index + 1} ${session.label}`
		frame.writeText({ ...rect, x: rect.x + 1, width: rect.width - 1 }, row, label, style)
		frame.writeText({ ...rect, x: rect.x + rect.width - 2, width: 2 }, row, ` ${dot}`, {
			...style,
			fg: dotColor,
		})
		row += 1
		const note = sessionNote(session)
		if (note !== undefined && row < rect.height - 4) {
			frame.writeText({ ...rect, x: rect.x + 3, width: rect.width - 3 }, row, note, {
				fg: GREY,
				attrs: ATTR_DIM,
			})
			row += 1
		}
	})
	const hints = model.confirmingQuit
		? ['Quit and end session?', 'y yes   n stay']
		: model.mode === 'navigate'
			? ['j/k move   enter focus', 'b sidebar   q quit', 'esc back']
			: [`${model.prefixName} to navigate`]
	const top = rect.height - hints.length - 1
	hints.forEach((hint, i) =>
		frame.writeText(rect, top + i + 1, ` ${hint}`, { fg: GREY, attrs: ATTR_DIM }),
	)
}

export function drawRule(frame: Frame, rect: Rect): void {
	for (let y = 0; y < rect.height; y++)
		frame.writeText({ ...rect, height: rect.height }, y, '│', { fg: GREY, attrs: ATTR_DIM })
}
