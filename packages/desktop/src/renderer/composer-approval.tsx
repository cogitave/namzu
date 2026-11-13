import { Menu } from '@base-ui/react/menu'
import { MultiFileDiff } from '@pierre/diffs/react'
import {
	type KeyboardEvent,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from 'react'
import type { PermissionResponse, PermissionView } from '../shared/protocol.js'
import {
	type ApprovalCardModel,
	CONVERSATION_ALLOWANCE_SCOPE,
	FEEDBACK_NOTE_MAX,
	approvalConsequence,
	approvalConsequenceTitle,
	approvalDetails,
	approvalFlags,
	buildApprovalCard,
	declineFeedback,
	offersConversationAllowance,
	palMessageNote,
	previewNote,
	rejectsFirst,
	screenMomentNote,
} from './approval-card-model.js'
import { createClickGuard } from './approval-gate.js'
import { type ApprovalPreview, commandChip, diffPreview, textPreview } from './approval-preview.js'
import { richDiffVerdict } from './changes-review/diff-gate.js'
import { unifiedDiff } from './changes-review/model.js'
import { formatLineCount } from './changes-totals.js'
import { copyPlainText } from './copy-button.js'
import { DIFF_VIEW_UNSAFE_CSS } from './diff-theme.js'
import {
	ChevronDownIcon,
	CopyIcon,
	MoreHorizontalIcon,
	PencilIcon,
	ShieldAlertIcon,
	TextWrapIcon,
	TriangleAlertIcon,
} from './icons.js'
import { displayPath } from './path-display.js'
import './conversation-actions-menu.css'
import './composer-approval.css'

/** The document's own theme class: the card sits outside the app's appearance state. */
const readDark = () =>
	typeof document !== 'undefined' && document.documentElement.classList.contains('dark')

function useDocumentDark(): boolean {
	const [dark, setDark] = useState(readDark)
	useEffect(() => {
		const observer = new MutationObserver(() => setDark(readDark()))
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ['class'],
		})
		return () => observer.disconnect()
	}, [])
	return dark
}

/** Longer than this a row no longer fits the box on one line. */
const CLIPPED_ROW = 80

/** Longer than any path: the row cuts the middle itself, to the width it has. */
const PATH_ROW_MAX = 4096

/** The key that answers yes from anywhere in the card, as the platform writes it. */
const acceptKey = () =>
	typeof navigator !== 'undefined' && /Mac/.test(navigator.platform) ? '⌘↵' : 'Ctrl+Enter'

const lineWord = (count: number) => (count === 1 ? 'line' : 'lines')

/** `text` cut in the middle to `keep` characters, the cut marked by an ellipsis. */
export function cutMiddle(text: string, keep: number): string {
	if (keep >= text.length) return text
	const room = Math.max(1, keep - 1)
	const head = Math.ceil(room / 2)
	const tail = Math.floor(room / 2)
	return `${text.slice(0, head)}…${tail > 0 ? text.slice(-tail) : ''}`
}

/**
 * The path or command in its row: all of it when it fits, else cut in the middle so both ends are
 * still there. A hidden copy of the row measures each try, so the text the person reads is never
 * touched outside React. `onCut` says whether anything is hidden.
 */
function CutRow({
	text,
	title,
	onCut,
}: {
	text: string
	title?: string | undefined
	onCut?: ((cut: boolean) => void) | undefined
}) {
	const row = useRef<HTMLSpanElement>(null)
	const probe = useRef<HTMLSpanElement>(null)
	const [shown, setShown] = useState(text)
	useLayoutEffect(() => {
		const visible = row.current
		const hidden = probe.current
		if (!visible || !hidden) return
		const fit = () => {
			const room = visible.clientWidth
			const fits = (candidate: string) => {
				hidden.textContent = candidate
				return hidden.getBoundingClientRect().width <= room
			}
			let next = text
			if (!fits(text)) {
				let low = 1
				let high = text.length
				while (low < high) {
					const mid = Math.ceil((low + high) / 2)
					if (fits(cutMiddle(text, mid))) low = mid
					else high = mid - 1
				}
				next = cutMiddle(text, low)
			}
			// An unused copy would still count toward the row's scroll width.
			hidden.textContent = ''
			setShown(next)
			onCut?.(next !== text)
		}
		fit()
		const observer = new ResizeObserver(fit)
		observer.observe(visible)
		return () => observer.disconnect()
	}, [text, onCut])
	return (
		<span className="approval-path-text" ref={row} title={title ?? text}>
			<span aria-hidden={shown !== text || undefined}>{shown}</span>
			{shown !== text && <span className="sr-only">{text}</span>}
			<span className="approval-path-probe" ref={probe} aria-hidden="true" />
		</span>
	)
}

