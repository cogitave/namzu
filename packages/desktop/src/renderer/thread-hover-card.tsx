import { useEffect, useState } from 'react'
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

export function ThreadHoverCardView({ model }: { model: HoverCardModel }) {
	const EnvironmentIcon = model.environment.kind === 'pal-computer' ? UserRoundIcon : MonitorIcon
	return (
		<div className="thread-hover-card" data-slot="thread-hover-card">
			<div className="thread-hover-card-head">
				<span className="thread-hover-card-title">{model.title}</span>
				<EnvironmentIcon
					className="thread-hover-card-icon"
					role="img"
					aria-label={model.environment.label}
				/>
				{model.age && <span className="thread-hover-card-age">{model.age}</span>}
			</div>
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
}: {
	conversation: ConversationView
	project: ProjectView
	loadGit?: GitLoader
}) {
	const git = useProjectGit(project, loadGit)
	return (
		<ThreadHoverCardView model={hoverCardModel({ conversation, project, git, now: Date.now() })} />
	)
}
