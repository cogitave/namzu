import { Menu } from '@base-ui/react/menu'
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react'
import {
	type BackgroundWorkStatus,
	freshBackgroundWorkStatus,
} from '../shared/background-work-protocol.js'
import type { ThreadState } from '../shared/projection.js'
import type { ConversationView, ProjectView } from '../shared/protocol.js'
import { ADD_PROJECT_LABEL, AddProjectItems, AddProjectMenu } from './add-project-menu.js'
import { BrandDither } from './brand-dither.js'
import { compareConversationOrder } from './conversation-order.js'
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
import { ThreadCard, type ThreadRowActions } from './thread-card.js'
import { Button } from './ui/button.js'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from './ui/collapsible.js'
import { Tooltip, TooltipPopup, TooltipTrigger } from './ui/tooltip.js'
import { Wordmark } from './wordmark.js'
import './sidebar-navigation.css'

export type Appearance = 'system' | 'light' | 'dark'
export type ConversationCollection = 'projects' | 'recents'
function hasVisibleBackgroundWork(
	view: ConversationView,
	status: BackgroundWorkStatus | undefined,
): boolean {
	if (view.palId || (view.harness && view.harness !== 'namzu')) return false
	const fresh = freshBackgroundWorkStatus(status)
	return fresh.state === 'known' && (fresh.runningCount > 0 || fresh.needsAttention)
}
export function Sidebar({
	projects,
	conversations,
	projectId,
	sessionId,
	conversationCollection,
	threads,
	backgroundWork,
	open,
	opening,
	onClose,
	onSearch,
	collapsed,
	onOpenProject,
	onCreateProject,
	onNewConversation,
	onProject,
	onConversation,
	rowActions,
	pals,
}: {
	activeProject?: ProjectView
	projects: ProjectView[]
	conversations: ConversationView[]
	projectId: string
	sessionId: string
	conversationCollection: ConversationCollection
	threads: Record<string, ThreadState>
	backgroundWork?: Readonly<Record<string, BackgroundWorkStatus>>
	open: boolean
	opening: boolean
	onClose: () => void
	onSearch: () => void
	collapsed: boolean
	onOpenProject: () => void
	onCreateProject?: () => void
	onNewConversation: () => void
	onProject: (id: string) => void
	onConversation: (view: ConversationView, collection: ConversationCollection) => void
	rowActions?: ThreadRowActions
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
		.sort(compareConversationOrder)
		.filter(
			(item, index) =>
				index < 10 ||
				item.id === sessionId ||
				threads[item.id]?.running ||
				hasVisibleBackgroundWork(item, backgroundWork?.[item.id]),
		)
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
							<span className="sidebar-brand">
								<Wordmark />
								<span className="beta-badge">Beta</span>
							</span>
							<ChevronDownIcon className="size-3" aria-hidden="true" />
						</Menu.Trigger>
						<Menu.Portal>
							<Menu.Positioner className="z-[150] outline-none" align="start" sideOffset={4}>
								<Menu.Popup className="workspace-menu-popup window-titlebar-popup dropdown-glass min-w-52 rounded-lg p-1 text-sm text-popover-foreground shadow-xl outline-none">
									<AddProjectItems
										onCreate={onCreateProject}
										onOpen={onOpenProject}
										disabled={opening}
									/>
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
										backgroundWork={backgroundWork}
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
										rowActions={rowActions}
									/>
								</CollapsiblePanel>
							</Collapsible>
						))}
						{projects.length === 0 && (
							<AddProjectMenu
								disabled={opening}
								onCreate={onCreateProject}
								onOpen={onOpenProject}
								trigger={
									<button type="button" className="project-row">
										<FolderPlusIcon aria-hidden="true" />
										<span>{ADD_PROJECT_LABEL}</span>
									</button>
								}
							/>
						)}
					</nav>
					{recent.length > 0 && (
						<section className="sidebar-recents" aria-label="Recent conversations">
							<h2 className="sidebar-section-title">Recents</h2>
							<RecentList
								rows={recent}
								projects={projectById}
								threads={threads}
								backgroundWork={backgroundWork}
								sessionId={sessionId}
								active={conversationCollection === 'recents'}
								onConversation={(view) => onConversation(view, 'recents')}
								rowActions={rowActions}
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
	backgroundWork,
	sessionId,
	active,
	expanded,
	onExpandedChange,
	onConversation,
	rowActions,
}: {
	rows: ConversationView[]
	project: ProjectView
	threads: Record<string, ThreadState>
	backgroundWork?: Readonly<Record<string, BackgroundWorkStatus>>
	sessionId: string
	active: boolean
	expanded: boolean
	onExpandedChange: (expanded: boolean) => void
	onConversation: (view: ConversationView) => void
	rowActions?: ThreadRowActions
}) {
	const limitedRows = rows.filter(
		(item, index) =>
			index < 5 ||
			item.id === sessionId ||
			threads[item.id]?.running ||
			hasVisibleBackgroundWork(item, backgroundWork?.[item.id]),
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
					backgroundWork={backgroundWork?.[item.id]}
					active={active && item.id === sessionId}
					onClick={() => onConversation(item)}
					rowActions={rowActions}
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
	backgroundWork,
	sessionId,
	active,
	onConversation,
	rowActions,
}: {
	rows: ConversationView[]
	projects: ReadonlyMap<string, ProjectView>
	threads: Record<string, ThreadState>
	backgroundWork?: Readonly<Record<string, BackgroundWorkStatus>>
	sessionId: string
	active: boolean
	onConversation: (view: ConversationView) => void
	rowActions?: ThreadRowActions
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
						backgroundWork={backgroundWork?.[item.id]}
						active={active && item.id === sessionId}
						onClick={() => onConversation(item)}
						rowActions={rowActions}
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
