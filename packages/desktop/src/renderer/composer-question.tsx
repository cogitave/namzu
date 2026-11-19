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
import type { PermissionView } from '../shared/protocol.js'
import { QUESTION_TEXT_MAX, type QuestionResponse } from '../shared/question-protocol.js'
import { createClickGuard } from './approval-gate.js'
import { ArrowLeftIcon, ArrowRightIcon, CheckIcon, QuestionCircleIcon } from './icons.js'
import {
	answeredCount,
	buildQuestionResponse,
	confirms,
	emptyQuestionDraft,
	isAnswered,
	otherOf,
	pickOption,
	questionLabel,
	rowForDigit,
	toggleOther,
	writeOther,
} from './question-card-model.js'
import './composer-approval.css'
import './composer-question.css'

/** The key that sends the answers from anywhere in the card, as the platform writes it. */
const submitKey = () =>
	typeof navigator !== 'undefined' && /Mac/.test(navigator.platform) ? '⌘↵' : 'Ctrl+Enter'

type Focus = 'row' | 'other' | 'submit' | null

/**
 * A question the agent put to the person, drawn where an approval is: directly above the message
 * box, one question at a time. Choices are rows (a number to press, the option and a line under
 * it), the recommended one is named, and "Other" opens a box for the person's own words. The keys
 * work from anywhere in the card: arrows move between rows, a number picks a row, Enter on a row
 * picks it, Enter in the box for words goes on, Ctrl+Enter sends every answer, and Esc skips.
 */
