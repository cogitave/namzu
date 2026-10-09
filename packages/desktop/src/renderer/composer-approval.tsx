import { MultiFileDiff } from '@pierre/diffs/react'
import {
	type KeyboardEvent,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from 'react'
import type { PermissionResponse, PermissionView } from '../shared/protocol.js'
import {
	type ApprovalCardModel,
	FEEDBACK_NOTE_MAX,
	approvalConsequence,
	approvalWarning,
	buildApprovalCard,
	declineFeedback,
	palMessageNote,
	previewNote,
	riskyCommand,
} from './approval-card-model.js'
import { gateNotice, richDiffVerdict } from './changes-review/diff-gate.js'
import { unifiedDiff } from './changes-review/model.js'
import { formatLineCount } from './changes-totals.js'
import { ComposerBanner } from './composer-banner.js'
import { DIFF_VIEW_UNSAFE_CSS } from './diff-theme.js'
import { ChevronDownIcon, ShieldAlertIcon, TextWrapIcon } from './icons.js'
import './composer-approval.css'

/** The document's own theme class: the card sits outside the app's appearance state. */
const readDark = () =>
	typeof document !== 'undefined' && document.documentElement.classList.contains('dark')

function useDocumentDark(): boolean {
	const [dark, setDark] = useState(readDark)
	useEffect(() => {
		const observer = new MutationObserver(() => setDark(readDark()))
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
		return () => observer.disconnect()
	}, [])
	return dark
}

function DiffBox({
	model,
	wrap,
	expanded,
	onExpand,
}: {
	model: ApprovalCardModel
	wrap: boolean
	expanded: boolean
	onExpand: (value: boolean) => void
}) {
	const dark = useDocumentDark()
	const diff = model.diff
	const scroller = useRef<HTMLDivElement>(null)
	const content = useRef<HTMLDivElement>(null)
	const [overflowing, setOverflowing] = useState(false)
	const options = useMemo(
		() => ({
			theme: { light: 'pierre-light', dark: 'pierre-dark' } as const,
			themeType: dark ? ('dark' as const) : ('light' as const),
			preferredHighlighter: 'shiki-wasm' as const,
			diffStyle: 'unified' as const,
			diffIndicators: 'bars' as const,
			overflow: wrap ? ('wrap' as const) : ('scroll' as const),
			hunkSeparators: 'line-info' as const,
			disableFileHeader: true,
			unsafeCSS: DIFF_VIEW_UNSAFE_CSS,
		}),
		[dark, wrap],
	)
	const verdict = useMemo(
		() =>
			diff
				? richDiffVerdict({
						before: diff.before,
						after: diff.after,
						added: model.added ?? 0,
						removed: model.removed ?? 0,
					})
				: ({ rich: true } as const),
		[diff, model.added, model.removed],
	)
	const patch = useMemo(
		() => (diff && !verdict.rich ? unifiedDiff(diff.path, diff.before, diff.after) : ''),
		[diff, verdict],
	)
	// The diff element draws on the render after it mounts, not on the one that mounts it, and
	// nothing else re-renders a card that waits for an answer; one extra render makes it draw.
	const [, redraw] = useState(0)
	useEffect(() => redraw(1), [])
	// The body is a custom element, so its height is only known by watching it.
	useLayoutEffect(() => {
		const node = content.current
		if (!node) return
		const measure = () => setOverflowing(node.scrollHeight > 280 + 1)
		measure()
		const observer = new ResizeObserver(measure)
		observer.observe(node)
		return () => observer.disconnect()
	}, [])
	if (!diff) return null
	return (
		<div className="approval-diff">
			<div
				ref={scroller}
				className="approval-diff-scroll"
				data-expanded={expanded || undefined}
				// A scrolling box has to take focus so the keyboard can scroll it.
				// biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable region
				tabIndex={0}
				// biome-ignore lint/a11y/useSemanticElements: a section would read as a page landmark
				role="region"
				aria-label={`Proposed change to ${model.fileName}`}
			>
				<div ref={content}>
					{verdict.rich ? (
						<MultiFileDiff
							className="diff-code-view"
							oldFile={{ name: diff.path, contents: diff.before }}
							newFile={{ name: diff.path, contents: diff.after }}
							options={options}
						/>
					) : (
						<>
							<p className="approval-note">{gateNotice(verdict)}</p>
							<pre className="changes-plain-patch" data-wrap={wrap || undefined}>
								{patch}
							</pre>
						</>
					)}
				</div>
			</div>
			{(overflowing || expanded) && (
				<button
					type="button"
					className="approval-more"
					aria-expanded={expanded}
					onClick={() => onExpand(!expanded)}
				>
					<ChevronDownIcon aria-hidden="true" data-up={expanded || undefined} />
					{expanded ? 'Show less' : 'Show more'}
				</button>
			)}
		</div>
	)
}

export function ComposerApproval({
	permission,
	palNames,
	count,
	folder,
	onRespond,
}: {
	permission: PermissionView
	palNames?: ReadonlyMap<string, string> | undefined
	count: number
	/** The folder the conversation works in, named on a command so the person knows where it runs. */
	folder?: string | undefined
	onRespond: (permission: PermissionView, response: PermissionResponse) => unknown
}) {
	const model = useMemo(() => buildApprovalCard(permission, palNames), [permission, palNames])
	const [wrap, setWrap] = useState(false)
	const [expanded, setExpanded] = useState(false)
	const [editing, setEditing] = useState(false)
	const [note, setNote] = useState('')
	const editButton = useRef<HTMLButtonElement>(null)
	const risky =
		model.kind === 'command' && model.command !== undefined && riskyCommand(model.command)
	const acceptButton = useRef<HTMLButtonElement>(null)
	const rejectButton = useRef<HTMLButtonElement>(null)
	const noteField = useRef<HTMLInputElement>(null)
	const answered = useRef(false)
	const returning = useRef(false)

	const respond = useCallback(
		(response: PermissionResponse) => {
			// One answer per request: a double click must not send a second.
			if (answered.current) return
			answered.current = true
			// A refused or failed answer leaves the request pending, so the card must take another.
			const release = (delivered: unknown) => {
				if (delivered === false) answered.current = false
			}
			try {
				const result = onRespond(permission, response)
				if (result instanceof Promise) result.then(release, () => release(false))
				else release(result)
			} catch {
				release(false)
			}
		},
		[onRespond, permission],
	)
	const accept = () => respond({ outcome: 'approve' })
	const reject = () => respond({ outcome: 'reject' })
	const send = () => {
		if (!note.trim()) return
		respond({ outcome: 'reject', feedback: declineFeedback(note), note })
	}
	const cancelEdit = () => {
		returning.current = true
		setEditing(false)
		setNote('')
	}
	// A new card takes the keyboard, so Enter answers it and a person is not left typing into the
	// composer behind it. Someone in the middle of a message keeps their place and their words.
	useEffect(() => {
		const active = document.activeElement
		const typing =
			(active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) &&
			active.value.trim().length > 0
		// A command that deletes never has Enter on yes: a stray Enter must not run it.
		if (!typing) (risky ? rejectButton : acceptButton).current?.focus()
	}, [risky])
	useEffect(() => {
		if (editing) noteField.current?.focus()
		// Back to where the person was, not to the composer.
		else if (returning.current) {
			returning.current = false
			editButton.current?.focus()
		}
	}, [editing])

	const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
		if (editing) {
			if (event.key === 'Escape') {
				event.preventDefault()
				event.stopPropagation()
				cancelEdit()
			}
			return
		}
		// Only while focus is inside the card: the listener lives on it, not on the window.
		if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
			event.preventDefault()
			accept()
		}
	}

	const consequence = approvalConsequence(model, folder)
	const hasDiff = Boolean(model.diff)
	const showDetails = !(model.diff && !model.diff.fragment) || permission.calls.length > 1
	const showWarning = model.destructive && model.kind !== 'create'
	return (
		<ComposerBanner.Dock>
			<ComposerBanner.Column>
				<ComposerBanner.Attachment>
					<section aria-label="Tool approval" onKeyDown={onKeyDown}>
						<ComposerBanner.Root variant="default" density="spacious">
							<div className="approval-card" data-kind={model.kind}>
								<header className="approval-head">
									<ShieldAlertIcon aria-hidden="true" className="approval-head-icon" />
									<h3 className="approval-title" title={model.path}>
										{model.title}
									</h3>
									{hasDiff && (model.added || model.removed) ? (
										<span className="approval-counts">
											{model.added ? (
												<span
													className="changes-added"
													title={`${model.added} ${model.added === 1 ? 'line' : 'lines'} added`}
													role="img"
													aria-label={`${model.added} ${model.added === 1 ? 'line' : 'lines'} added`}
												>
													+{formatLineCount(model.added)}
												</span>
											) : null}
											{model.removed ? (
												<span
													className="changes-removed"
													title={`${model.removed} ${model.removed === 1 ? 'line' : 'lines'} removed`}
													role="img"
													aria-label={`${model.removed} ${model.removed === 1 ? 'line' : 'lines'} removed`}
												>
													−{formatLineCount(model.removed)}
												</span>
											) : null}
										</span>
									) : null}
									{count > 1 && <span className="approval-count">1 of {count}</span>}
								</header>
								{model.previewMissing && <p className="approval-note">{previewNote(model)}</p>}
								<DiffBox model={model} wrap={wrap} expanded={expanded} onExpand={setExpanded} />
								{model.command !== undefined && (
									// biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable region
									<pre className="approval-command" tabIndex={0} aria-label="Command">
										{model.command}
									</pre>
								)}
								{model.message !== undefined && (
									// A message is prose the person wrote, not something that will be run.
									// biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable region
									<blockquote className="approval-message" tabIndex={0} aria-label="Message">
										{model.message}
									</blockquote>
								)}
								{model.message !== undefined && (
									<p className="approval-note">{palMessageNote(model.palName)}</p>
								)}
								{model.kind === 'other' && model.entries.length > 0 && (
									<dl className="approval-entries">
										{model.entries.map((entry) => (
											<div key={entry.label} className="approval-entry">
												<dt>{entry.label}</dt>
												<dd>{entry.value}</dd>
											</div>
										))}
									</dl>
								)}
								{consequence && !showWarning && (
									<p className="approval-note approval-consequence">{consequence}</p>
								)}
								{model.others.length > 0 && (
									<p className="approval-note">
										Also in this request: {model.others.join(', ')}. Your answer covers all of them.
									</p>
								)}
								{showWarning && <p className="approval-warning">{approvalWarning(model)}</p>}
								{showDetails && (
									<details className="approval-details">
										<summary>Details</summary>
										<pre>
											{JSON.stringify(
												permission.calls.length === 1
													? permission.calls[0]?.input
													: permission.calls.map((call) => call.input),
												null,
												2,
											)}
										</pre>
									</details>
								)}
								<footer className="approval-footer">
									{editing ? (
										<>
											<input
												ref={noteField}
												className="approval-note-field"
												type="text"
												value={note}
												maxLength={FEEDBACK_NOTE_MAX}
												placeholder="Tell Namzu what to do instead"
												aria-label="Tell Namzu what to do instead"
												onChange={(event) => setNote(event.target.value)}
												onKeyDown={(event) => {
													if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
														event.preventDefault()
														send()
													}
												}}
											/>
											<button
												type="button"
												className="approval-button"
												onClick={send}
												disabled={!note.trim()}
											>
												Send
											</button>
											<button type="button" className="approval-button" onClick={cancelEdit}>
												Cancel
											</button>
										</>
									) : (
										<>
											{hasDiff && (
												<button
													type="button"
													className="approval-button approval-icon-button"
													aria-pressed={wrap}
													aria-label="Wrap long lines"
													title="Wrap long lines"
													onClick={() => setWrap((value) => !value)}
												>
													<TextWrapIcon aria-hidden="true" />
												</button>
											)}
											<button
												ref={editButton}
												type="button"
												className="approval-button approval-instead"
												onClick={() => setEditing(true)}
											>
												Tell Namzu what to do instead
											</button>
											<button
												ref={rejectButton}
												type="button"
												className="approval-button"
												data-tone="reject"
												onClick={reject}
											>
												Reject
											</button>
											<button
												ref={acceptButton}
												type="button"
												className="approval-button"
												data-tone="accept"
												onClick={accept}
											>
												Accept
											</button>
										</>
									)}
								</footer>
								{!editing && (
									<p className="approval-hint">
										{risky
											? 'This one looks risky, so Enter rejects it. Esc stops this reply and nothing waiting here runs.'
											: 'Enter accepts. Esc stops this reply and nothing waiting here runs.'}
									</p>
								)}
							</div>
						</ComposerBanner.Root>
					</section>
				</ComposerBanner.Attachment>
			</ComposerBanner.Column>
		</ComposerBanner.Dock>
	)
}
