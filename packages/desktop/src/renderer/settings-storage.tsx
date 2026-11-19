import { useState } from 'react'
import { type StoragePart, formatBytes } from '../shared/storage-protocol.js'
import { middleEllipsis, tildePath } from './path-display.js'
import { Button } from './ui/button.js'
import type { StorageControls, TrustedFoldersControls } from './use-storage-views.js'

/** A size, with a mark when the folder was too large to count every file. */
export function sizeText(part: Pick<StoragePart, 'bytes' | 'approximate'>): string {
	return `${part.approximate ? 'more than ' : ''}${formatBytes(part.bytes)}`
}

/**
 * The sizes by part. Clear is offered only on the parts main says are safe, and asks first: the
 * button turns into a question with the part's name, so the choice is never one click.
 */
export function StoragePanel({ storage }: { storage: StorageControls }) {
	const [asking, setAsking] = useState<StoragePart['id']>()
	const { report, error, busy } = storage
	return (
		<div className="settings-folders" data-settings-storage>
			{error && (
				<p role="alert" className="settings-error">
					{error}
				</p>
			)}
			{!report && !error && <p className="settings-empty">Measuring…</p>}
			{report && (
				<>
					<ul>
						{report.parts.map((part) => (
							<li key={part.id}>
								<div className="settings-project-copy">
									<span className="settings-project-name">{part.label}</span>
									<span className="settings-folder-note" data-safe={part.clearable}>
										{part.note}
									</span>
								</div>
								<span className="settings-project-name" data-size>
									{sizeText(part)}
								</span>
								{part.clearable &&
									(asking === part.id ? (
										<>
											<Button
												variant="outline"
												size="sm"
												disabled={busy}
												aria-label={`Yes, clear ${part.label.toLowerCase()}`}
												onClick={() => {
													setAsking(undefined)
													void storage.clear(part.id)
												}}
											>
												Clear {part.label.toLowerCase()}?
											</Button>
											<Button variant="ghost-muted" size="sm" onClick={() => setAsking(undefined)}>
												Cancel
											</Button>
										</>
									) : (
										<Button
											variant="outline"
											size="sm"
											disabled={busy || part.bytes === 0}
											aria-label={`Clear ${part.label.toLowerCase()}`}
											onClick={() => setAsking(part.id)}
										>
											Clear
										</Button>
									))}
							</li>
						))}
					</ul>
					<p className="settings-help">
						In total Namzu uses {formatBytes(report.totalBytes)} on this computer. Conversations,
						settings and keys are never cleared from here.
					</p>
				</>
			)}
		</div>
	)
}

/**
 * The folders the engine trusts. This is the list that decides whether a folder may be used, so
 * the view says which list it is; Remove asks first. The row above says what removing does.
 */
export function TrustedFoldersPanel({ trusted }: { trusted: TrustedFoldersControls }) {
	const [asking, setAsking] = useState<string>()
	const { view, error, busy } = trusted
	return (
		<div className="settings-folders" data-settings-trusted>
			{error && (
				<p role="alert" className="settings-error">
					{error}
				</p>
			)}
			{!view && !error && <p className="settings-empty">Loading…</p>}
			{view && (
				<>
					<p className="settings-help">Namzu’s own list, kept in {tildePath(view.file)}.</p>
					{view.unreadable && (
						<p role="alert" className="settings-error">
							The list could not be read, so some folders may be missing here.
						</p>
					)}
					{view.folders.length === 0 && !view.unreadable && (
						<p className="settings-empty">No folder is trusted on this computer.</p>
					)}
					<ul>
						{view.folders.map((folder) => (
							<li key={folder}>
								<div className="settings-project-copy">
									<span className="settings-project-path" title={folder}>
										{middleEllipsis(tildePath(folder), 64)}
									</span>
								</div>
								{asking === folder ? (
									<>
										<Button
											variant="outline"
											size="sm"
											disabled={busy}
											aria-label={`Yes, remove ${folder}`}
											onClick={() => {
												setAsking(undefined)
												void trusted.remove(folder)
											}}
										>
											Remove it?
										</Button>
										<Button variant="ghost-muted" size="sm" onClick={() => setAsking(undefined)}>
											Cancel
										</Button>
									</>
								) : (
									<Button
										variant="outline"
										size="sm"
										disabled={busy}
										aria-label={`Remove ${folder}`}
										onClick={() => setAsking(folder)}
									>
										Remove
									</Button>
								)}
							</li>
						))}
					</ul>
				</>
			)}
		</div>
	)
}
