/**
 * The update notice's own row, directly above the input box's upper rule and
 * flush right. It exists only while a notice does, takes at most 60% of the
 * width (the end is cut), and gives way to a critical notice. The words come
 * from `update-notice.ts`; this file only places and colours them.
 */

import { Box, Text } from 'ink'

import { toneColor } from './StatusBar.js'
import type { NoticeTone } from './notifications.js'

export interface UpdateNoticeLine {
	readonly text: string
	readonly tone: NoticeTone
	readonly strong?: string
}

/** The widest the row may be, as a share of the row. */
export const UPDATE_NOTICE_SHARE = 0.6

/** The text that fits, and the columns left empty before it so it ends on the last column. */
export function fitUpdateNotice(
	text: string,
	columns: number,
): { readonly text: string; readonly indent: number } {
	const width = Math.max(0, Math.floor(columns))
	const cap = Math.floor(width * UPDATE_NOTICE_SHARE)
	const chars = [...text]
	const shown = chars.length <= cap ? text : cap > 1 ? `${chars.slice(0, cap - 1).join('')}…` : ''
	return { text: shown, indent: Math.max(0, width - [...shown].length) }
}

/** `text` with its `strong` part bold (when the whole part survived the cut). */
function StrongText({
	text,
	strong,
}: { readonly text: string; readonly strong: string | undefined }) {
	const at = strong ? text.indexOf(strong) : -1
	if (!strong || at < 0) return <>{text}</>
	return (
		<>
			{text.slice(0, at)}
			<Text bold>{strong}</Text>
			{text.slice(at + strong.length)}
		</>
	)
}

export function UpdateNoticeRow({
	notice,
	columns,
	critical = false,
}: {
	readonly notice: UpdateNoticeLine | null
	/** The row's width, excluding the app's own side padding. */
	readonly columns: number
	/** A critical notice is on the footer: this one waits. */
	readonly critical?: boolean
}) {
	if (!notice || critical) return null
	const fit = fitUpdateNotice(notice.text, columns)
	if (fit.text.length === 0) return null
	return (
		<Box height={1} flexShrink={0}>
			<Text color={toneColor(notice.tone)} wrap="truncate-end">
				{' '.repeat(fit.indent)}
				<StrongText text={fit.text} strong={notice.strong} />
			</Text>
		</Box>
	)
}
