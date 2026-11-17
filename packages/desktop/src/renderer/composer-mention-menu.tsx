import { ComposerListMenu, type ListMenuPlace } from './composer-list-menu.js'
import { type MentionList, type MentionRow, nameSegments } from './composer-mention-list.js'
import { FileTypeIcon } from './file-panel/file-icons.js'

export const MENTION_MENU_ID = 'composer-mention-menu'

/** The "@" menu: files of the project, the matched letters of each name drawn strong, its folder after it in grey. */
export function ComposerMentionMenu({
	place,
	list,
	highlight,
	onHighlight,
	onPick,
}: {
	place: ListMenuPlace
	list: Exclude<MentionList, { kind: 'closed' }>
	highlight: number
	onHighlight: (index: number) => void
	onPick: (row: MentionRow) => void
}) {
	const rows = list.kind === 'rows' ? list.rows : []
	return (
		<ComposerListMenu
			id={MENTION_MENU_ID}
			label="Files"
			place={place}
			className="composer-mention-frame"
			items={rows}
			highlight={highlight}
			onHighlight={onHighlight}
			onPick={onPick}
			rowKey={(row) => row.path}
			header={
				list.kind === 'loading' ? <p className="composer-list-note">Loading files…</p> : undefined
			}
			footer={
				list.kind === 'rows' && list.note ? (
					<p className="composer-list-note">{list.note}</p>
				) : undefined
			}
			renderRow={(row) => (
				<>
					<FileTypeIcon path={row.path} className="composer-list-icon" />
					<span className="composer-list-file" title={row.path}>
						{nameSegments(row).map((segment, index) => (
							<span
								// biome-ignore lint/suspicious/noArrayIndexKey: the runs of one path never reorder
								key={index}
								data-match={segment.match || undefined}
							>
								{segment.text}
							</span>
						))}
					</span>
					{row.directory && <span className="composer-list-folder">{row.directory}</span>}
				</>
			)}
		/>
	)
}