/** The whole change, drawn by the diff view. Only mounted once the person asks for all of it. */
function FullDiff({
	diff,
	wrap,
	label,
	rich,
	patch,
}: {
	diff: NonNullable<ApprovalCardModel['diff']>
	wrap: boolean
	label: string
	rich: boolean
	patch: string
}) {
	const dark = useDocumentDark()
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
	// The diff element draws on the render after it mounts, not on the one that mounts it, and
	// nothing else re-renders a card that waits for an answer; one extra render makes it draw.
	const [, redraw] = useState(0)
	useEffect(() => redraw(1), [])
	return (
		<div
			className="approval-full"
			// A scrolling box has to take focus so the keyboard can scroll it.
			// biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable region
			tabIndex={0}
			// biome-ignore lint/a11y/useSemanticElements: a section would read as a page landmark
			role="region"
			aria-label={label}
		>
			{rich ? (
				<MultiFileDiff
					className="diff-code-view"
					oldFile={{ name: diff.path, contents: diff.before }}
					newFile={{ name: diff.path, contents: diff.after }}
					options={options}
				/>
			) : (
				<pre className="changes-plain-patch" data-wrap={wrap || undefined}>
					{patch}
				</pre>
			)}
		</div>
	)
}

/** The first rows of the change or the command, drawn by the card itself. */
function PreviewRows({
	preview,
	wrap,
	command,
	numbered,
}: {
	preview: ApprovalPreview
	wrap: boolean
	command?: boolean
	numbered: boolean
}) {
	return (
		<div className="approval-rows" data-wrap={wrap || undefined}>
			{preview.rows.map((row, index) => (
				<div
					// biome-ignore lint/suspicious/noArrayIndexKey: the rows are a fixed prefix of one change
					key={index}
					className="approval-row"
					data-kind={row.kind}
				>
					{numbered && <span className="approval-row-line">{row.line}</span>}
					<span className="approval-row-sign" aria-hidden="true">
						{command
							? index === 0
								? '$'
								: ''
							: row.kind === 'add'
								? '+'
								: row.kind === 'remove'
									? '−'
									: ''}
					</span>
					<span className="approval-row-text">
						{row.kind === 'add' && <span className="sr-only">Added: </span>}
						{row.kind === 'remove' && <span className="sr-only">Removed: </span>}
						{row.text === '' ? ' ' : row.text}
					</span>
				</div>
			))}
		</div>
	)
}

