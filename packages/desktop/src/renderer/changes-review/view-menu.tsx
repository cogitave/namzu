import { Menu } from '@base-ui/react/menu'
import { CheckIcon, ChevronRightIcon, MoreHorizontalIcon } from '../icons.js'
import { MenuLabel } from './menu-parts.js'
import type { ChangesDisplay, ListPosition } from './settings.js'

const POSITIONS: { id: ListPosition; label: string }[] = [
	{ id: 'auto', label: 'Automatic' },
	{ id: 'left', label: 'Left' },
	{ id: 'right', label: 'Right' },
]

export function ViewMenu({
	display,
	onDisplay,
	listFits,
	splitFits,
	canHideWhitespace,
	hasFiles,
	tooLargeToExpand,
	shortcut,
	onCollapseAll,
	onExpandAll,
	onRefresh,
}: {
	display: ChangesDisplay
	onDisplay: (patch: Partial<ChangesDisplay>) => void
	/** The pane is wide enough for a file list beside the diffs. */
	listFits: boolean
	/** The pane is wide enough for two columns. */
	splitFits: boolean
	canHideWhitespace: boolean
	hasFiles: boolean
	tooLargeToExpand: boolean
	shortcut: string
	onCollapseAll: () => void
	onExpandAll: () => void
	onRefresh: () => void
}) {
	const checkbox = (
		label: string,
		key: keyof ChangesDisplay,
		options: { hint?: string; disabled?: boolean } = {},
	) => (
		<Menu.CheckboxItem
			className="conversation-actions-item"
			checked={Boolean(display[key])}
			disabled={options.disabled}
			onCheckedChange={(on) => onDisplay({ [key]: on })}
		>
			<MenuLabel hint={options.hint}>{label}</MenuLabel>
			<Menu.CheckboxItemIndicator>
				<CheckIcon aria-hidden="true" />
			</Menu.CheckboxItemIndicator>
		</Menu.CheckboxItem>
	)
	return (
		<Menu.Root>
			<Menu.Trigger
				className="changes-icon-button pane-control"
				aria-label="More options"
				title="More options"
			>
				<MoreHorizontalIcon aria-hidden="true" />
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner className="conversation-actions-positioner" align="end" sideOffset={6}>
					<Menu.Popup
						className="conversation-actions-popup changes-more-popup"
						aria-label="Changes options"
					>
						{hasFiles && (
							<>
								{listFits && checkbox('Show files', 'showFiles', { hint: shortcut })}
								{listFits && (
									<Menu.SubmenuRoot>
										<Menu.SubmenuTrigger className="conversation-actions-item">
											<MenuLabel>File list position</MenuLabel>
											<ChevronRightIcon
												className="conversation-actions-chevron"
												aria-hidden="true"
											/>
										</Menu.SubmenuTrigger>
										<Menu.Portal>
											<Menu.Positioner
												className="conversation-actions-positioner"
												sideOffset={6}
												alignOffset={-6}
											>
												<Menu.Popup
													className="conversation-actions-popup"
													aria-label="File list position"
												>
													<Menu.RadioGroup
														value={display.listPosition}
														onValueChange={(value) =>
															onDisplay({ listPosition: value as ListPosition })
														}
													>
														{POSITIONS.map((item) => (
															<Menu.RadioItem
																key={item.id}
																value={item.id}
																className="conversation-actions-item"
																closeOnClick
															>
																<MenuLabel>{item.label}</MenuLabel>
																<Menu.RadioItemIndicator>
																	<CheckIcon aria-hidden="true" />
																</Menu.RadioItemIndicator>
															</Menu.RadioItem>
														))}
													</Menu.RadioGroup>
												</Menu.Popup>
											</Menu.Positioner>
										</Menu.Portal>
									</Menu.SubmenuRoot>
								)}
								{checkbox('Group files by folder', 'groupByFolder')}
								{checkbox('Separate test, build, and generated files', 'separateKinds')}
								<Menu.Separator className="conversation-actions-separator" />
								<Menu.Item className="conversation-actions-item" onClick={onCollapseAll}>
									<MenuLabel>Collapse all files</MenuLabel>
								</Menu.Item>
								<Menu.Item
									className="conversation-actions-item"
									disabled={tooLargeToExpand}
									title={
										tooLargeToExpand
											? 'This diff is too large to expand at once. Select a file to expand it.'
											: undefined
									}
									onClick={onExpandAll}
								>
									<MenuLabel>Expand all files</MenuLabel>
								</Menu.Item>
								<Menu.Separator className="conversation-actions-separator" />
								{checkbox('Side by side', 'sideBySide', {
									disabled: !splitFits,
									hint: splitFits ? undefined : 'Needs a wider pane',
								})}
								{checkbox('Word wrap', 'wordWrap')}
								{checkbox('Highlight changed words', 'highlightWords')}
								{canHideWhitespace && checkbox('Hide whitespace changes', 'hideWhitespace')}
								<Menu.Separator className="conversation-actions-separator" />
							</>
						)}
						<Menu.Item className="conversation-actions-item" onClick={onRefresh}>
							<MenuLabel>Refresh</MenuLabel>
						</Menu.Item>
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	)
}
