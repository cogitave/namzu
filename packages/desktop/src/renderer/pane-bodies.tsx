import type { ReactNode } from 'react'
import type { DesktopApi } from '../shared/protocol.js'
import { FileTypeIcon } from './file-panel/file-icons.js'
import { ArrowLeftIcon, GlobeIcon, PlusIcon, RefreshIcon, XIcon } from './icons.js'
import { type OutputFile, outputAddress } from './outputs-model.js'
import { OutputPreview, useSessionOutput } from './outputs-panel.js'
import { Button } from './ui/button.js'
import './file-panel/file-panel.css'
import './pane-bodies.css'

export interface PaneTabItem {
	id: string
	label: string
	icon?: ReactNode
	/** Tooltip, when the label is not the whole name. */
	title?: string
	/** A tab that cannot be closed, such as the tree in the Files pane. */
	fixed?: boolean
}

/** The tabs in a pane's header: a name button and a close button beside it, never inside it. */
export function PaneTabs({
	label,
	tabs,
	active,
	onSelect,
	onClose,
	onNew,
	newLabel,
}: {
	label: string
	tabs: readonly PaneTabItem[]
	active?: string
	onSelect: (id: string) => void
	onClose?: (id: string) => void
	onNew?: () => void
	newLabel?: string
}) {
	return (
		<div className="panel-tab-strip pane-tabs">
			{/* biome-ignore lint/a11y/useSemanticElements: a tab list has no native element. */}
			<div className="panel-tab-list" role="tablist" aria-label={label}>
				<div className="panel-tab-scroll">
					{tabs.map((tab) => {
						const selected = tab.id === active
						return (
							<div
								key={tab.id}
								className="panel-tab"
								role="presentation"
								data-kind="file"
								data-active={selected || undefined}
								title={tab.title}
							>
								<button
									type="button"
									role="tab"
									aria-selected={selected}
									tabIndex={selected ? 0 : -1}
									data-tab={tab.id}
									data-active={selected || undefined}
									className="panel-tab-name"
									onClick={() => onSelect(tab.id)}
								>
									{tab.icon}
									<span>{tab.label}</span>
								</button>
								{onClose && !tab.fixed && (
									<button
										type="button"
										className="panel-tab-close"
										aria-label={`Close ${tab.label}`}
										tabIndex={-1}
										onClick={() => onClose(tab.id)}
									>
										<XIcon aria-hidden="true" />
									</button>
								)}
							</div>
						)
					})}
				</div>
			</div>
			{onNew && (
				<Button
					type="button"
					size="icon-xs"
					variant="ghost-muted"
					className="panel-tab-add"
					aria-label={newLabel ?? 'New tab'}
					title={newLabel ?? 'New tab'}
					onClick={onNew}
				>
					<PlusIcon aria-hidden="true" />
				</Button>
			)}
		</div>
	)
}

/** The tab a file gets in the Files pane. */
export const fileTabItem = (path: string): PaneTabItem => ({
	id: `file:${path}`,
	label: path.split('/').pop() || path,
	title: path,
	icon: <FileTypeIcon path={path} />,
})

/**
 * The Browser pane's body in this version: the address of the page the conversation wrote, and the
 * page itself drawn in a frame with no permissions. Typing an address, going back and the page's
 * own session come with the real browser.
 */
export function BrowserBody({
	api,
	sessionId,
	file,
	workFolder,
	dark,
	onReload,
}: {
	api: Pick<DesktopApi, 'readSessionOutput'>
	sessionId: string
	file?: OutputFile
	workFolder?: string
	dark: boolean
	onReload: () => void
}) {
	const load = useSessionOutput(api, sessionId, file?.path ?? '', file?.version ?? 0)
	return (
		<div className="browser-pane" data-browser-pane>
			<div className="browser-bar">
				<Button
					type="button"
					size="icon-xs"
					variant="ghost-muted"
					aria-label="Back"
					title="Back"
					disabled
				>
					<ArrowLeftIcon aria-hidden="true" />
				</Button>
				<Button
					type="button"
					size="icon-xs"
					variant="ghost-muted"
					aria-label="Reload"
					title="Reload"
					disabled={!file}
					onClick={onReload}
				>
					<RefreshIcon aria-hidden="true" />
				</Button>
				<input
					className="browser-address"
					type="text"
					readOnly
					spellCheck={false}
					aria-label="Address"
					placeholder="No page yet"
					value={file ? outputAddress(file.path, workFolder) : ''}
					title={file?.path}
					onFocus={(event) => event.currentTarget.select()}
				/>
			</div>
			<div className="browser-page">
				{!file ? (
					<div className="browser-empty">
						<GlobeIcon className="size-5" aria-hidden="true" />
						<p>A page the conversation writes opens here.</p>
					</div>
				) : load.status === 'loading' ? (
					<p className="file-view-note">Opening {file.name}…</p>
				) : load.status === 'error' ? (
					<p className="file-view-note" role="alert">
						{load.message}
					</p>
				) : (
					<OutputPreview file={file} content={load.content} dark={dark} />
				)}
			</div>
		</div>
	)
}
