import {
	ArrowUpIcon,
	FileDiffIcon,
	FolderIcon,
	PanelLeftIcon,
	PlusIcon,
	SquareIcon,
	TerminalIcon,
	XIcon,
} from 'lucide-react'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { type ThreadState, applyEvent, emptyThread } from '../shared/projection.js'
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
function App() {
	const [projects, setProjects] = useState<ProjectView[]>([])
	const [projectId, setProjectId] = useState('')
	const [conversations, setConversations] = useState<ConversationView[]>([])
	const [sessionId, setSessionId] = useState('')
	const [threads, setThreads] = useState<Record<string, ThreadState>>({})
	const [drafts, setDrafts] = useState<Record<string, string>>({})
	const [providers, setProviders] = useState<ProviderView>({
		available: [],
		selected: null,
	})
	const [choices, setChoices] = useState<Record<string, { provider: string; model: string }>>({})
	const [sideOpen, setSideOpen] = useState(false)
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
		if (!project || project.status !== 'ready' || !project.trusted) return
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
		const view = await api.newConversation(projectId)
		setConversations((all) => [view, ...all])
		setSessionId(view.id)
		setThreads((all) => ({ ...all, [view.id]: emptyThread() }))
		setSideOpen(false)
		input.current?.focus()
	}, [projectId])
	const openProject = useCallback(async () => {
		setLoading(true)
		try {
			const item = await api.openProject()
			if (item) {
				updateProject(item)
				setProjectId(item.id)
				setSessionId('')
				setSideOpen(false)
			}
		} finally {
			setLoading(false)
		}
	}, [updateProject])
	const openConversation = async (view: ConversationView) => {
		{
			const history = await api.openConversation(view.projectId, view.id)
			setThreads((all) => ({
				...all,
				[view.id]: {
					...emptyThread(),
					...all[view.id],
					...history.thread,
					messages: history.messages,
					partial: history.partial,
				},
			}))
		}
		const status = await api.providers(view.projectId, view.id)
		if (status.selected)
			setChoices((all) => ({
				...all,
				[view.id]: {
					provider: status.selected?.id ?? '',
					model: status.selected?.model ?? '',
				},
			}))
		setSessionId(view.id)
		setProjectId(view.projectId)
		setSideOpen(false)
		follow.current = true
		input.current?.focus()
	}
	const send = async () => {
		if (!draft.trim() || !sessionId || sendingRef.current.has(sessionId)) return
		const target = sessionId
		const prompt = draft
		sendingRef.current.add(target)
		setSending((all) => ({ ...all, [target]: true }))
		try {
			if (!thread.running) await api.selectProvider(target, choice.provider, choice.model)
			await api.send(target, prompt)
			// A slow route acknowledgement cannot erase typing that followed Send.
			setDrafts((all) => ({
				...all,
				[target]: all[target] === prompt ? '' : (all[target] ?? ''),
			}))
			follow.current = true
		} finally {
			sendingRef.current.delete(target)
			setSending((all) => ({ ...all, [target]: false }))
		}
	}
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
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
				void act(async () => {
					const queued = await api.takeQueued(sessionId)
					if (queued) setDrafts((all) => ({ ...all, [sessionId]: queued }))
				})
			}
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [sideOpen, jobsOpen, sessionId, thread.running, act, newConversation, openProject])
	return (
		<div className="app">
			<Sidebar
				projects={projects}
				conversations={conversations}
				projectId={projectId}
				sessionId={sessionId}
				threads={threads}
				open={sideOpen}
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
						className="icon-button mobile-menu"
						aria-label="Toggle sidebar"
						aria-expanded={sideOpen}
						aria-controls="namzu-sidebar"
						onClick={() => setSideOpen(!sideOpen)}
					>
						<Icon name="menu" />
					</Button>
					<div className="breadcrumb">
						<span>{project?.name ?? 'Workspace'}</span>
						<span className="divider">/</span>
						<strong>{conversation?.title ?? 'Start a conversation'}</strong>
					</div>
					<Button
						type="button"
						variant="ghost-muted"
						size="sm"
						className="jobs-button"
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
								{thread.messages.map((message, index) => (
									<Message
										from={message.role}
										className={`message ${message.role}`}
										key={`${index}-${message.role}`}
									>
										<MessageContent text={message.text} markdown={message.role === 'assistant'} />
									</Message>
								))}
								{thread.reasoning && (
									<details className="reasoning">
										<summary>Thinking</summary>
										<p>{thread.reasoning}</p>
									</details>
								)}
								{Object.values(thread.tools).length > 0 && (
									<div className="tool-list">
										{Object.values(thread.tools).map((tool) => (
											<details
												className={`tool ${tool.status} ${thread.activeToolIds.includes(tool.toolCallId) ? 'active' : ''}`}
												key={tool.toolCallId}
											>
												<summary>
													<span className="tool-dot" />
													<span>{tool.view.kind === 'generic' ? tool.view.label : tool.title}</span>
													<span className="tool-status">
														{tool.status === 'pending'
															? thread.activeToolIds.includes(tool.toolCallId)
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
										))}
									</div>
								)}
								<ChangedFilesCard
									tools={Object.values(thread.tools)}
									onOpen={() => {
										setPanelTab('changes')
										setJobsOpen(true)
									}}
								/>
								{thread.permissions.map((permission) => (
									<section className="approval" key={permission.id} aria-label="Tool approval">
										<p className="eyebrow">Your approval is needed</p>
										<h3>Allow this action?</h3>
										{permission.calls.map((call) => (
											<div key={call.id}>
												<strong>
													{call.name}
													{call.isDestructive ? ' · changes or removes data' : ''}
												</strong>
												<pre>{JSON.stringify(call.input, null, 2)}</pre>
											</div>
										))}
										<div className="approval-actions">
											<Button
												type="button"
												onClick={() => void act(() => api.approve(sessionId, permission.id, false))}
											>
												Decline
											</Button>
											<Button
												type="button"
												className="primary"
												size="default"
												onClick={() => void act(() => api.approve(sessionId, permission.id, true))}
											>
												Allow once
											</Button>
										</div>
									</section>
								))}
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
							projectName={project.name}
							projectPath={project.path}
							empty={thread.messages.length === 0}
							draft={draft}
							onDraftChange={(value) => setDrafts((all) => ({ ...all, [sessionId]: value }))}
							providers={providers}
							choice={choice}
							onChoiceChange={(value) => setChoices((all) => ({ ...all, [sessionId]: value }))}
							running={thread.running}
							sending={sending[sessionId] ?? false}
							queued={thread.queued}
							onSend={() => void act(send)}
							onStop={() => void act(() => api.cancel(sessionId))}
							onEditQueued={() =>
								void act(async () => {
									const message = await api.takeQueued(sessionId)
									if (message) setDrafts((all) => ({ ...all, [sessionId]: message }))
								})
							}
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
							tools={Object.values(thread.tools)}
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
														const output = await api.readJob(sessionId, job.id)
														setJobOutput(
															`${output.truncated ? 'Earlier output omitted.\n' : ''}${output.output}`,
														)
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