export function ComposerApproval({
	permission,
	palNames,
	palRunning,
	count,
	folder,
	projectName,
	conversationAllowance,
	onRespond,
}: {
	permission: PermissionView
	palNames?: ReadonlyMap<string, string> | undefined
	/** Names of Pals that are reading their inbox right now. */
	palRunning?: ReadonlySet<string> | undefined
	count: number
	/** The folder the conversation works in, named on a command so the person knows where it runs. */
	folder?: string | undefined
	/** The project's name, which a command's approval gives as the place it runs. */
	projectName?: string | undefined
	/**
	 * Whether the engine behind this conversation keeps an "allow for this conversation" answer.
	 * The card still withholds it on a request with a call that deletes, overwrites or reaches
	 * beyond the project.
	 */
	conversationAllowance?: boolean | undefined
	onRespond: (permission: PermissionView, response: PermissionResponse) => unknown
}) {
	const model = useMemo(() => buildApprovalCard(permission, palNames), [permission, palNames])
	// Every row wraps until the person turns it off, so a long line is never cut where its end
	// would go unseen.
	const [wrap, setWrap] = useState(true)
	const [expanded, setExpanded] = useState(false)
	const [editing, setEditing] = useState(false)
	const [note, setNote] = useState('')
	const moreButton = useRef<HTMLButtonElement>(null)
	const choseEdit = useRef(false)
	// A delete, or a command that looks like it deletes, never has Enter on yes: a stray Enter must not run it.
	const risky = rejectsFirst(model, permission)
	const canAllowConversation =
		conversationAllowance === true && offersConversationAllowance(permission)
	const scopeId = useId()
	// A click that lands just after the card replaced another was aimed at the old one. The guard
	// restarts for every request, and Accept says it is unavailable (to a screen reader as well) until it ends.
	const [guarding, setGuarding] = useState(true)
	const guard = useRef<ReturnType<typeof createClickGuard>>(undefined)
	// biome-ignore lint/correctness/useExhaustiveDependencies: the guard restarts for each request, so the id is the trigger
	useLayoutEffect(() => {
		setGuarding(true)
		const started = createClickGuard(() => setGuarding(false))
		guard.current = started
		return () => {
			started.dispose()
			if (guard.current === started) guard.current = undefined
		}
	}, [permission.id])
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
	// Saying yes waits for the guard; saying no never does.
	const allow = (response: PermissionResponse) => {
		if (guard.current?.active() ?? true) return
		respond(response)
	}
	const accept = () => allow({ outcome: 'approve' })
	const acceptForConversation = () => allow({ outcome: 'approve_all' })
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
		if (!typing) (risky ? rejectButton : acceptButton).current?.focus()
	}, [risky])
	useEffect(() => {
		if (editing) noteField.current?.focus()
		// Back to where the person was, not to the composer.
		else if (returning.current) {
			returning.current = false
			moreButton.current?.focus()
		}
	}, [editing])

	const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
		// A menu draws in a portal but its events still bubble here; its own keys are its own.
		if (!event.currentTarget.contains(event.target as Node)) return
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
		} else if (event.key === 'Escape') {
			// Esc answers this card with a No and leaves the reply running; the window's own Esc, which stops the reply, never sees it.
			event.preventDefault()
			event.stopPropagation()
			reject()
		}
	}

	const flags = approvalFlags(model, permission, folder)
	const foot = approvalConsequence(model, folder, projectName)
	const footTitle = approvalConsequenceTitle(model, folder)
	const hasDiff = Boolean(model.diff) && !model.unchanged
	const screenMoment = model.screenMoment
	const showDetails =
		(!screenMoment && !(model.diff && !model.diff.fragment)) || permission.calls.length > 1
	const diff = model.diff
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
	// What the box shows before the person opens it all.
	const preview = useMemo<ApprovalPreview | undefined>(() => {
		if (diff && !model.unchanged)
			return verdict.rich ? diffPreview(diff.before, diff.after) : textPreview(patch)
		if (model.command !== undefined) return textPreview(model.command)
		if (model.message !== undefined) return textPreview(model.message)
		return undefined
	}, [diff, model.unchanged, model.command, model.message, verdict, patch])
	const cutCommand =
		model.command !== undefined && commandChip(model.command) !== model.command.trim()
	const hiddenLines = preview ? preview.total - preview.rows.length : 0
	// With wrapping turned off a long row is cut at the box's edge: that is hidden text too.
	const clippedRow =
		!wrap && !expanded && (preview?.rows.some((row) => row.text.length > CLIPPED_ROW) ?? false)
	const canExpand = hiddenLines > 0 || (cutCommand && !expanded) || clippedRow
	const showAllLabel =
		preview && hiddenLines > 0
			? `Show all ${preview.total} lines`
			: clippedRow && !cutCommand
				? 'Show the whole line'
				: 'Show the whole command'
	const boxLabel = hasDiff
		? `Proposed change to ${model.fileName}`
		: model.command !== undefined
			? 'Command'
			: 'Message'
	const copyText = () => {
		const text =
			diff && hasDiff
				? unifiedDiff(diff.path, diff.before, diff.after)
				: (model.command ?? model.message ?? '')
		copyPlainText(text).catch(() => undefined)
	}
	const hasBox = preview !== undefined
	// The path of a file, or a command of one line, has a row of its own under the band. A command that
	// does not fit the row keeps its framed block too, so the whole of it is still on the card.
	const [rowCut, setRowCut] = useState(false)
	const commandRow = model.command !== undefined && !/\r?\n/.test(model.command.trim())
	const pathText = commandRow
		? model.command?.trim()
		: model.fileName && model.path
			? displayPath(model.path, folder, PATH_ROW_MAX)
			: undefined
	const showBlock = hasBox && (!commandRow || rowCut || expanded)

	const moreMenu = (
		<Menu.Root
			onOpenChange={(open) => {
				if (open) choseEdit.current = false
			}}
		>
			<Menu.Trigger
				ref={moreButton}
				className="approval-more-button"
				aria-label="More about this request"
				title="More"
			>
				<MoreHorizontalIcon aria-hidden="true" />
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner className="conversation-actions-positioner" sideOffset={4} align="end">
					<Menu.Popup
						className="conversation-actions-popup approval-menu"
						aria-label="More about this request"
						finalFocus={() => !choseEdit.current}
					>
						{!screenMoment && (
							<Menu.Item
								className="conversation-actions-item"
								onClick={() => {
									choseEdit.current = true
									setEditing(true)
								}}
							>
								<PencilIcon aria-hidden="true" />
								<span className="conversation-actions-label">Tell Namzu what to do instead</span>
							</Menu.Item>
						)}
						{hasBox && (
							<>
								<Menu.CheckboxItem
									className="conversation-actions-item"
									checked={wrap}
									onCheckedChange={setWrap}
									closeOnClick={false}
								>
									<TextWrapIcon aria-hidden="true" />
									<span className="conversation-actions-label">Wrap lines</span>
									<Menu.CheckboxItemIndicator className="approval-menu-check">
										On
									</Menu.CheckboxItemIndicator>
								</Menu.CheckboxItem>
								<Menu.Item className="conversation-actions-item" onClick={copyText}>
									<CopyIcon aria-hidden="true" />
									<span className="conversation-actions-label">Copy</span>
								</Menu.Item>
							</>
						)}
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	)
	const acceptTip = screenMoment
		? 'Allow this app · Ctrl+Enter. Enter says not now.'
		: risky
			? 'Accept · Ctrl+Enter. This one looks risky, so Enter rejects it.'
			: 'Accept · Enter'
	const rejectTip = screenMoment
		? 'Not now · Enter or Esc'
		: risky
			? 'Reject · Enter or Esc'
			: 'Reject · Esc'
	return (
		// One card: its own ring and fill, directly above the box, with nothing drawn behind both.
		<section
			className="approval-surface"
			aria-label={screenMoment ? 'Screen question' : 'Tool approval'}
			onKeyDown={onKeyDown}
		>
			<div className="approval-card" data-kind={model.kind}>
				<header className="approval-head">
					<ShieldAlertIcon aria-hidden="true" className="approval-head-icon" />
					<h3 className="approval-title" title={model.path}>
						{model.title}
					</h3>
					<span className="approval-spacer" />
					{hasDiff && (model.added || model.removed) ? (
						<span className="approval-counts">
							{model.added ? (
								<span
									className="changes-added"
									title={`${model.added} ${lineWord(model.added)} added`}
									role="img"
									aria-label={`${model.added} ${lineWord(model.added)} added`}
								>
									+{formatLineCount(model.added)}
								</span>
							) : null}
							{model.removed ? (
								<span
									className="changes-removed"
									title={`${model.removed} ${lineWord(model.removed)} removed`}
									role="img"
									aria-label={`${model.removed} ${lineWord(model.removed)} removed`}
								>
									−{formatLineCount(model.removed)}
								</span>
							) : null}
							{model.cut ? (
								<span className="approval-cut-note">Only part of the file is shown</span>
							) : null}
						</span>
					) : null}
					{count > 1 && <span className="approval-count">1 of {count}</span>}
					<span className="approval-head-more">{moreMenu}</span>
				</header>
				{pathText !== undefined && (
					<div className="approval-path" data-kind={commandRow ? 'command' : 'file'}>
						<CutRow
							text={pathText}
							title={commandRow ? model.command : model.path}
							onCut={setRowCut}
						/>
					</div>
				)}
				{flags.map((flag) => (
					<p key={flag} className="approval-flag">
						<TriangleAlertIcon aria-hidden="true" />
						<span>{flag}</span>
					</p>
				))}
				{(model.previewMissing || model.unchanged) && (
					<p className="approval-note">{previewNote(model)}</p>
				)}
				{preview && showBlock && (
					<div
						className="approval-box"
						data-prose={model.message !== undefined || undefined}
						data-open={expanded || undefined}
					>
						{expanded && diff && hasDiff ? (
							<FullDiff
								diff={diff}
								wrap={wrap}
								label={boxLabel}
								rich={verdict.rich}
								patch={patch}
							/>
						) : expanded ? (
							<div
								className="approval-full"
								// biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable region
								tabIndex={0}
								// biome-ignore lint/a11y/useSemanticElements: a section would read as a page landmark
								role="region"
								aria-label={boxLabel}
							>
								<PreviewRows
									preview={{
										rows: (model.command ?? model.message ?? '')
											.split(/\r?\n/)
											.map((text, index) => ({
												kind: 'context' as const,
												line: index + 1,
												text,
											})),
										total: preview.total,
									}}
									wrap={true}
									command={model.command !== undefined}
									numbered={false}
								/>
							</div>
						) : (
							// biome-ignore lint/a11y/useSemanticElements: a fieldset would draw its own frame and legend
							<div role="group" aria-label={boxLabel} className="approval-preview">
								<PreviewRows
									preview={preview}
									wrap={wrap}
									command={model.command !== undefined}
									numbered={hasDiff}
								/>
							</div>
						)}
						{(canExpand || expanded) && (
							<button
								type="button"
								className="approval-showall"
								aria-expanded={expanded}
								onClick={() => setExpanded((value) => !value)}
							>
								{expanded ? 'Show less' : showAllLabel}
							</button>
						)}
					</div>
				)}
				{model.message !== undefined && (
					<p className="approval-note">
						{palMessageNote(
							model.palName,
							model.palName ? (palRunning?.has(model.palName) ?? false) : false,
						)}
					</p>
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
				{screenMoment && (
					<p className="approval-note approval-consequence">{screenMomentNote(screenMoment.app)}</p>
				)}
				{model.others.length > 0 && (
					<p className="approval-note">
						Also in this request: {model.others.join(', ')}. Your answer covers all of them.
					</p>
				)}
				{showDetails && (
					<details className="approval-details">
						<summary>Details</summary>
						{approvalDetails(permission.calls, palNames).map((group, index) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: the groups follow the request's calls and never reorder
							<div key={index} className="approval-detail-group">
								{group.title && <p className="approval-detail-title">{group.title}</p>}
								<dl className="approval-entries">
									{group.entries.map((entry) => (
										<div key={entry.label} className="approval-entry">
											<dt>{entry.label}</dt>
											<dd>{entry.value}</dd>
										</div>
									))}
								</dl>
							</div>
						))}
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
							{foot && (
								<p className="approval-fact approval-consequence" title={footTitle}>
									{foot}
								</p>
							)}
							<div className="approval-actions">
								<button
									ref={rejectButton}
									type="button"
									className="approval-button"
									data-tone="reject"
									title={rejectTip}
									aria-keyshortcuts="Escape"
									onClick={reject}
								>
									{screenMoment ? 'Not now' : 'Reject'}
									<span className="approval-key" aria-hidden="true">
										Esc
									</span>
								</button>
								{canAllowConversation && (
									<div className="approval-split" data-tone="lasting">
										<button
											type="button"
											className="approval-button approval-split-label"
											aria-disabled={guarding || undefined}
											aria-describedby={scopeId}
											title={CONVERSATION_ALLOWANCE_SCOPE}
											onClick={acceptForConversation}
										>
											Allow for this conversation
										</button>
										<span className="approval-split-divider" aria-hidden="true" />
										<Menu.Root>
											<Menu.Trigger
												className="approval-button approval-split-more"
												aria-label="More ways to allow"
												title="More ways to allow"
											>
												<ChevronDownIcon aria-hidden="true" />
											</Menu.Trigger>
											<Menu.Portal>
												<Menu.Positioner
													className="conversation-actions-positioner"
													sideOffset={4}
													align="end"
												>
													<Menu.Popup
														className="conversation-actions-popup approval-menu"
														aria-label="More ways to allow"
													>
														<Menu.Item
															className="conversation-actions-item"
															onClick={acceptForConversation}
														>
															<span className="conversation-actions-label">
																Allow for this conversation
															</span>
														</Menu.Item>
														<p className="approval-menu-scope">{CONVERSATION_ALLOWANCE_SCOPE}</p>
													</Menu.Popup>
												</Menu.Positioner>
											</Menu.Portal>
										</Menu.Root>
										<span id={scopeId} className="sr-only">
											{CONVERSATION_ALLOWANCE_SCOPE}
										</span>
									</div>
								)}
								<button
									ref={acceptButton}
									type="button"
									className="approval-button"
									data-tone="accept"
									data-held={guarding || undefined}
									aria-disabled={guarding || undefined}
									title={acceptTip}
									aria-keyshortcuts="Control+Enter"
									onClick={accept}
								>
									{screenMoment ? 'Allow this app' : 'Accept'}
									<span className="approval-key" aria-hidden="true">
										{acceptKey()}
									</span>
								</button>
							</div>
						</>
					)}
				</footer>
			</div>
		</section>
	)
}
