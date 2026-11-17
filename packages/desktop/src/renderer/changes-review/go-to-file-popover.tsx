import { Popover } from '@base-ui/react/popover'
import { useMemo, useState } from 'react'
import { formatLineCount } from '../changes-totals.js'
import { FileTypeIcon } from '../file-panel/file-icons.js'
import { SearchIcon } from '../icons.js'
import { GO_TO_LIMIT, goToFileRows } from './go-to-file.js'
import type { ReviewFile } from './model.js'

/** "Go to file": a search over the changed files that jumps to one; it filters nothing. */
export function GoToFile({
	files,
	open,
	onOpenChange,
	onPick,
	shortcut,
}: {
	files: readonly ReviewFile[]
	open: boolean
	onOpenChange: (open: boolean) => void
	onPick: (path: string) => void
	shortcut: string
}) {
	const [query, setQuery] = useState('')
	const [active, setActive] = useState(0)
	const byPath = useMemo(() => new Map(files.map((file) => [file.path, file])), [files])
	const { rows, more } = useMemo(
		() =>
			goToFileRows(
				files.map((file) => file.path),
				query,
			),
		[files, query],
	)
	const pick = (path: string | undefined) => {
		if (!path) return
		onOpenChange(false)
		onPick(path)
	}
	return (
		<Popover.Root
			open={open}
			onOpenChange={(next) => {
				onOpenChange(next)
				if (!next) {
					setQuery('')
					setActive(0)
				}
			}}
		>
			<Popover.Trigger
				className="changes-icon-button pane-control"
				aria-label="Go to file"
				title={`Go to file (${shortcut})`}
			>
				<SearchIcon aria-hidden="true" />
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Positioner className="conversation-actions-positioner" align="end" sideOffset={6}>
					<Popover.Popup
						className="conversation-actions-popup changes-goto"
						aria-label="Go to file"
					>
						<label className="changes-goto-field">
							<SearchIcon aria-hidden="true" />
							<input
								type="text"
								value={query}
								placeholder="Search changed files"
								aria-label="Search changed files"
								spellCheck={false}
								autoComplete="off"
								// biome-ignore lint/a11y/noAutofocus: the palette exists to be typed into.
								autoFocus
								onChange={(event) => {
									setQuery(event.target.value)
									setActive(0)
								}}
								onKeyDown={(event) => {
									if (event.key === 'Enter') {
										event.preventDefault()
										pick(rows[active]?.path)
									} else if (event.key === 'ArrowDown') {
										event.preventDefault()
										setActive((value) => Math.min(rows.length - 1, value + 1))
									} else if (event.key === 'ArrowUp') {
										event.preventDefault()
										setActive((value) => Math.max(0, value - 1))
									}
								}}
							/>
						</label>
						<ul className="changes-goto-list" aria-label="Changed files">
							{rows.length === 0 && <li className="changes-menu-note">No matching files</li>}
							{rows.map((row, index) => {
								const file = byPath.get(row.path)
								return (
									<li key={row.path}>
										<button
											type="button"
											aria-current={index === active || undefined}
											className="changes-goto-row"
											data-active={index === active || undefined}
											title={file?.oldPath ? `${file.oldPath} → ${file.path}` : row.path}
											onMouseMove={() => setActive(index)}
											onClick={() => pick(row.path)}
										>
											<FileTypeIcon path={row.path} className="changes-file-icon" />
											<span className="changes-goto-path">
												<bdi>
													{row.segments.map((part, at) =>
														part.match ? (
															// biome-ignore lint/suspicious/noArrayIndexKey: runs have no id
															<mark key={at}>{part.text}</mark>
														) : (
															// biome-ignore lint/suspicious/noArrayIndexKey: runs have no id
															<span key={at}>{part.text}</span>
														),
													)}
												</bdi>
											</span>
											{file && (file.added > 0 || file.removed > 0) && (
												<span className="changes-diff-counts">
													{file.added > 0 && (
														<span className="changes-added">+{formatLineCount(file.added)}</span>
													)}
													{file.removed > 0 && (
														<span className="changes-removed">
															−{formatLineCount(file.removed)}
														</span>
													)}
												</span>
											)}
										</button>
									</li>
								)
							})}
							{more > 0 && (
								<li className="changes-menu-note">{more} more files. Keep typing to narrow.</li>
							)}
						</ul>
					</Popover.Popup>
				</Popover.Positioner>
			</Popover.Portal>
		</Popover.Root>
	)
}

export { GO_TO_LIMIT }