export function ComposerQuestion({
	permission,
	count,
	onAnswer,
}: {
	permission: PermissionView
	/** How many requests wait, this one included. */
	count: number
	onAnswer: (permission: PermissionView, response: QuestionResponse) => unknown
}) {
	const items = useMemo(() => permission.question?.questions ?? [], [permission])
	const [draft, setDraft] = useState(emptyQuestionDraft)
	const [step, setStep] = useState(0)
	const [focusRow, setFocusRow] = useState(0)
	const [focus, setFocus] = useState<Focus>(null)
	const item = items[step]
	const last = step === items.length - 1
	const labelId = useId()
	const rows = useRef<(HTMLButtonElement | null)[]>([])
	const words = useRef<HTMLTextAreaElement>(null)
	const submit = useRef<HTMLButtonElement>(null)
	const answered = useRef(false)
	// A click that lands just after the card replaced another was aimed at the old one.
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

	const respond = useCallback(
		(response: QuestionResponse) => {
			// One answer per request: a double press must not send a second.
			if (answered.current) return
			answered.current = true
			// An answer that did not get through leaves the question open, so the card takes another.
			const release = (delivered: unknown) => {
				if (delivered === false) answered.current = false
			}
			try {
				const result = onAnswer(permission, response)
				if (result instanceof Promise) result.then(release, () => release(false))
				else release(result)
			} catch {
				release(false)
			}
		},
		[onAnswer, permission],
	)
	const send = () => {
		if (guard.current?.active() ?? true) return
		const response = buildQuestionResponse(draft, items)
		if (response.kind === 'answer') respond(response)
	}
	const skip = () => respond({ kind: 'skip' })

	// A new card takes the keyboard, unless the person is in the middle of a message.
	useEffect(() => {
		const active = document.activeElement
		const typing =
			(active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) &&
			active.value.trim().length > 0
		if (!typing) rows.current[0]?.focus()
	}, [])
	// biome-ignore lint/correctness/useExhaustiveDependencies: the target is set by a press and read once
	useEffect(() => {
		if (focus === 'row') rows.current[focusRow]?.focus()
		else if (focus === 'other') words.current?.focus()
		else if (focus === 'submit') submit.current?.focus()
		if (focus) setFocus(null)
	}, [focus])

	if (!item) return null
	const withOther = item.allowFreeText
	const rowCount = item.options.length + (withOther ? 1 : 0)
	const other = otherOf(draft, item)
	const held = draft.picked[item.id] ?? []
	const focusedOption = item.options[focusRow]
	const preview = focusedOption?.preview

	const goTo = (next: number) => {
		const bounded = Math.max(0, Math.min(items.length - 1, next))
		if (bounded === step) return
		setStep(bounded)
		setFocusRow(0)
		setFocus('row')
	}
	const choose = (row: number) => {
		const option = item.options[row]
		if (option) {
			setDraft((current) => pickOption(current, item, option.id))
			setFocusRow(row)
			// A single choice is its own answer: go on to the next question, or to Send.
			if (!item.multiSelect) {
				if (last) setFocus('submit')
				else goTo(step + 1)
			}
		} else if (withOther) {
			const opening = !other.open
			setDraft((current) => toggleOther(current, item))
			setFocusRow(row)
			setFocus(opening ? 'other' : 'row')
		}
	}
	const moveRow = (to: number) => {
		const bounded = Math.max(0, Math.min(rowCount - 1, to))
		setFocusRow(bounded)
		rows.current[bounded]?.focus()
	}

	const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
		if (!event.currentTarget.contains(event.target as Node)) return
		if (event.nativeEvent.isComposing) return
		const target = event.target as HTMLElement
		const inWords = target === words.current
		if (event.key === 'Escape') {
			// Esc skips this card and leaves the reply running; the window's own Esc, which stops
			// the reply, never sees it.
			event.preventDefault()
			event.stopPropagation()
			skip()
			return
		}
		if (confirms(event) && (event.ctrlKey || event.metaKey)) {
			event.preventDefault()
			send()
			return
		}
		if (inWords) {
			if (confirms(event) && !event.shiftKey) {
				event.preventDefault()
				// Words with nothing in them are not an answer.
				if (!isAnswered(draft, item)) return
				if (last) setFocus('submit')
				else goTo(step + 1)
			}
			return
		}
		if (target instanceof HTMLButtonElement && target.dataset.action) return
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault()
			moveRow(focusRow + (event.key === 'ArrowDown' ? 1 : -1))
		} else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
			event.preventDefault()
			goTo(step + (event.key === 'ArrowRight' ? 1 : -1))
		} else if (!event.altKey && !event.ctrlKey && !event.metaKey) {
			const row = rowForDigit(event.key, rowCount)
			if (row !== undefined) {
				event.preventDefault()
				choose(row)
			}
		}
	}

	const total = items.length
	const ready = answeredCount(draft, items) > 0
	const title = questionLabel(item, step, total)
	return (
		<section
			className="approval-surface question-surface"
			aria-label="A question from Namzu"
			onKeyDown={onKeyDown}
		>
			<div className="approval-card question-card" data-kind="question">
				<header className="approval-head">
					<QuestionCircleIcon
						aria-hidden="true"
						className="approval-head-icon question-head-icon"
					/>
					<h3 className="approval-title" title={title}>
						{title}
					</h3>
					<span className="approval-spacer" />
					{count > 1 && <span className="approval-count">1 of {count} waiting</span>}
					{total > 1 && (
						<nav className="question-pager" aria-label="Questions in this card">
							<button
								type="button"
								className="question-step"
								aria-label="Previous question"
								title="Previous question · Left arrow"
								disabled={step === 0}
								onClick={() => goTo(step - 1)}
							>
								<ArrowLeftIcon aria-hidden="true" />
							</button>
							<span className="question-step-count" aria-live="polite">
								{step + 1} of {total}
							</span>
							<button
								type="button"
								className="question-step"
								aria-label="Next question"
								title="Next question · Right arrow"
								disabled={last}
								onClick={() => goTo(step + 1)}
							>
								<ArrowRightIcon aria-hidden="true" />
							</button>
						</nav>
					)}
				</header>
				<p className="question-text" id={labelId}>
					{item.question}
				</p>
				<div
					role={item.multiSelect ? 'group' : 'radiogroup'}
					aria-labelledby={labelId}
					className="question-options"
				>
					{item.options.map((option, index) => {
						const selected = held.includes(option.id)
						return (
							<button
								key={option.id}
								ref={(node) => {
									rows.current[index] = node
								}}
								type="button"
								role={item.multiSelect ? 'checkbox' : 'radio'}
								aria-checked={selected}
								className="question-row"
								data-selected={selected || undefined}
								data-recommended={option.recommended || undefined}
								tabIndex={focusRow === index ? 0 : -1}
								aria-keyshortcuts={index < 9 ? String(index + 1) : undefined}
								onFocus={() => setFocusRow(index)}
								onClick={() => choose(index)}
							>
								<span
									className="question-mark"
									data-multi={item.multiSelect || undefined}
									aria-hidden="true"
								>
									{item.multiSelect ? selected && <CheckIcon /> : index + 1}
								</span>
								<span className="question-row-text">
									<span className="question-row-label">
										{option.label}
										{option.recommended && <span className="question-badge">Recommended</span>}
									</span>
									{option.description && (
										<span className="question-row-description">{option.description}</span>
									)}
								</span>
								{selected && !item.multiSelect && (
									<CheckIcon aria-hidden="true" className="question-check" />
								)}
							</button>
						)
					})}
					{withOther && (
						<button
							ref={(node) => {
								rows.current[item.options.length] = node
							}}
							type="button"
							role={item.multiSelect ? 'checkbox' : 'radio'}
							aria-checked={other.open}
							className="question-row"
							data-selected={other.open || undefined}
							tabIndex={focusRow === item.options.length ? 0 : -1}
							aria-keyshortcuts={
								item.options.length < 9 ? String(item.options.length + 1) : undefined
							}
							onFocus={() => setFocusRow(item.options.length)}
							onClick={() => choose(item.options.length)}
						>
							<span
								className="question-mark"
								data-multi={item.multiSelect || undefined}
								aria-hidden="true"
							>
								{item.multiSelect ? other.open && <CheckIcon /> : item.options.length + 1}
							</span>
							<span className="question-row-text">
								<span className="question-row-label">Other</span>
								<span className="question-row-description">Say it in your own words</span>
							</span>
							{other.open && !item.multiSelect && (
								<CheckIcon aria-hidden="true" className="question-check" />
							)}
						</button>
					)}
				</div>
				{withOther && other.open && (
					<textarea
						ref={words}
						className="question-other"
						rows={2}
						value={other.text}
						maxLength={QUESTION_TEXT_MAX}
						placeholder="Write your answer"
						aria-label="Your own answer"
						onChange={(event) =>
							setDraft((current) => writeOther(current, item, event.target.value))
						}
					/>
				)}
				{preview && (
					<pre className="question-preview" aria-label="Preview of the highlighted choice">
						{preview}
					</pre>
				)}
				<footer className="approval-footer">
					<div className="approval-actions">
						<button
							type="button"
							className="approval-button"
							data-action="skip"
							title="Skip · Esc. The agent carries on without an answer."
							aria-keyshortcuts="Escape"
							onClick={skip}
						>
							Skip
							<span className="approval-key" aria-hidden="true">
								Esc
							</span>
						</button>
						{last ? (
							<button
								ref={submit}
								type="button"
								className="approval-button"
								data-action="submit"
								data-tone="accept"
								data-held={guarding || undefined}
								aria-disabled={guarding || !ready || undefined}
								disabled={!ready}
								title={`Send your answers · ${submitKey()}`}
								aria-keyshortcuts="Control+Enter"
								onClick={send}
							>
								Send
								<span className="approval-key" aria-hidden="true">
									{submitKey()}
								</span>
							</button>
						) : (
							<button
								ref={submit}
								type="button"
								className="approval-button"
								data-action="next"
								data-tone="accept"
								title="Next question · Right arrow"
								onClick={() => goTo(step + 1)}
							>
								Next
							</button>
						)}
					</div>
				</footer>
			</div>
		</section>
	)
}
