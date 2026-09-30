import {
	FolderIcon,
	FolderPlusIcon,
	MonitorIcon,
	MoonIcon,
	SearchIcon,
	SquarePenIcon,
	SunIcon,
	XIcon,
} from 'lucide-react'
import { useState } from 'react'
import type { ThreadState } from '../shared/projection.js'
import type { ConversationView, ProjectView } from '../shared/protocol.js'
import { Button } from './ui/button.js'
import {
	SidebarFooter,
	SidebarGroup,
	SidebarHeader,
	SidebarInput,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
} from './ui/sidebar.js'
import { Tooltip, TooltipPopup, TooltipTrigger } from './ui/tooltip.js'
import { Wordmark } from './wordmark.js'
import { WorkspaceSection } from './workspace-section.js'

export type Appearance = 'system' | 'light' | 'dark'
export function Sidebar({
	projects,
	conversations,
	projectId,
	sessionId,
	threads,
	open,
	opening,
	appearance,
	onAppearance,
	onClose,
	onOpenProject,
	onNewConversation,
	onProject,
	onConversation,
}: {
	projects: ProjectView[]
	conversations: ConversationView[]
	projectId: string
	sessionId: string
	threads: Record<string, ThreadState>
	open: boolean
	opening: boolean
	appearance: Appearance
	onAppearance: () => void
	onClose: () => void
	onOpenProject: () => void
	onNewConversation: () => void
	onProject: (id: string) => void
	onConversation: (view: ConversationView) => void
}) {
	const [query, setQuery] = useState('')
	const [projectsOpen, setProjectsOpen] = useState(true)
	const active = projects.find((item) => item.id === projectId)
	const rows = conversations.filter((item) =>
		item.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
	)
	return (
		<>
			{open && (
				<button type="button" className="scrim" aria-label="Close sidebar" onClick={onClose} />
			)}
			<aside
				id="namzu-sidebar"
				className={`sidebar ${open ? 'open' : ''}`}
				data-app-sidebar
				aria-label="Projects and conversations"
			>
				<SidebarHeader>
					<div className="brand">
						<Wordmark />
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
					<div className="flex items-center gap-1">
						<div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm text-sidebar-muted-foreground hover:bg-sidebar-row-hover">
							<SearchIcon className="size-4 shrink-0" />
							<SidebarInput
								nativeInput
								type="search"
								placeholder="Search"
								aria-label="Search conversations"
								value={query}
								onChange={(event) => setQuery(event.currentTarget.value)}
							/>
						</div>
						<Tooltip>
							<TooltipTrigger
								render={
									<Button
										variant="ghost-muted"
										size="icon-sm"
										aria-label="New conversation"
										disabled={!active?.trusted || active.status !== 'ready'}
										onClick={onNewConversation}
									/>
								}
							>
								<SquarePenIcon />
							</TooltipTrigger>
							<TooltipPopup>New conversation</TooltipPopup>
						</Tooltip>
					</div>
				</SidebarHeader>
				<div className="sidebar-scroll">
					<SidebarGroup>
						<WorkspaceSection
							title="Projects"
							open={projectsOpen}
							action={
								<Tooltip>
									<TooltipTrigger
										render={
											<Button
												variant="ghost-muted"
												size="icon-xs"
												aria-label="Open a project"
												disabled={opening}
												onClick={onOpenProject}
											/>
										}
									>
										<FolderPlusIcon />
									</TooltipTrigger>
									<TooltipPopup>Open a project</TooltipPopup>
								</Tooltip>
							}
							onOpenChange={setProjectsOpen}
						>
							{projects.length === 0 && (
								<Button
									variant="ghost-muted"
									size="sm"
									className="open-project"
									disabled={opening}
									onClick={onOpenProject}
								>
									<FolderPlusIcon />
									Open a project
								</Button>
							)}
							{projects.map((project) => (
								<div key={project.id} className="project-group">
									<SidebarMenu>
										<SidebarMenuItem>
											<SidebarMenuButton
												isActive={project.id === projectId && !sessionId}
												aria-current={project.id === projectId && !sessionId ? 'page' : undefined}
												title={project.path}
												className="project-row"
												onClick={() => onProject(project.id)}
											>
												<FolderIcon />
												<span className="flex-1 truncate">{project.name}</span>
												<span
													className={`connection-dot ${project.status}`}
													aria-label={project.status}
												/>
											</SidebarMenuButton>
										</SidebarMenuItem>
									</SidebarMenu>
									{
										<nav className="conversations" aria-label={`${project.name} conversations`}>
											<SidebarMenu>
												{rows
													.filter((item) => item.projectId === project.id)
													.map((item) => (
														<SidebarMenuItem key={item.id}>
															<SidebarMenuButton
																isActive={item.id === sessionId}
																aria-current={item.id === sessionId ? 'page' : undefined}
																className="conversation-row"
																onClick={() => onConversation(item)}
															>
																<span className="flex-1 truncate">{item.title}</span>
																{threads[item.id]?.running && (
																	<span className="activity" aria-label="Working" />
																)}
															</SidebarMenuButton>
														</SidebarMenuItem>
													))}
											</SidebarMenu>
										</nav>
									}
								</div>
							))}
							{query && rows.length === 0 && (
								<p className="sidebar-empty">No conversations found.</p>
							)}
						</WorkspaceSection>
					</SidebarGroup>
				</div>
				<SidebarFooter>
					<div className="sidebar-footer-row">
						<span className="flex items-center gap-2">
							<MonitorIcon className="size-3.5" />
							Local workspace
						</span>
						<Tooltip>
							<TooltipTrigger
								render={
									<Button
										variant="ghost-muted"
										size="icon-xs"
										aria-label={`Appearance: ${appearance}. Change appearance`}
										onClick={onAppearance}
									/>
								}
							>
								{appearance === 'dark' ? (
									<MoonIcon />
								) : appearance === 'light' ? (
									<SunIcon />
								) : (
									<MonitorIcon />
								)}
							</TooltipTrigger>
							<TooltipPopup>Appearance · {appearance}</TooltipPopup>
						</Tooltip>
					</div>
				</SidebarFooter>
			</aside>
		</>
	)
}
