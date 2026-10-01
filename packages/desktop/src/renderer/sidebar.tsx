import {
	FolderIcon,
	FolderPlusIcon,
	MonitorIcon,
	MoonIcon,
	PanelLeftCloseIcon,
	PanelLeftIcon,
	SunIcon,
	XIcon,
} from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
import type { ThreadState } from '../shared/projection.js'
import type { ConversationView, ProjectView } from '../shared/protocol.js'
import { HeaderBackdrop } from './header-backdrop.js'
import { createSidebarListMotion } from './sidebar-motion.js'
import { SidebarHeaderIconButton, SidebarThreadHeader } from './sidebar-thread-header.js'
import { ThreadCard } from './thread-card.js'
import { Button } from './ui/button.js'
import {
	Combobox,
	ComboboxEmpty,
	ComboboxItem,
	ComboboxList,
	ComboboxPopup,
	ComboboxSearchInput,
	ComboboxTrigger,
} from './ui/combobox.js'
import { SidebarFooter, SidebarGroup } from './ui/sidebar.js'
import { Tooltip, TooltipPopup, TooltipTrigger } from './ui/tooltip.js'
import { Wordmark } from './wordmark.js'

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
	onToggle,
	collapsed,
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
	onToggle: () => void
	collapsed: boolean
	onOpenProject: () => void
	onNewConversation: () => void
	onProject: (id: string) => void
	onConversation: (view: ConversationView) => void
}) {
	const [query, setQuery] = useState('')
	const [scope, setScope] = useState('')
	const scopeAnchor = useRef<HTMLDivElement>(null)
	const scopeItems = [
		{ value: '', label: 'All projects' },
		...projects.map((project) => ({ value: project.id, label: project.name })),
	]
	const searchInput = useRef<HTMLInputElement>(null)
	const active = projects.find((item) => item.id === projectId)
	const rows = conversations.filter(
		(item) =>
			(!scope || item.projectId === scope) &&
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
				inert={collapsed && !open}
				aria-hidden={collapsed && !open}
				aria-label="Projects and conversations"
			>
				<div className="sidebar-chrome relative flex h-(--workspace-topbar-height) shrink-0 items-center gap-2 px-3 md:px-0">
					<HeaderBackdrop />
					<Tooltip>
						<TooltipTrigger
							render={
								<Button
									className="sidebar-toggle relative z-10 ml-3"
									variant="ghost-muted"
									size="icon-sm"
									aria-label="Collapse sidebar"
									onClick={onToggle}
								/>
							}
						>
							<PanelLeftIcon />
						</TooltipTrigger>
						<TooltipPopup>Collapse sidebar · Ctrl + B</TooltipPopup>
					</Tooltip>
					<div className="relative z-10 flex h-7 min-w-0 items-center overflow-hidden rounded-md">
						<Wordmark />
					</div>
					<Button
						variant="ghost-muted"
						size="icon-xs"
						className="sidebar-close ml-auto"
						aria-label="Close sidebar"
						onClick={onClose}
					>
						<XIcon />
					</Button>
				</div>
				<SidebarGroup className="relative z-[1]">
					<SidebarThreadHeader
						hasProjects={projects.length > 0}
						searchFieldRef={scopeAnchor}
						projectScope={
							<Combobox
								items={scopeItems}
								autoHighlight
								itemToStringLabel={(item) => item.label}
								isItemEqualToValue={(a, b) => a.value === b.value}
								value={scopeItems.find((item) => item.value === scope) ?? scopeItems[0]}
								onValueChange={(item) => {
									if (!item) return
									setScope(item.value)
									if (item.value) onProject(item.value)
								}}
							>
								<ComboboxTrigger
									render={<SidebarHeaderIconButton label="Filter conversations by project" />}
								>
									<FolderIcon className="size-4" />
								</ComboboxTrigger>
								<ComboboxPopup
									align="start"
									anchor={scopeAnchor}
									className="max-w-[min(18rem,var(--available-width))] overflow-hidden"
								>
									<ComboboxSearchInput
										aria-label="Search projects"
										placeholder="Search projects..."
									/>
									<ComboboxEmpty>No matching projects.</ComboboxEmpty>
									<ComboboxList>
										{(item: { value: string; label: string }) => (
											<ComboboxItem key={item.value} value={item} hideIndicator>
												<FolderIcon className="size-4 shrink-0" />
												<span className="min-w-0 flex-1 truncate text-sm">{item.label}</span>
											</ComboboxItem>
										)}
									</ComboboxList>
								</ComboboxPopup>
							</Combobox>
						}
						onNewProject={onOpenProject}
						onNewThread={onNewConversation}
						newThreadDisabled={opening || !active?.trusted || active.status !== 'ready'}
						newThreadShortcutLabel="Ctrl + N"
						newThreadInProjectShortcutLabel={null}
						showNewThreadInProjectHint={false}
						searchInputRef={searchInput}
						searchQuery={query}
						onSearchQueryChange={setQuery}
						onSearchKeyDown={() => {}}
						isSearching={Boolean(query)}
						onClearSearch={() => setQuery('')}
					/>
				</SidebarGroup>
				<div className="sidebar-scroll">
					<SidebarGroup className="pt-0">
						<nav className="conversations" aria-label="Conversations">
							<ThreadList
								rows={rows}
								projects={projects}
								threads={threads}
								sessionId={sessionId}
								onConversation={onConversation}
							/>
						</nav>
						{query && rows.length === 0 && (
							<output className="block px-2 py-6 text-center text-xs text-sidebar-muted-foreground">
								No conversations found.
							</output>
						)}
					</SidebarGroup>
				</div>
				<SidebarFooter>
					<div className="flex h-8 items-center gap-1">
						<Tooltip>
							<TooltipTrigger
								render={
									<Button
										variant="ghost-muted"
										size="icon-sm"
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
							<TooltipPopup side="top">Appearance · {appearance}</TooltipPopup>
						</Tooltip>
						<Tooltip>
							<TooltipTrigger
								render={
									<Button
										variant="ghost-muted"
										size="icon-sm"
										aria-label="Open a project"
										disabled={opening}
										onClick={onOpenProject}
									/>
								}
							>
								<FolderPlusIcon />
							</TooltipTrigger>
							<TooltipPopup side="top">Open a project</TooltipPopup>
						</Tooltip>
						<span className="ml-auto text-xs text-sidebar-muted-foreground/50">Namzu</span>
						<Button
							variant="ghost-muted"
							size="icon-sm"
							className="sidebar-close"
							aria-label="Close sidebar"
							onClick={onClose}
						>
							<PanelLeftCloseIcon />
						</Button>
					</div>
				</SidebarFooter>
			</aside>
		</>
	)
}

function ThreadList({
	rows,
	projects,
	threads,
	sessionId,
	onConversation,
}: {
	rows: ConversationView[]
	projects: ProjectView[]
	threads: Record<string, ThreadState>
	sessionId: string
	onConversation: (view: ConversationView) => void
}) {
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
	return (
		<ul ref={list} role="presentation" className="relative flex flex-col gap-px">
			{rows.map((item) => {
				const project = projects.find((project) => project.id === item.projectId)
				if (!project) return null
				return (
					<ThreadCard
						key={item.id}
						conversation={item}
						project={project}
						thread={threads[item.id]}
						active={item.id === sessionId}
						onClick={() => onConversation(item)}
					/>
				)
			})}
		</ul>
	)
}
