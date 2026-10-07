import { Menu } from '@base-ui/react/menu'
import { MultiFileDiff } from '@pierre/diffs/react'
import { type ComponentProps, useMemo, useState } from 'react'
import { formatLineCount } from '../changes-totals.js'
import { DIFF_VIEW_UNSAFE_CSS } from '../diff-theme.js'
import { CodeIcon, ExternalLinkIcon, FileIcon } from '../file-panel/file-icons.js'
import { isMarkdownPath } from '../file-panel/project-refs.js'
import { CopyIcon, MoreHorizontalIcon } from '../icons.js'
import { gateNotice, richDiffVerdict } from './diff-gate.js'
import { type ReviewFile, unifiedDiff } from './model.js'
import { ToolButton } from './tool-button.js'

export type DiffBody =
	| { state: 'loading' }
	| { state: 'error'; message: string }
	| {
			state: 'ready'
			before: string | null
			after: string | null
			binary: boolean
			truncated: boolean
	  }

export interface DiffActions {
	onOpenFile?: (path: string) => void
	onOpenInEditor?: (path: string) => void
	onCopy: (text: string, done: string) => void
}

function PaneMessage({ children }: { children: string }) {
	return <p className="changes-message">{children}</p>
}

function DiffHeader({
	file,
	body,
	actions,
}: { file: ReviewFile; body: DiffBody; actions: DiffActions }) {
	const copyDiff = () => {
		if (body.state !== 'ready') return
		actions.onCopy(
			unifiedDiff(file.path, body.before ?? '', body.after ?? '', file.oldPath),
			'Diff copied.',
		)
	}
	return (
		<div className="changes-diff-head">
			{isMarkdownPath(file.path) ? (
				<span className="changes-tree-badge" aria-hidden="true">
					M↓
				</span>
			) : (
				<FileIcon className="changes-tree-file-icon" />
			)}
			{/* The tail of a path names the file, so the head is what gets cut. */}
			<span className="changes-diff-path" title={file.path}>
				<bdi>{file.path}</bdi>
			</span>
			{file.status !== 'binary' && !file.binary && (file.added > 0 || file.removed > 0) && (
				<span className="changes-diff-counts">
					{file.added > 0 && <span className="changes-added">+{formatLineCount(file.added)}</span>}
					{file.removed > 0 && (
						<span className="changes-removed">−{formatLineCount(file.removed)}</span>
					)}
				</span>
			)}
			{actions.onOpenFile && (
				<ToolButton
					label="Open file"
					tooltip="Open the file in a tab"
					disabled={file.status === 'deleted'}
					onClick={() => actions.onOpenFile?.(file.path)}
				>
					<FileIcon />
				</ToolButton>
			)}
			{actions.onOpenInEditor && (
				<ToolButton
					label="Open in editor"
					disabled={file.status === 'deleted'}
					onClick={() => actions.onOpenInEditor?.(file.path)}
				>
					<ExternalLinkIcon />
				</ToolButton>
			)}
			<Menu.Root>
				<Menu.Trigger
					className="changes-menu-trigger"
					aria-label="More file actions"
					render={<ToolButtonLike />}
				/>
				<Menu.Portal>
					<Menu.Positioner className="conversation-actions-positioner" align="end" sideOffset={6}>
						<Menu.Popup className="conversation-actions-popup" aria-label="File actions">
							<Menu.Item
								className="conversation-actions-item"
								onClick={() => actions.onCopy(file.path, 'Path copied.')}
							>
								<CopyIcon aria-hidden="true" />
								<span className="conversation-actions-label">Copy path</span>
							</Menu.Item>
							<Menu.Item
								className="conversation-actions-item"
								disabled={body.state !== 'ready' || body.binary}
								onClick={copyDiff}
							>
								<CodeIcon aria-hidden="true" />
								<span className="conversation-actions-label">Copy diff</span>
							</Menu.Item>
						</Menu.Popup>
					</Menu.Positioner>
				</Menu.Portal>
			</Menu.Root>
		</div>
	)
}

/** The menu trigger styled like the toolbar's icon buttons. */
function ToolButtonLike(props: ComponentProps<'button'>) {
	return (
		<button type="button" {...props} className="changes-icon-button">
			<MoreHorizontalIcon aria-hidden="true" />
		</button>
	)
}

/** One file's diff: a header with its actions above the pierre view. */
export function DiffPane({
	file,
	body,
	split,
	wrap,
	dark,
	fullContext,
	actions,
}: {
	file: ReviewFile
	body: DiffBody
	split: boolean
	wrap: boolean
	dark: boolean
	/** A working-tree file shows every line; a receipt shows its hunks. */
	fullContext: boolean
	actions: DiffActions
}) {
	const options = useMemo(
		() => ({
			theme: { light: 'pierre-light', dark: 'pierre-dark' } as const,
			themeType: dark ? ('dark' as const) : ('light' as const),
			preferredHighlighter: 'shiki-wasm' as const,
			diffStyle: split ? ('split' as const) : ('unified' as const),
			diffIndicators: 'bars' as const,
			overflow: wrap ? ('wrap' as const) : ('scroll' as const),
			hunkSeparators: 'line-info' as const,
			disableFileHeader: true,
			expandUnchanged: fullContext,
			unsafeCSS: DIFF_VIEW_UNSAFE_CSS,
		}),
		[dark, split, wrap, fullContext],
	)
	// Which file the person asked to see in full; a different file is gated again.
	const [forcedPath, setForcedPath] = useState<string | null>(null)
	const verdict = useMemo(
		() =>
			body.state === 'ready' && !body.binary && file.status !== 'binary'
				? richDiffVerdict({
						before: body.before,
						after: body.after,
						added: file.added,
						removed: file.removed,
					})
				: ({ rich: true } as const),
		[body, file.added, file.removed, file.status],
	)
	const gated = !verdict.rich && forcedPath !== file.path
	// Only built once the gate trips: parsing a huge file is the cost the gate avoids.
	const patch = useMemo(
		() =>
			gated && body.state === 'ready'
				? unifiedDiff(file.path, body.before ?? '', body.after ?? '', file.oldPath)
				: '',
		[gated, body, file.path, file.oldPath],
	)
	return (
		<section className="changes-diff" aria-label={`Changes to ${file.path}`}>
			<DiffHeader file={file} body={body} actions={actions} />
			<div className="changes-diff-body">
				{body.state === 'loading' ? (
					<PaneMessage>Reading the file…</PaneMessage>
				) : body.state === 'error' ? (
					<p className="changes-message" role="alert">
						{body.message}
					</p>
				) : body.binary || file.status === 'binary' ? (
					<PaneMessage>This file is binary, so there is no text to compare.</PaneMessage>
				) : (
					<>
						{body.truncated && (
							<PaneMessage>
								This file is too large to show in full; only part of it is compared.
							</PaneMessage>
						)}
						{gated && !verdict.rich ? (
							<>
								<p className="changes-note changes-gate-note">
									<span>{gateNotice(verdict)}</span>
									<button
										type="button"
										className="changes-gate-button"
										onClick={() => setForcedPath(file.path)}
									>
										Show full diff anyway
									</button>
								</p>
								<pre className="changes-plain-patch" data-wrap={wrap || undefined}>
									{patch}
								</pre>
							</>
						) : (
							<MultiFileDiff
								key={file.path}
								className="diff-code-view"
								oldFile={{
									name: file.oldPath ?? file.path,
									contents: body.before ?? '',
								}}
								newFile={{ name: file.path, contents: body.after ?? '' }}
								options={options}
							/>
						)}
					</>
				)}
			</div>
		</section>
	)
}
