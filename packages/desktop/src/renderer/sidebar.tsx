import { Menu } from '@base-ui/react/menu'
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react'
import type { BackgroundWorkStatus } from '../shared/background-work-protocol.js'
import type { ThreadState } from '../shared/projection.js'
import type { ConversationView, ProjectView } from '../shared/protocol.js'
import type { SidebarSectionId } from '../shared/sidebar-sections.js'
import type { TerminalTabView } from '../shared/terminal-tabs.js'
import { ADD_PROJECT_LABEL, AddProjectMenu } from './add-project-menu.js'
import { BrandDither } from './brand-dither.js'
import { compareConversationOrder } from './conversation-order.js'
import {
	ArchiveIcon,
	ChevronDownIcon,
	FolderIcon,
	FolderOpenIcon,
	PlusIcon,
	SearchIcon,
	SquarePenIcon,
	XIcon,
} from './icons.js'
import { ProjectContextMenu, ProjectMoreMenu } from './project-row-actions.js'
import { createSidebarListMotion } from './sidebar-motion.js'
import { conversationsAttention, hasVisibleBackgroundWork } from './sidebar-section-attention.js'
import { SidebarSection } from './sidebar-section.js'
import { TerminalBadge, TerminalMark, terminalStatusText } from './terminal-pane.js'
import { ThreadCard, type ThreadRowActions } from './thread-card.js'
import { Button } from './ui/button.js'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from './ui/collapsible.js'
import { Tooltip, TooltipPopup, TooltipTrigger } from './ui/tooltip.js'
import { Wordmark } from './wordmark.js'
import './sidebar-navigation.css'

