import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PermissionView } from '../shared/protocol.js'
import type { QuestionResponse, SkillSaveChoice } from '../shared/question-protocol.js'
import { createClickGuard } from './approval-gate.js'
import { FileTextIcon } from './icons.js'
import { SKILL_SAVE_LABELS, skillSaveResponse, skillSaveView } from './skill-save-card-model.js'
import './composer-approval.css'
import './composer-question.css'
import './composer-skill-save.css'

/**
 * A skill the agent drafted, drawn where an approval is: the whole file (in a box that scrolls), where each choice would write it, what it would replace, and three buttons. Nothing
 * is saved until the person picks a place; Cancel and Esc save nothing, and no setting answers it.
 */
export function ComposerSkillSave({
	permission,
	count,
	onAnswer,
}: {
	permission: PermissionView
	/** How many requests wait, this one included. */
	count: number
	onAnswer: (permission: PermissionView, response: QuestionResponse) => unknown
}) {
	const card = permission.skillSave
	const view = useMemo(() => (card ? skillSaveView(card) : undefined), [card])
	const answered = useRef(false)
	// A click that lands just after the card replaced another was aimed at the old one.
	const [guarding, setGuarding] = useState(true)
	const guard = useRef<ReturnType<typeof createClickGuard>>(undefined)
	const cancel = useRef<HTMLButtonElement>(null)
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
		(choice: SkillSaveChoice) => {
			// Saving needs a click that was meant; leaving never does.
			if (choice !== 'cancel' && (guard.current?.active() ?? true)) return
			if (answered.current) return
			answered.current = true
			const release = (delivered: unknown) => {
				if (delivered === false) answered.current = false
			}
			try {
				const result = onAnswer(permission, skillSaveResponse(choice))
				if (result instanceof Promise) result.then(release, () => release(false))
				else release(result)
			} catch {
				release(false)
			}
		},
		[onAnswer, permission],
	)
	useEffect(() => {
		const active = document.activeElement
		const typing =
			(active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) &&
			active.value.trim().length > 0
		// Cancel takes the focus, never a Save: a stray Enter or Space leaves, saving takes a click or Tab.
		if (!typing) cancel.current?.focus()
	}, [])

	if (!view) return null
	return (
		<section
			className="approval-surface question-surface"
			aria-label="A skill to save"
			onKeyDown={(event) => {
				if (event.key === 'Escape') {
					event.preventDefault()
					respond('cancel')
				}
			}}
		>
			<div className="approval-card skill-save-card" data-kind="skill-save">
				<header className="approval-head">
					<FileTextIcon aria-hidden="true" className="approval-head-icon question-head-icon" />
					<h3 className="approval-title" title={view.title}>
						{view.title}
					</h3>
					<span className="approval-spacer" />
					{count > 1 && <span className="approval-count">1 of {count} waiting</span>}
				</header>
				<p className="skill-save-description">{view.description}</p>
				<div className="approval-box skill-save-file" data-prose>
					<pre
						className="skill-save-text"
						aria-label={`The file for ${card?.name}`}
						// A long file scrolls in its box, so it must be reachable by keyboard.
						// biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll region takes focus to scroll
						tabIndex={0}
					>
						{view.preview}
					</pre>
				</div>
				{view.warnings.length > 0 && (
					<ul className="skill-save-warnings" aria-label="Warnings">
						{view.warnings.map((warning) => (
							<li key={warning}>{warning}</li>
						))}
					</ul>
				)}
				<ul className="skill-save-targets" aria-label="Where it would be saved">
					{view.targets.map((target) => (
						<li key={target.scope} data-suggested={target.suggested || undefined}>
							<span className="skill-save-target-label">
								{target.place}
								{target.suggested && <span className="question-badge">Suggested</span>}
							</span>
							<code className="skill-save-path">{target.path}</code>
							{target.notes.map((note) => (
								<span key={note} className="skill-save-note" data-tone="warn">
									{note}
								</span>
							))}
						</li>
					))}
				</ul>
				<footer className="approval-footer">
					<div className="approval-actions">
						<button
							type="button"
							className="approval-button"
							data-action="cancel"
							ref={cancel}
							title="Cancel · Esc. Nothing is saved."
							aria-keyshortcuts="Escape"
							onClick={() => respond('cancel')}
						>
							{SKILL_SAVE_LABELS.cancel}
							<span className="approval-key" aria-hidden="true">
								Esc
							</span>
						</button>
						{view.targets.map((target) => (
							<button
								key={target.scope}
								type="button"
								className="approval-button"
								data-action={`save-${target.scope}`}
								data-tone={target.suggested ? 'accept' : undefined}
								data-held={guarding || undefined}
								aria-disabled={guarding || undefined}
								onClick={() => respond(target.scope)}
							>
								{target.label}
							</button>
						))}
					</div>
				</footer>
			</div>
		</section>
	)
}
