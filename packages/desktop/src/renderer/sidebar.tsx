import { Menu } from '@base-ui/react/menu'
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react'
import type { ThreadState } from '../shared/projection.js'
import type { ConversationView, ProjectView } from '../shared/protocol.js'
import { BrandDither } from './brand-dither.js'
import { compareConversationRecency } from './conversation-order.js'
import {
	ChevronDownIcon,
	FolderIcon,
	FolderOpenIcon,
	FolderPlusIcon,
	SearchIcon,
	SquarePenIcon,
	XIcon,
} from './icons.js'
import { createSidebarListMotion } from './sidebar-motion.js'
import { ThreadCard } from './thread-card.js'
import { Button } from './ui/button.js'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from './ui/collapsible.js'
import { Tooltip, TooltipPopup, TooltipTrigger } from './ui/tooltip.js'
import { Wordmark } from './wordmark.js'
import './sidebar-navigation.css'

export type Appearance = 'system' | 'light' | 'dark'
export type ConversationCollection = 'projects' | 'recents'
export function Sidebar({
	projects,
	conversations,
	projectId,
	sessionId,
	conversationCollection,
	threads,
	open,
	opening,
	onClose,
	onSearch,
	collapsed,
	onOpenProject,
	onNewConversation,
	onProject,
	onConversation,
	onRemoveConversation,
	pals,
}: {
	activeProject?: ProjectView
	projects: ProjectView[]
	conversations: ConversationView[]
	projectId: string
	sessionId: string
	conversationCollection: ConversationCollection
	threads: Record<string, ThreadState>
	open: boolean
	opening: boolean
	onClose: () => void
	onSearch: () => void
	collapsed: boolean
	onOpenProject: () => void
	onNewConversation: () => void
	onProject: (id: string) => void
	onConversation: (view: ConversationView, collection: ConversationCollection) => void
	onRemoveConversation?: (view: ConversationView, trigger: HTMLElement | null) => void
	pals?: ReactNode
}) {
	const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>({})
	const [expandedLists, setExpandedLists] = useState<Record<string, boolean>>({})
	const newConversationDisabled = opening
	const groups = projects
		.filter((project) => !project.isChat)
		.map((project) => ({
			project,
			rows: conversations.filter((item) => item.projectId === project.id),
		}))
	const projectById = new Map(projects.map((project) => [project.id, project]))
	const recent = [...new Map(conversations.map((item) => [item.id, item])).values()]
		.filter((item) => projectById.has(item.projectId))
		.sort(compareConversationRecency)
		.filter((item, index) => index < 10 || item.id === sessionId || threads[item.id]?.running)
	const activeProjectId = sessionId
		? (conversations.find((item) => item.id === sessionId)?.projectId ?? projectId)
		: projectId
	useLayoutEffect(() => {
		if (!activeProjectId || (sessionId && conversationCollection === 'recents')) return
		setCollapsedProjects((current) =>
			current[activeProjectId] !== false ? { ...current, [activeProjectId]: false } : current,
		)
	}, [activeProjectId, sessionId, conversationCollection])
	return (
		<>
			{open && (
				<button type="button" className="scrim" aria-label="Close sidebar" onClick={onClose} />
			)}
			<aside
				id="namzu-sidebar"
				className={`sidebar ${open ? 'open' : ''}`}
				data-app-sidebar
				inert={collapsed && !open}
				aria-hidden={collapsed && !open}
				aria-label="Projects and conversations"
			>
				<div className="sidebar-chrome relative flex h-(--workspace-topbar-height) shrink-0 items-center gap-2 px-3 md:px-0">
					<BrandDither />
					<Menu.Root>
						<Menu.Trigger
							render={
								<Button
									className="sidebar-workspace-menu relative z-10 ml-3 min-w-0"
									variant="ghost-muted"
									aria-label="Workspace menu"
								/>
							}
						>
							<Wordmark />
							<ChevronDownIcon className="size-3" aria-hidden="true" />
						</Menu.Trigger>
						<Menu.Portal>
							<Menu.Positioner className="z-[150] outline-none" align="start" sideOffset={4}>
								<Menu.Popup className="workspace-menu-popup window-titlebar-popup dropdown-glass min-w-52 rounded-lg p-1 text-sm text-popover-foreground shadow-xl outline-none">
									<Menu.Item
										className="window-titlebar-item"
										onClick={onOpenProject}
										disabled={opening}
									>
										<FolderPlusIcon className="size-4" aria-hidden="true" />
										<span>Open project…</span>
									</Menu.Item>
									<Menu.Item
										className="window-titlebar-item"
										onClick={onNewConversation}
										disabled={newConversationDisabled}
									>
										<SquarePenIcon className="size-4" aria-hidden="true" />
										<span>New conversation</span>
									</Menu.Item>
								</Menu.Popup>
							</Menu.Positioner>
						</Menu.Portal>
					</Menu.Root>
					<Tooltip>
						<TooltipTrigger
							render={
								<Button
									variant="ghost-muted"
									size="icon-sm"
									className="sidebar-search relative z-10 ml-auto"
									aria-label="Search conversations"
									aria-keyshortcuts="Control+k Meta+k"
									data-sidebar-search
									onClick={onSearch}
								/>
							}
						>
							<SearchIcon className="size-4" aria-hidden="true" />
						</TooltipTrigger>
						<TooltipPopup side="bottom">Search conversations</TooltipPopup>
					</Tooltip>
					<Button
						variant="ghost-muted"
						size="icon-xs"
						className="sidebar-close"
						aria-label="Close sidebar"
						onClick={onClose}
					>
						<XIcon />
					</Button>
				</div>
				<button
					type="button"
					className="sidebar-new-conversation"
					onClick={onNewConversation}
					disabled={newConversationDisabled}
				>
					<SquarePenIcon aria-hidden="true" />
					New conversation
				</button>
				<div className="sidebar-scroll">
					{pals}
					<h2 className="sidebar-section-title">Projects</h2>
					<nav
						className="conversations sidebar-project-navigation"
						aria-label="Projects and conversations"
					>
						{groups.map(({ project, rows }) => (
							<Collapsible
								key={project.id}
								className="sidebar-project-group"
								data-project-group={project.id}
								open={collapsedProjects[project.id] === false}
								onOpenChange={(expanded) =>
									setCollapsedProjects((current) => ({
										...current,
										[project.id]: !expanded,
									}))
								}
							>
								<div
									className="sidebar-project-heading"
									data-selected={(!sessionId && projectId === project.id) || undefined}
								>
									<CollapsibleTrigger
										aria-label={`${collapsedProjects[project.id] === false ? 'Collapse' : 'Expand'} ${project.name} conversations`}
										render={
											<Button
												variant="ghost-muted"
												size="icon-xs"
												className="sidebar-project-toggle"
											/>
										}
									>
										<span className="sidebar-project-folder" aria-hidden="true">
											<FolderIcon className="sidebar-project-folder-closed" />
											<FolderOpenIcon className="sidebar-project-folder-open" />
										</span>
									</CollapsibleTrigger>
									<button
										type="button"
										className="project-row"
										aria-label={`Open ${project.name}`}
										aria-current={!sessionId && projectId === project.id ? 'page' : undefined}
										onClick={() => {
											setCollapsedProjects((current) => ({
												...current,
												[project.id]: false,
											}))
											onProject(project.id)
										}}
									>
										<span className="sidebar-project-name">{project.name}</span>
									</button>
								</div>
								<CollapsiblePanel className="sidebar-project-panel">
									<ThreadList
										rows={rows}
										project={project}
										threads={threads}
										sessionId={sessionId}
										active={conversationCollection === 'projects'}
										expanded={Boolean(expandedLists[project.id])}
										onExpandedChange={(expanded) =>
											setExpandedLists((current) => ({
												...current,
												[project.id]: expanded,
											}))
										}
										onConversation={(view) => onConversation(view, 'projects')}
										onRemoveConversation={onRemoveConversation}
									/>
								</CollapsiblePanel>
							</Collapsible>
						))}
						{projects.length === 0 && (
							<button
								type="button"
								className="project-row"
								disabled={opening}
								onClick={onOpenProject}
							>
								<FolderPlusIcon aria-hidden="true" />
								<span>Open a project</span>
							</button>
						)}
					</nav>
					{recent.length > 0 && (
						<section className="sidebar-recents" aria-label="Recent conversations">
							<h2 className="sidebar-section-title">Recents</h2>
							<RecentList
								rows={recent}
								projects={projectById}
								threads={threads}
								sessionId={sessionId}
								active={conversationCollection === 'recents'}
								onConversation={(view) => onConversation(view, 'recents')}
								onRemoveConversation={onRemoveConversation}
							/>
						</section>
					)}
				</div>
			</aside>
		</>
	)
}

