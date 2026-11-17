import { ComposerListMenu, type ListMenuPlace } from './composer-list-menu.js'
import type { SlashEntry } from './composer-menu-model.js'

export const SLASH_MENU_ID = 'composer-slash-menu'

/** The "/" menu: one line per command, its name only; what it does is the tooltip beside the highlighted row. */
export function ComposerSlashMenu<T extends SlashEntry>({
	place,
	rows,
	highlight,
	onHighlight,
	onPick,
	note,
}: {
	place: ListMenuPlace
	rows: readonly T[]
	highlight: number
	onHighlight: (index: number) => void
	onPick: (row: T) => void
	/** A muted line after the rows, such as "More commands appear once the conversation starts". */
	note?: string
}) {
	return (
		<ComposerListMenu
			id={SLASH_MENU_ID}
			label="Commands"
			place={place}
			items={rows}
			highlight={highlight}
			onHighlight={onHighlight}
			onPick={onPick}
			rowKey={(row) => row.name}
			tooltipFor={(row) => row.tooltip}
			renderRow={(row) => (
				<>
					<span className="composer-list-name">{row.name}</span>
					{row.tag && <span className="composer-list-tag">{row.tag}</span>}
				</>
			)}
			footer={note ? <p className="composer-list-note">{note}</p> : undefined}
		/>
	)
}
