import {
	ArrowUpIcon,
	FileDiffIcon,
	FolderIcon,
	PanelLeftIcon,
	PlusIcon,
	SquareIcon,
	TerminalIcon,
	WrenchIcon,
	XIcon,
} from 'lucide-react'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { type ThreadState, applyEvent, emptyThread, restoreMessages } from '../shared/projection.js'
import type {
	ConversationView,
	DesktopEvent,
	JobView,
	ProjectView,
	ProviderView,
} from '../shared/protocol.js'
import { ChangedFilesCard } from './changed-files-card.js'
import { ChangesPanel } from './changes-panel.js'
import { ChatErrorBanner } from './chat-error-banner.js'
import { Composer } from './composer.js'
import { Message, MessageContent } from './message.js'
import { type Appearance, Sidebar } from './sidebar.js'
import { ToolView } from './tool-view.js'
import { Button } from './ui/button.js'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from './ui/empty.js'
import { TooltipProvider } from './ui/tooltip.js'
import { Wordmark } from './wordmark.js'
import {
	WorkspaceBreadcrumb,
	WorkspaceBreadcrumbItem,
	WorkspaceBreadcrumbSeparator,
	WorkspaceBreadcrumbText,
} from './workspace-breadcrumb.js'
import { WorkspacePageHeader } from './workspace-page-header.js'

import './style.css'