function ThreadList({
	rows,
	project,
	threads,
	sessionId,
	active,
	expanded,
	onExpandedChange,
	onConversation,
	onRemoveConversation,
}: {
	rows: ConversationView[]
	project: ProjectView
	threads: Record<string, ThreadState>
	sessionId: string
	active: boolean
	expanded: boolean
	onExpandedChange: (expanded: boolean) => void
	onConversation: (view: ConversationView) => void
	onRemoveConversation?: (view: ConversationView, trigger: HTMLElement | null) => void
}) {
	const limitedRows = rows.filter(
		(item, index) => index < 5 || item.id === sessionId || threads[item.id]?.running,
	)
	const shownRows = expanded ? rows : limitedRows
	const hasExtra = limitedRows.length < rows.length
	const list = useThreadListMotion()
	return (
		<ul
			ref={list}
			aria-label={`${project.name} conversations`}
			className="sidebar-project-list relative flex flex-col gap-px"
		>
			{shownRows.map((item) => (
				<ThreadCard
					key={item.id}
					conversation={item}
					project={project}
					thread={threads[item.id]}
					active={active && item.id === sessionId}
					onClick={() => onConversation(item)}
					onRemove={
						onRemoveConversation ? (trigger) => onRemoveConversation(item, trigger) : undefined
					}
				/>
			))}
			{hasExtra && (
				<li className="sidebar-list-disclosure">
					<button
						type="button"
						aria-label={`Show ${expanded ? 'less' : 'more'} ${project.name} conversations`}
						aria-expanded={expanded}
						onClick={() => onExpandedChange(!expanded)}
					>
						Show {expanded ? 'less' : 'more'}
					</button>
				</li>
			)}
		</ul>
	)
}

