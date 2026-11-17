import { MultiFileDiff } from '@pierre/diffs/react'
import { useMemo, useState } from 'react'
import { CUT_NOTE, formatLineCount } from '../changes-totals.js'
import { DIFF_VIEW_UNSAFE_CSS } from '../diff-theme.js'
import { gateNotice, richDiffVerdict } from './diff-gate.js'
import { type ReviewFile, unifiedDiff } from './model.js'

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

/** The patch text of a file: one block per edit when it was edited more than once. */
export function patchOf(file: ReviewFile, before: string, after: string): string {
	if (file.edits && file.edits.length > 1)
		return file.edits.map((edit) => unifiedDiff(file.path, edit.before, edit.after)).join('')
	return unifiedDiff(file.path, before, after, file.oldPath)
}

function PaneMessage({ children }: { children: string }) {
	return <p className="changes-message">{children}</p>
}

/** One file's diff body: the pierre view, or the note that says why there is none. */
export function FileBody({
	file,
	body,
	split,
	wrap,
	highlight,
	dark,
	fullContext,
}: {
	file: ReviewFile
	body: DiffBody
	split: boolean
	wrap: boolean
	/** Changed words inside a changed line are marked. */
	highlight: boolean
	dark: boolean
	/** A working-tree file shows every line; a receipt shows its hunks. */
	fullContext: boolean
}) {
	const options = useMemo(
		() => ({
			theme: { light: 'pierre-light', dark: 'pierre-dark' } as const,
			themeType: dark ? ('dark' as const) : ('light' as const),
			preferredHighlighter: 'shiki-wasm' as const,
			diffStyle: split ? ('split' as const) : ('unified' as const),
			diffIndicators: 'bars' as const,
			overflow: wrap ? ('wrap' as const) : ('scroll' as const),
			lineDiffType: highlight ? ('word-alt' as const) : ('none' as const),
			hunkSeparators: 'line-info' as const,
			disableFileHeader: true,
			expandUnchanged: fullContext,
			unsafeCSS: DIFF_VIEW_UNSAFE_CSS,
		}),
		[dark, split, wrap, highlight, fullContext],
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
			gated && body.state === 'ready' ? patchOf(file, body.before ?? '', body.after ?? '') : '',
		[gated, body, file],
	)
	return (
		<div className="changes-diff-body">
			{body.state === 'loading' ? (
				<PaneMessage>Reading the file…</PaneMessage>
			) : body.state === 'error' ? (
				<p className="changes-message" role="alert">
					{body.message}
				</p>
			) : body.binary || file.status === 'binary' ? (
				<PaneMessage>This file is binary, so there is no text to compare.</PaneMessage>
			) : file.whitespaceOnly ? (
				<PaneMessage>Only whitespace changed in this file.</PaneMessage>
			) : (
				<>
					{body.truncated && (
						<PaneMessage>
							This file is too large to show in full; only part of it is compared.
						</PaneMessage>
					)}
					{file.cut && <p className="changes-note changes-cut-note">{CUT_NOTE}</p>}
					{file.partial && (
						<p className="changes-note">Some edits to this file have no diff to show.</p>
					)}
					{file.noDiff ? (
						<PaneMessage>No diff is available for this change.</PaneMessage>
					) : gated && !verdict.rich ? (
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
					) : file.edits && file.edits.length > 1 ? (
						file.edits.map((edit, index) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: edits have no id and keep their order
							<section key={index} className="changes-edit" data-edit={index + 1}>
								<p className="changes-edit-head">
									<span>
										Edit {index + 1} of {file.edits?.length}
									</span>
									<span className="changes-added">+{formatLineCount(edit.added)}</span>
									<span className="changes-removed">−{formatLineCount(edit.removed)}</span>
									{edit.cut && <span className="changes-cut-note">{CUT_NOTE}</span>}
								</p>
								<MultiFileDiff
									className="diff-code-view"
									oldFile={{ name: file.path, contents: edit.before }}
									newFile={{ name: file.path, contents: edit.after }}
									options={options}
								/>
							</section>
						))
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
	)
}