export type Appearance = 'system' | 'light' | 'dark'
export type ConversationCollection = 'projects' | 'recents'
/** The rows a project's list shows: the first five, the open one, and any that are busy; or all. */
function visibleProjectRows(
	rows: readonly ConversationView[],
	options: {
		expanded: boolean
		sessionId: string
		threads: Record<string, ThreadState>
		backgroundWork?: Readonly<Record<string, BackgroundWorkStatus>>
	},
): ConversationView[] {
	if (options.expanded) return [...rows]
	return rows.filter(
		(item, index) =>
			index < 5 ||
			item.id === options.sessionId ||
			options.threads[item.id]?.running ||
			hasVisibleBackgroundWork(item, options.backgroundWork?.[item.id]),
	)
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
	onRemoveProject,
	onLocateProject,
	onOpenProjectFolder,
	onOpenArchived,
	pals,
	terminals = [],
	activeTerminalId,
	onTerminal,
	onCloseTerminal,
	collapsedSections,
	onSectionCollapsedChange,
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
	/** Absent when the host cannot remove a project; the hover button and menu are then not offered. */
	onRemoveProject?: (project: ProjectView, trigger: HTMLElement | null) => void
	/** Absent when the host cannot relink a project; a missing folder then offers only Remove. */
	onLocateProject?: (project: ProjectView) => void
	/** Absent when the host cannot show a folder in the file manager. */
	onOpenProjectFolder?: (project: ProjectView) => void
	/** Absent when the host keeps no archive; the Archived entry is then not offered. */
	onOpenArchived?: () => void
	pals?: ReactNode
	/** Open terminal tabs; each is listed under its project with a terminal mark. */
	terminals?: readonly TerminalTabView[]
	activeTerminalId?: string
	onTerminal?: (tab: TerminalTabView) => void
	onCloseTerminal?: (tab: TerminalTabView) => void
	/** Sections the person folded away; absent keeps each section's state inside the sidebar. */
	collapsedSections?: ReadonlySet<SidebarSectionId>
	onSectionCollapsedChange?: (id: SidebarSectionId, collapsed: boolean) => void
}) {
	const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>({})
	const [expandedLists, setExpandedLists] = useState<Record<string, boolean>>({})
	const newConversationDisabled = opening
	const sectionProps = (id: SidebarSectionId) => ({
		collapsed: collapsedSections?.has(id),
		onCollapsedChange: onSectionCollapsedChange
			? (next: boolean) => onSectionCollapsedChange(id, next)
			: undefined,
	})
	const groups = projects
		.filter((project) => !project.isChat)
		.map((project) => ({
			project,
			rows: conversations.filter((item) => item.projectId === project.id),
		}))
	const projectById = new Map(projects.map((project) => [project.id, project]))
	const recentCandidates = [...new Map(conversations.map((item) => [item.id, item])).values()]
		.filter((item) => projectById.has(item.projectId) && !projectById.get(item.projectId)?.missing)
		.sort(compareConversationOrder)
		.filter(
			(item, index) =>
				index < 10 ||
				item.id === sessionId ||
				threads[item.id]?.running ||
				hasVisibleBackgroundWork(item, backgroundWork?.[item.id]),
		)
	// A conversation is listed once: Recents holds only the ones their project's list is not
	// showing (a collapsed project, or the part behind "Show more"), each with its project's name.
	const listedUnderProject = new Set(
		groups.flatMap(({ project, rows }) =>
			collapsedProjects[project.id] === false
				? visibleProjectRows(rows, {
						expanded: Boolean(expandedLists[project.id]),
						sessionId,
						threads,
						backgroundWork,
					}).map((item) => item.id)
				: [],
		),
	)
	const recent = recentCandidates.filter((item) => !listedUnderProject.has(item.id))
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
					<SidebarSection
						label="Projects"
						ariaLabel="Projects"
						headingClassName="sidebar-section-heading"
						{...sectionProps('projects')}
						attention={conversationsAttention(
							groups.flatMap(({ project, rows }) => (project.missing ? [] : rows)),
							threads,
							backgroundWork,
						)}
						actions={
							<AddProjectMenu
								disabled={opening}
								onCreate={onCreateProject}
								onOpen={onOpenProject}
								align="end"
								trigger={
									<Button
										variant="ghost-muted"
										size="icon-xs"
										className="sidebar-add-project"
										aria-label={ADD_PROJECT_LABEL}
										title={ADD_PROJECT_LABEL}
									>
										<PlusIcon aria-hidden="true" />
									</Button>
								}
							/>
						}
					>
						<nav
							className="conversations sidebar-project-navigation"
							aria-label="Projects and conversations"
						>
							{groups.map(({ project, rows }) =>
								project.missing ? (
									<MissingProjectRow
										key={project.id}
										project={project}
										onLocate={onLocateProject}
										onRemove={onRemoveProject}
									/>
								) : (
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
										<ProjectHeading
											project={project}
											selected={!sessionId && projectId === project.id}
											onRemoveProject={onRemoveProject}
											onOpenProjectFolder={onOpenProjectFolder}
											onOpenArchived={onOpenArchived}
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
										</ProjectHeading>
										<CollapsiblePanel className="sidebar-project-panel">
											<TerminalList
												tabs={terminals.filter((tab) => tab.projectId === project.id)}
												project={project}
												activeId={activeTerminalId}
												onOpen={onTerminal}
												onClose={onCloseTerminal}
											/>
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
								),
							)}
							{projects.length === 0 && (
								<p className="sidebar-empty-note">Use + to add a project.</p>
							)}
						</nav>
					</SidebarSection>
					{recent.length > 0 && (
						<SidebarSection
							label="Recents"
							ariaLabel="Recent conversations"
							className="sidebar-recents"
							{...sectionProps('recents')}
							attention={conversationsAttention(recent, threads, backgroundWork)}
						>
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
						</SidebarSection>
					)}
					{onOpenArchived && (
						<button type="button" className="sidebar-archived-link" onClick={onOpenArchived}>
							<ArchiveIcon aria-hidden="true" />
							Archived conversations
						</button>
					)}
				</div>
			</aside>
		</>
	)
}

/**
 * A project whose folder is gone. It stays in the list, dimmed, instead of vanishing: the person
 * can point Namzu at the folder's new place or take the project out.
 */
function MissingProjectRow({
	project,
	onLocate,
	onRemove,
}: {
	project: ProjectView
	onLocate?: (project: ProjectView) => void
	onRemove?: (project: ProjectView, trigger: HTMLElement | null) => void
}) {
	return (
		<div
			className="sidebar-project-group sidebar-project-missing"
			data-project-group={project.id}
			data-project-missing
		>
			<div className="sidebar-project-missing-name" title={project.path}>
				<FolderIcon aria-hidden="true" />
				<span className="sidebar-project-name">{project.name}</span>
			</div>
			<p className="sidebar-project-missing-note">Folder not found</p>
			<div className="sidebar-project-missing-actions">
				{onLocate && (
					<Button
						variant="outline"
						size="xs"
						aria-label={`Locate the folder for ${project.name}`}
						onClick={() => onLocate(project)}
					>
						Locate…
					</Button>
				)}
				{onRemove && (
					<Button
						variant="ghost-muted"
						size="xs"
						aria-label={`Remove ${project.name}`}
						onClick={(event) => onRemove(project, event.currentTarget)}
					>
						Remove
					</Button>
				)}
			</div>
		</div>
	)
}

