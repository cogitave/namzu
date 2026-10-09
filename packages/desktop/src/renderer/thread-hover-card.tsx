import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ConversationView, ProjectGitView, ProjectView } from '../shared/protocol.js'
import { FolderIcon, GitBranchIcon, MonitorIcon, UserRoundIcon } from './icons.js'
import {
	type HoverCardModel,
	createGitCache,
	hoverCardModel,
	projectHasRepository,
} from './sidebar-hover-card.js'
import './thread-hover-card.css'

type GitLoader = (projectId: string) => Promise<ProjectGitView | null>

const caches = new WeakMap<GitLoader, ReturnType<typeof createGitCache>>()
function cacheFor(loader: GitLoader) {
	let cache = caches.get(loader)
	if (!cache) {
		cache = createGitCache(loader)
		caches.set(loader, cache)
	}
	return cache
}

/** The card's repository facts: cached, requested once per project, and never guessed. */
function useProjectGit(project: ProjectView, loader: GitLoader | undefined) {
	const cache = loader && projectHasRepository(project) ? cacheFor(loader) : undefined
	const [git, setGit] = useState<ProjectGitView | null | undefined>(() => cache?.peek(project.id))
	useEffect(() => {
		if (!cache) return
		let current = true
		void cache.get(project.id).then((value) => {
			if (current) setGit(value)
		})
		return () => {
			current = false
		}
	}, [cache, project.id])
	return git
}

export function ThreadHoverCardView({
	model,
	onCovers,
}: {
	model: HoverCardModel
	/** Called once the card is on screen if it covers the sidebar's Archived conversations row. */
	onCovers?: () => void
}) {
	const EnvironmentIcon = model.environment.kind === 'pal-computer' ? UserRoundIcon : MonitorIcon
	const card = useRef<HTMLDivElement>(null)
	useLayoutEffect(() => {
		const element = card.current
		const archived = document.querySelector('.sidebar-archived-link')
		if (!element || !archived || !onCovers) return
		const a = element.getBoundingClientRect()
		const b = archived.getBoundingClientRect()
		if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) onCovers()
	})
	return (
		<div ref={card} className="thread-hover-card" data-slot="thread-hover-card">
			<div className="thread-hover-card-head">
				<span className="thread-hover-card-engine">{model.engine}</span>
				<span className="thread-hover-card-environment">
					<EnvironmentIcon className="thread-hover-card-icon" aria-hidden="true" />
					{model.environment.label}
				</span>
				{model.age && <span className="thread-hover-card-age">{model.age}</span>}
			</div>
			{model.preview && <p className="thread-hover-card-preview">{model.preview}</p>}
			{model.folder && (
				<div className="thread-hover-card-row">
					<FolderIcon aria-hidden="true" />
					<span>{model.folder}</span>
				</div>
			)}
			{model.branch && (
				<div className="thread-hover-card-row">
					<GitBranchIcon aria-hidden="true" />
					<span>{model.branch}</span>
				</div>
			)}
		</div>
	)
}

export function ThreadHoverCard({
	conversation,
	project,
	loadGit,
	messages,
	onCovers,
}: {
	conversation: ConversationView
	project: ProjectView
	onCovers?: () => void
	loadGit?: GitLoader
	messages?: readonly { role: 'user' | 'assistant'; text: string }[]
}) {
	const git = useProjectGit(project, loadGit)
	return (
		<ThreadHoverCardView
			model={hoverCardModel({ conversation, project, git, messages, now: Date.now() })}
			onCovers={onCovers}
		/>
	)
}