function RecentList({
	rows,
	projects,
	threads,
	sessionId,
	active,
	onConversation,
	onRemoveConversation,
}: {
	rows: ConversationView[]
	projects: ReadonlyMap<string, ProjectView>
	threads: Record<string, ThreadState>
	sessionId: string
	active: boolean
	onConversation: (view: ConversationView) => void
	onRemoveConversation?: (view: ConversationView, trigger: HTMLElement | null) => void
}) {
	const list = useThreadListMotion()
	return (
		<ul
			ref={list}
			className="sidebar-recent-list relative flex flex-col gap-px"
			aria-label="Recent conversations"
		>
			{rows.map((item) => {
				const project = projects.get(item.projectId)
				return project ? (
					<ThreadCard
						key={item.id}
						conversation={item}
						project={project}
						thread={threads[item.id]}
						active={active && item.id === sessionId}
						onClick={() => onConversation(item)}
						onRemove={
							onRemoveConversation ? (trigger) => onRemoveConversation(item, trigger) : undefined
						}
					/>
				) : null
			})}
		</ul>
	)
}

function useThreadListMotion() {
	const list = useRef<HTMLUListElement>(null)
	const motion = useRef<ReturnType<typeof createSidebarListMotion> | null>(null)
	useLayoutEffect(() => {
		if (!list.current) return
		const instance = createSidebarListMotion(list.current)
		motion.current = instance
		instance.update(false)
		return () => {
			instance.dispose()
			motion.current = null
		}
	}, [])
	useLayoutEffect(() => {
		motion.current?.update(true)
	})
	return list
}