/** The row: toggle and name from the caller, plus the "…" menu and the same menu on right-click. */
function ProjectHeading({
	project,
	selected,
	onRemoveProject,
	onOpenProjectFolder,
	onOpenArchived,
	children,
}: {
	project: ProjectView
	selected: boolean
	onRemoveProject?: (project: ProjectView, trigger: HTMLElement | null) => void
	onOpenProjectFolder?: (project: ProjectView) => void
	onOpenArchived?: () => void
	children: ReactNode
}) {
	const row = useRef<HTMLDivElement>(null)
	const [menuOpen, setMenuOpen] = useState(false)
	const removable = onRemoveProject !== undefined && !project.palId && !project.isChat
	const props = {
		className: 'sidebar-project-heading',
		'data-selected': selected || undefined,
		'data-removable': removable || undefined,
		'data-menu-open': menuOpen || undefined,
	}
	const trigger = () => row.current?.querySelector<HTMLElement>('.project-row') ?? null
	const actions =
		onRemoveProject && removable
			? {
					onRemove: () => onRemoveProject(project, trigger()),
					...(onOpenProjectFolder && project.path
						? { onOpenFolder: () => onOpenProjectFolder(project) }
						: {}),
					...(onOpenArchived ? { onArchived: onOpenArchived } : {}),
				}
			: undefined
	const body = (
		<>
			{children}
			{actions && (
				<ProjectMoreMenu
					label={`${project.name} actions`}
					triggerLabel={`Actions for ${project.name}`}
					restoreFocus={trigger}
					onOpenChange={setMenuOpen}
					actions={actions}
				/>
			)}
		</>
	)
	if (!actions)
		return (
			<div ref={row} {...props}>
				{body}
			</div>
		)
	return (
		<ProjectContextMenu
			label={`${project.name} actions`}
			render={<div ref={row} {...props} />}
			restoreFocus={trigger}
			onOpenChange={setMenuOpen}
			actions={actions}
		>
			{body}
		</ProjectContextMenu>
	)
}

/** The open terminals of a project, above its conversations. */
function TerminalList({
	tabs,
	project,
	activeId,
	onOpen,
	onClose,
}: {
	tabs: readonly TerminalTabView[]
	project: ProjectView
	activeId?: string
	onOpen?: (tab: TerminalTabView) => void
	onClose?: (tab: TerminalTabView) => void
}) {
	if (tabs.length === 0) return null
	return (
		<ul
			aria-label={`${project.name} terminals`}
			className="sidebar-project-list sidebar-terminal-list relative flex flex-col gap-px"
		>
			{tabs.map((tab) => (
				<li
					key={tab.id}
					className="sidebar-thread-item sidebar-terminal-item relative list-none"
					data-terminal-row={tab.id}
					data-removable={onClose ? true : undefined}
					data-ended={tab.status !== 'running' || undefined}
				>
					<button
						type="button"
						title={terminalStatusText(tab)}
						aria-label={`${tab.title}, terminal${tab.status === 'running' ? '' : ', ended'}`}
						aria-current={activeId === tab.id ? 'page' : undefined}
						onClick={() => onOpen?.(tab)}
						className={`group/sidebar-row sidebar-conversation-button relative w-full cursor-pointer overflow-hidden rounded-md text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring text-sidebar-foreground ${
							activeId === tab.id
								? 'bg-sidebar-row-active'
								: 'bg-transparent hover:bg-sidebar-row-hover'
						}`}
					>
						<div className="conversation-row">
							<span className="sidebar-terminal-mark" aria-hidden="true">
								<TerminalMark tab={tab} />
							</span>
							<span className="conversation-row-title">{tab.title}</span>
							<span className="conversation-row-state">
								<TerminalBadge tab={tab} />
							</span>
						</div>
					</button>
					{onClose && (
						<div className="sidebar-thread-actions">
							<Button
								variant="ghost-muted"
								size="icon-xs"
								className="sidebar-thread-action"
								aria-label={`Close terminal ${tab.title}`}
								onClick={() => onClose(tab)}
							>
								<XIcon aria-hidden="true" />
							</Button>
						</div>
					)}
				</li>
			))}
		</ul>
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
	const limitedRows = visibleProjectRows(rows, {
		expanded: false,
		sessionId,
		threads,
		backgroundWork,
	})
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
						projectLabel={project.name}
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
