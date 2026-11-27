import { useEffect } from 'react'
import { CheckIcon } from './icons.js'
import { OPEN_SKILLS_EVENT, SKILLS_CHANGED_EVENT } from './skill-create.js'
import { SKILL_SAVED_NOTE } from './skill-save-card-model.js'
import './composer-skill-save.css'

/**
 * The line a saved skill leaves in the conversation: its name, where the file went, that it is
 * usable from the next message, and the way to its on/off switch. Showing it also tells any open
 * Skills list to read again, so the new skill is listed without a restart.
 */
export function SkillSavedCard({ name, path }: { name: string; path: string }) {
	useEffect(() => {
		window.dispatchEvent(new Event(SKILLS_CHANGED_EVENT))
	}, [])
	return (
		<section
			className="skill-saved-card"
			aria-label={`Saved skill ${name}`}
			data-kind="skill-saved"
		>
			<CheckIcon aria-hidden="true" className="skill-saved-icon" />
			<span className="skill-saved-text">
				<span className="skill-saved-title">Saved skill "{name}"</span>
				<span className="skill-saved-note">
					{SKILL_SAVED_NOTE} <code>{path}</code>
				</span>
			</span>
			<button
				type="button"
				className="skill-saved-link"
				onClick={() => window.dispatchEvent(new Event(OPEN_SKILLS_EVENT))}
			>
				Open in Customize
			</button>
		</section>
	)
}