const api = window.namzu
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))
function Icon({ name }: { name: 'folder' | 'plus' | 'menu' | 'arrow' | 'stop' | 'close' }) {
	const Component = {
		folder: FolderIcon,
		plus: PlusIcon,
		menu: PanelLeftIcon,
		arrow: ArrowUpIcon,
		stop: SquareIcon,
		close: XIcon,
	}[name]
	return <Component aria-hidden="true" />
}
function ToolRow({ tool, active }: { tool: ThreadState['tools'][string]; active: boolean }) {
	const Icon =
		tool.view.kind === 'terminal' || tool.title === 'bash'
			? TerminalIcon
			: tool.view.kind === 'diff'
				? FileDiffIcon
				: WrenchIcon
	return (
		<details
			className={`tool ${tool.status} ${active ? 'active' : ''}`}
			data-tool-call-id={tool.toolCallId}
		>
			<summary>
				<span className="tool-icon flex size-6 shrink-0 items-center justify-center">
					<Icon className="size-4" aria-hidden="true" />
				</span>
				<span>{tool.view.kind === 'generic' ? tool.view.label : tool.title}</span>
				<span className="tool-status">
					{tool.status === 'pending'
						? active
							? 'Working'
							: 'Interrupted'
						: tool.status === 'failed'
							? 'Failed'
							: 'Done'}
				</span>
			</summary>
			<ToolView view={tool.view} />
			{tool.progress && (
				<output className="tool-progress">
					{tool.progress.message}
					{tool.progress.fraction !== undefined && (
						<progress value={tool.progress.fraction} max={1} />
					)}
				</output>
			)}
		</details>
	)
}
function App() {
	const [projects, setProjects] = useState<ProjectView[]>([])
	const [projectId, setProjectId] = useState('')
	const [conversations, setConversations] = useState<ConversationView[]>([])
	const [sessionId, setSessionId] = useState('')
	const [threads, setThreads] = useState<Record<string, ThreadState>>({})
	const [drafts, setDrafts] = useState<Record<string, string>>({})
	const draftsRef = useRef<Record<string, string>>({})
	const navigation = useRef(0)
	const snapshotRead = useRef<{
		generation: number
		sessionId: string
		events: DesktopEvent[]
		characters: number
		overflow: boolean
	} | null>(null)
	const activeSession = useRef('')
	activeSession.current = sessionId
	const editingQueue = useRef(new Set<string>())
	const [queueEditing, setQueueEditing] = useState<Record<string, boolean>>({})
	const [providers, setProviders] = useState<ProviderView>({
		available: [],
		selected: null,
	})
	const [choices, setChoices] = useState<Record<string, { provider: string; model: string }>>({})
	const [sideOpen, setSideOpen] = useState(false)
	const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 767px)').matches)
	useEffect(() => {
		const media = window.matchMedia('(max-width: 767px)')
		const update = () => setMobile(media.matches)
		media.addEventListener('change', update)
		return () => media.removeEventListener('change', update)
	}, [])
	const [sideCollapsed, setSideCollapsed] = useState(
		() => localStorage.getItem('namzu.sidebar-collapsed') === 'true',
	)
	const toggleSidebar = useCallback(() => {
		if (window.matchMedia('(max-width: 767px)').matches) setSideOpen((value) => !value)
		else
			setSideCollapsed((value) => {
				localStorage.setItem('namzu.sidebar-collapsed', String(!value))
				return !value
			})
	}, [])
	useEffect(() => {
		if (window.matchMedia('(max-width: 767px)').matches) return
		const control = document.querySelector<HTMLButtonElement>(
			sideCollapsed
				? 'button[aria-label="Toggle sidebar"]'
				: 'button[aria-label="Collapse sidebar"]',
		)
		control?.focus({ preventScroll: true })
	}, [sideCollapsed])
	useEffect(() => {
		const key = (event: KeyboardEvent) => {
			if (event.isComposing || event.keyCode === 229 || event.defaultPrevented) return
			if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b' && !event.altKey) {
				event.preventDefault()
				toggleSidebar()
			}
		}
		window.addEventListener('keydown', key)
		return () => window.removeEventListener('keydown', key)
	}, [toggleSidebar])
	const [appearance, setAppearance] = useState<Appearance>(() => {
		const saved = localStorage.getItem('namzu.appearance')
		return saved === 'light' || saved === 'system' ? saved : 'dark'
	})
	useEffect(() => {
		const media = window.matchMedia('(prefers-color-scheme: dark)')
		const apply = () =>
			document.documentElement.classList.toggle(
				'dark',
				appearance === 'dark' || (appearance === 'system' && media.matches),
			)
		apply()
		localStorage.setItem('namzu.appearance', appearance)
		media.addEventListener('change', apply)
		return () => media.removeEventListener('change', apply)
	}, [appearance])
	const [jobsOpen, setJobsOpen] = useState(false)
	const [panelTab, setPanelTab] = useState<'jobs' | 'changes'>('jobs')
	const [jobs, setJobs] = useState<JobView[]>([])
	const [jobOutput, setJobOutput] = useState('')
	const [jobsError, setJobsError] = useState('')
	const [jobsLoading, setJobsLoading] = useState(false)
	const [error, setError] = useState('')
	const [loading, setLoading] = useState(false)
	const [sending, setSending] = useState<Record<string, boolean>>({})
	const sendingRef = useRef(new Set<string>())
	const input = useRef<HTMLTextAreaElement>(null)
	const transcript = useRef<HTMLDivElement>(null)
	const follow = useRef(true)
	const project = projects.find((item) => item.id === projectId)
	const conversation = conversations.find((item) => item.id === sessionId)
	const thread = threads[sessionId] ?? emptyThread()
	const draft = drafts[sessionId] ?? ''
	const choice = choices[sessionId] ?? {
		provider: providers.selected?.id ?? providers.available[0]?.id ?? '',
		model: providers.selected?.model ?? '',
	}
	const updateProject = useCallback(
		(item: ProjectView) =>
			setProjects((items) => [...items.filter((row) => row.id !== item.id), item]),
		[],
	)
	const act = useCallback(async (action: () => Promise<unknown>) => {
		setError('')
		try {
			await action()
		} catch (failure) {
			setError(errorText(failure))
		}
	}, [])
	useEffect(() => {
		if (!api) {
			setError('Open Namzu using the desktop application.')
			return
		}
		void api
			.projects()
			.then((items) => {
				setProjects(items)
				if (items[0]) setProjectId(items[0].id)
			})
			.catch((failure) => setError(errorText(failure)))
		return api.onEvent((event: DesktopEvent) => {
			if (event.kind === 'connection') {
				updateProject(event.project)
				return
			}
			const id = event.kind === 'permission' ? event.request.sessionId : event.sessionId
			const read = snapshotRead.current
			if (read?.sessionId === id && read.generation === navigation.current && !read.overflow) {
				read.characters += JSON.stringify(event).length
				if (read.characters > 8 * 1024 * 1024 || read.events.length >= 10_000) {
					read.overflow = true
					read.events.length = 0
				} else read.events.push(event)
			}
			setThreads((all) => ({
				...all,
				[id]: applyEvent(all[id] ?? emptyThread(), event),
			}))
			if (event.kind === 'prompt')
				setConversations((all) =>
					all.map((item) =>
						item.id === id && item.title === 'New conversation'
							? { ...item, title: event.prompt.slice(0, 80) }
							: item,
					),
				)
		})
	}, [updateProject])
	useEffect(() => {
		if (!project || project.status === 'connecting' || !project.trusted) return
		let current = true
		void Promise.all([api.conversations(project.id), api.providers(project.id)])
			.then(([rows, available]) => {
				if (!current) return
				setConversations((all) => {
					const returned = new Set(rows.map((row) => row.id))
					return [
						...all.filter((item) => item.projectId !== project.id || !returned.has(item.id)),
						...rows,
					]
				})
				setProviders(available)
			})
			.catch((failure) => {
				if (current) setError(errorText(failure))
			})
		return () => {
			current = false
		}
	}, [project])
	useEffect(() => {
		if (!sessionId || !api) {
			setJobs([])
			return
		}
		let current = true
		let pending = false
		setJobOutput('')
		setJobsLoading(true)
		setJobsError('')
		const read = async () => {
			if (pending) return
			pending = true
			try {
				const rows = await api.jobs(sessionId)
				if (current) {
					setJobs(rows)
					setJobsError('')
				}
			} catch (failure) {
				if (current) setJobsError(errorText(failure))
			} finally {
				pending = false
				if (current) setJobsLoading(false)
			}
		}
		void read()
		const timer = setInterval(() => void read(), 2000)
		return () => {
			current = false
			clearInterval(timer)
		}
	}, [sessionId])
	useEffect(() => {
		const node = transcript.current
		if (!node || !sessionId) return
		const observer = new ResizeObserver(() => {
			if (follow.current) node.scrollTop = node.scrollHeight
		})
		observer.observe(node)
		if (node.firstElementChild) observer.observe(node.firstElementChild)
		return () => observer.disconnect()
	}, [sessionId])
	const newConversation = useCallback(async () => {
		if (!projectId) return
		const generation = ++navigation.current
		try {
			const view = await api.newConversation(projectId)
			setConversations((all) => [view, ...all])
			setThreads((all) => ({ ...all, [view.id]: emptyThread() }))
			if (generation !== navigation.current) return
			setSessionId(view.id)
			setSideOpen(false)
			input.current?.focus()
		} catch (failure) {
			if (generation === navigation.current) throw failure
		}
	}, [projectId])
	const openProject = useCallback(async () => {
		const generation = ++navigation.current
		setLoading(true)
		try {
			const item = await api.openProject()
			if (item) {
				updateProject(item)
				if (generation !== navigation.current) return
				setProjectId(item.id)
				setSessionId('')
				setSideOpen(false)
			}
		} catch (failure) {
			if (generation === navigation.current) throw failure
		} finally {
			setLoading(false)
		}
	}, [updateProject])
	const openConversation = async (view: ConversationView) => {
		const generation = ++navigation.current
		if (snapshotRead.current) snapshotRead.current.events.length = 0
		const read = {
			generation,
			sessionId: view.id,
			events: [] as DesktopEvent[],
			characters: 0,
			overflow: false,
		}
		snapshotRead.current = read
		try {
			const history = await api.openConversation(view.projectId, view.id)
			if (generation !== navigation.current) return
			if (read.overflow)
				throw new Error(
					'This conversation changed while opening. Open it again for its latest history.',
				)
			const replay = [...read.events]
			if (snapshotRead.current === read) snapshotRead.current = null
			setThreads((all) => {
				let restored: ThreadState = {
					...emptyThread(),
					...history.thread,
					messages: history.messages,
					partial: history.partial,
				}
				if (!history.thread) restored = restoreMessages(restored, history.messages)
				for (const event of replay) restored = applyEvent(restored, event)
				return (all[view.id]?.revision ?? 0) > restored.revision
					? all
					: { ...all, [view.id]: restored }
			})
			const [status, savedDraft] = await Promise.all([
				api.providers(view.projectId, view.id),
				api.draft(view.id),
			])
			if (draftsRef.current[view.id] === undefined) {
				draftsRef.current[view.id] = savedDraft
				setDrafts((all) => ({ ...all, [view.id]: all[view.id] ?? savedDraft }))
			}
			if (status.selected)
				setChoices((all) => ({
					...all,
					[view.id]: {
						provider: status.selected?.id ?? '',
						model: status.selected?.model ?? '',
					},
				}))
			if (generation !== navigation.current) return
			setSessionId(view.id)
			setProjectId(view.projectId)
			setSideOpen(false)
			follow.current = true
			input.current?.focus()
		} catch (failure) {
			if (generation === navigation.current) throw failure
		} finally {
			if (snapshotRead.current === read) snapshotRead.current = null
		}
	}
	const changeDraft = (target: string, value: string) => {
		if (editingQueue.current.has(target)) return
		draftsRef.current[target] = value
		setDrafts((all) => ({ ...all, [target]: value }))
		void api.saveDraft(target, value).catch((failure) => setError(errorText(failure)))
	}
	const editQueued = useCallback(
		async (itemId?: string) => {
			const target = sessionId
			if (!target || editingQueue.current.has(target)) return
			if ((draftsRef.current[target] ?? '').length > 0)
				throw new Error('Send or clear your current draft before editing a queued message.')
			editingQueue.current.add(target)
			setQueueEditing((all) => ({ ...all, [target]: true }))
			try {
				const message = await api.takeQueued(target, itemId)
				if (message !== null) {
					draftsRef.current[target] = message
					setDrafts((all) => ({ ...all, [target]: message }))
				}
			} finally {
				editingQueue.current.delete(target)
				setQueueEditing((all) => ({ ...all, [target]: false }))
				if (activeSession.current === target) input.current?.focus()
			}
		},
		[sessionId],
	)
	const send = async () => {
		if (
			!draft.trim() ||
			!sessionId ||
			sendingRef.current.has(sessionId) ||
			project?.status !== 'ready'
		)
			return
		const target = sessionId
		const prompt = draft
		sendingRef.current.add(target)
		setSending((all) => ({ ...all, [target]: true }))
		try {
			if (!thread.running) await api.selectProvider(target, choice.provider, choice.model)
			await api.send(target, prompt)
			// A slow route acknowledgement cannot erase typing that followed Send.
			if (draftsRef.current[target] === prompt) {
				draftsRef.current[target] = ''
				setDrafts((all) => ({ ...all, [target]: '' }))
			}
			follow.current = true
		} finally {
			sendingRef.current.delete(target)
			setSending((all) => ({ ...all, [target]: false }))
		}
	}
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.isComposing || event.keyCode === 229) return
			if (event.defaultPrevented) return
			if (event.key === 'Escape') {
				if (sideOpen || jobsOpen) {
					setSideOpen(false)
					setJobsOpen(false)
				} else if (thread.running) void act(() => api.cancel(sessionId))
				return
			}
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'o') {
				event.preventDefault()
				void act(openProject)
			}
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') {
				event.preventDefault()
				void act(newConversation)
			}
			if (event.altKey && event.key === 'ArrowUp' && sessionId) {
				event.preventDefault()
				void act(() => editQueued())
			}
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [sideOpen, jobsOpen, sessionId, thread.running, act, newConversation, openProject, editQueued])
	return (
		<div className="app" data-sidebar-collapsed={sideCollapsed}>
			<Sidebar
				projects={projects}
				conversations={conversations}
				projectId={projectId}
				sessionId={sessionId}
				threads={threads}
				open={sideOpen}
				collapsed={sideCollapsed}
				onToggle={toggleSidebar}
				opening={loading}
				appearance={appearance}
				onAppearance={() =>
					setAppearance((value) =>
						value === 'system' ? 'dark' : value === 'dark' ? 'light' : 'system',
					)
				}
				onClose={() => setSideOpen(false)}
				onOpenProject={() => void act(openProject)}
				onNewConversation={() => void act(newConversation)}
				onProject={(id) => {
					navigation.current += 1
					setProjectId(id)
					setSessionId('')
				}}
				onConversation={(view) => void act(() => openConversation(view))}
			/>
			<main className={`workspace ${jobsOpen ? 'jobs-open' : ''}`}>
				<WorkspacePageHeader className="topbar">
					<Button
						type="button"
						variant="ghost-muted"
						size="icon-sm"
						className={`icon-button sidebar-open-control ${sideCollapsed ? 'is-collapsed' : ''}`}
						aria-label="Toggle sidebar"
						aria-expanded={mobile ? sideOpen : !sideCollapsed}
						aria-controls="namzu-sidebar"
						onClick={toggleSidebar}
					>
						<Icon name="menu" />
					</Button>
					<WorkspaceBreadcrumb ariaLabel="Conversation breadcrumb" className="breadcrumb flex-1">
						<WorkspaceBreadcrumbItem className="breadcrumb-project shrink">
							<WorkspaceBreadcrumbText className="max-w-40" data-project-label>
								{project?.name ?? 'Workspace'}
							</WorkspaceBreadcrumbText>
						</WorkspaceBreadcrumbItem>
						<WorkspaceBreadcrumbSeparator className="breadcrumb-separator">
							<WorkspaceBreadcrumbText>/</WorkspaceBreadcrumbText>
						</WorkspaceBreadcrumbSeparator>
						<WorkspaceBreadcrumbItem current className="min-w-10 flex-1">
							<h2 className="min-w-0 flex-1">
								<WorkspaceBreadcrumbText data-conversation-title>
									{conversation?.title ?? 'Start a conversation'}
								</WorkspaceBreadcrumbText>
							</h2>
						</WorkspaceBreadcrumbItem>
					</WorkspaceBreadcrumb>
					<Button
						type="button"
						variant="ghost-muted"
						size="sm"
						className="jobs-button"
						aria-label="Background work"
						aria-description={`${jobs.filter((job) => job.status === 'running').length} running shells in this conversation`}
						onClick={() => {
							setPanelTab('jobs')
							setJobsOpen(panelTab !== 'jobs' || !jobsOpen)
						}}
						disabled={!sessionId}
					>
						<TerminalIcon aria-hidden="true" className="size-4" />
						<span className="jobs-button-label">Background work</span>
						{jobs.some((job) => job.status === 'running') && (
							<span>{jobs.filter((job) => job.status === 'running').length}</span>
						)}
					</Button>
					<Button
						type="button"
						variant="ghost-muted"
						size="icon-sm"
						aria-label="Show changes"
						disabled={!sessionId}
						aria-pressed={jobsOpen && panelTab === 'changes'}
						onClick={() => {
							setPanelTab('changes')
							setJobsOpen(panelTab !== 'changes' || !jobsOpen)
						}}
					>
						<FileDiffIcon className="size-4" />
					</Button>
				</WorkspacePageHeader>
				{(error || project?.error) && (
					<div className="connection-error">
						<ChatErrorBanner
							message={error || project?.error || ''}
							onRetry={
								project?.status === 'error'
									? () =>
											void act(async () => updateProject(await api.reconnectProject(project.id)))
									: undefined
							}
							onDismiss={project?.status !== 'error' ? () => setError('') : undefined}
						/>
					</div>
				)}
				{!project ? (
					<Empty className="welcome">
						<Wordmark hero />

						<EmptyHeader className="max-w-lg px-8">
							<EmptyTitle>
								<h1>What would you like to work on?</h1>
							</EmptyTitle>
							<EmptyDescription>
								Open a project to pick up where you left off,
								<br />
								or start a new conversation.
							</EmptyDescription>
						</EmptyHeader>
						<Button
							type="button"
							className="primary"
							size="default"
							onClick={() => void act(openProject)}
							disabled={loading}
						>
							<Icon name="folder" />
							Open a project
						</Button>
					</Empty>
				) : !project.trusted ? (
					<Empty className="welcome">
						<EmptyHeader className="max-w-lg px-8">
							<EmptyTitle>
								<h1>Make this your workspace</h1>
							</EmptyTitle>
							<EmptyDescription className="project-path">{project.path}</EmptyDescription>
							<EmptyDescription>
								Namzu will work with the files in this folder.
								<br />
								Review the folder before allowing access.
							</EmptyDescription>
						</EmptyHeader>
						<Button
							type="button"
							className="primary"
							size="default"
							disabled={project.status !== 'ready'}
							onClick={() =>
								void act(async () => updateProject(await api.trustProject(project.id)))
							}
						>
							Review folder access
						</Button>
					</Empty>
				) : !sessionId ? (
					<Empty className="welcome">
						<EmptyHeader className="max-w-lg px-8">
							<EmptyTitle>
								<h1>Start something new</h1>
							</EmptyTitle>
							<EmptyDescription>
								Choose a conversation, or give Namzu something new to work on.
							</EmptyDescription>
						</EmptyHeader>
						<Button
							type="button"
							className="primary"
							size="default"
							onClick={() => void act(newConversation)}
						>
							<Icon name="plus" />
							New conversation
						</Button>
					</Empty>
				) : (
					<div className="chat-stage">
						<div
							className="transcript"
							ref={transcript}
							onScroll={() => {
								if (transcript.current)
									follow.current =
										transcript.current.scrollHeight -
											transcript.current.scrollTop -
											transcript.current.clientHeight <
										100
							}}
						>
							<div className="conversation-body">
								{thread.partial && (
									<p className="notice">
										Showing the latest part of this conversation. The full record remains on this
										device.
									</p>
								)}
								{thread.timeline.map((entry) => {
									if (entry.kind === 'tool') {
										const tool = thread.tools[entry.id]
										return tool ? (
											<div
												className="tool-list"
												key={`tool-${entry.id}`}
												data-timeline-turn={entry.turn}
											>
												<ToolRow tool={tool} active={thread.activeToolIds.includes(entry.id)} />
											</div>
										) : null
									}
									const message = thread.messages[entry.index]
									return message ? (
										<Message
											from={message.role}
											className={`message ${message.role}`}
											key={`message-${entry.index}`}
											data-timeline-turn={entry.turn}
										>
											<MessageContent text={message.text} markdown={message.role === 'assistant'} />
										</Message>
									) : null
								})}
								{thread.reasoning && (
									<details className="reasoning">
										<summary>Thinking</summary>
										<p>{thread.reasoning}</p>
									</details>
								)}
								<ChangedFilesCard
									tools={thread.tools}
									onOpen={() => {
										setPanelTab('changes')
										setJobsOpen(true)
									}}
								/>
								{thread.error && (
									<p className="inline-error" role="alert">
										{thread.error}
									</p>
								)}
								{thread.running && (
									<div className="working">
										<span className="activity" />
										{thread.permissions.length ? 'Waiting for your decision' : 'Working'}
									</div>
								)}
								{!thread.running && thread.stopReason && thread.stopReason !== 'end_turn' && (
									<p className="notice">
										{thread.stopReason === 'cancelled'
											? 'Stopped. You can continue from here.'
											: thread.stopReason === 'max_turns'
												? 'Turn limit reached. Review the work before continuing.'
												: thread.stopReason === 'refused'
													? 'The action was not approved.'
													: 'This turn could not finish.'}
									</p>
								)}
							</div>
						</div>
						<Composer
							inputRef={input}
							permissions={thread.permissions}
							onApproval={(permission, approved) =>
								void act(() => api.approve(permission.sessionId, permission.id, approved))
							}
							projectName={project.name}
							projectPath={project.path}
							empty={thread.messages.length === 0}
							draft={draft}
							onDraftChange={(value) => changeDraft(sessionId, value)}
							providers={providers}
							connected={project.status === 'ready'}
							choice={choice}
							onChoiceChange={(value) => setChoices((all) => ({ ...all, [sessionId]: value }))}
							running={thread.running}
							sending={sending[sessionId] ?? false}
							queued={thread.queued}
							queuedItems={thread.queuedItems}
							editingQueued={queueEditing[sessionId] ?? false}
							onSend={() => void act(send)}
							onStop={() => void act(() => api.cancel(sessionId))}
							onEditQueued={(itemId) => void act(() => editQueued(itemId))}
							onRemoveQueued={(itemId) => void act(() => api.removeQueued(sessionId, itemId))}
						/>
					</div>
				)}
				<aside
					className="jobs-panel"
					data-open={jobsOpen}
					inert={!jobsOpen}
					aria-hidden={!jobsOpen}
					aria-label={panelTab === 'jobs' ? 'Background work' : 'Changes'}
				>
					<div className="section-heading">
						<div className="flex items-center gap-1">
							<Button
								size="xs"
								variant="ghost-muted"
								aria-pressed={panelTab === 'changes'}
								onClick={() => setPanelTab('changes')}
							>
								<FileDiffIcon className="size-3.5" />
								Changes
							</Button>
							<Button
								size="xs"
								variant="ghost-muted"
								aria-pressed={panelTab === 'jobs'}
								onClick={() => setPanelTab('jobs')}
							>
								<TerminalIcon className="size-3.5" />
								Background work
							</Button>
						</div>
						<Button
							type="button"
							variant="ghost-muted"
							size="icon-sm"
							className="icon-button"
							aria-label={panelTab === 'jobs' ? 'Close background work' : 'Close changes'}
							onClick={() => setJobsOpen(false)}
						>
							<Icon name="close" />
						</Button>
					</div>
					{panelTab === 'changes' ? (
						<ChangesPanel
							tools={thread.tools}
							dark={
								appearance === 'dark' ||
								(appearance === 'system' &&
									window.matchMedia('(prefers-color-scheme: dark)').matches)
							}
						/>
					) : (
						<div className="panel-scroll">
							{jobsError ? (
								<p role="alert" className="jobs-error">
									{jobsError}
								</p>
							) : jobsLoading ? (
								<p className="quiet">Loading background work…</p>
							) : jobs.length === 0 ? (
								<p className="quiet">No background shells in this conversation.</p>
							) : (
								jobs.map((job) => (
									<div className="job" key={job.id}>
										<strong>{job.status}</strong>
										<code>{job.command}</code>
										<div>
											<Button
												type="button"
												onClick={() =>
													void act(async () => {
														const target = sessionId
														const generation = navigation.current
														try {
															const output = await api.readJob(target, job.id)
															if (
																activeSession.current !== target ||
																generation !== navigation.current
															)
																return
															setJobOutput(
																`${output.truncated ? 'Earlier output omitted.\n' : ''}${output.output}`,
															)
														} catch (failure) {
															if (
																activeSession.current === target &&
																generation === navigation.current
															)
																throw failure
														}
													})
												}
											>
												View output
											</Button>
											{job.status === 'running' && (
												<Button
													type="button"
													onClick={() => void act(() => api.stopJob(sessionId, job.id))}
												>
													Stop
												</Button>
											)}
										</div>
									</div>
								))
							)}
							{jobOutput && <pre className="job-output">{jobOutput}</pre>}
						</div>
					)}
				</aside>
			</main>
		</div>
	)
}
createRoot(document.getElementById('root') as HTMLElement).render(
	<React.StrictMode>
		<TooltipProvider delay={250}>
			<App />
		</TooltipProvider>
	</React.StrictMode>,
)
