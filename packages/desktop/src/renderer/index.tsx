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
import { ToolView } from './tool-view.js'
import './style.css'

const api = window.namzu
const shortcut = navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl'
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))
function Icon({ name }: { name: 'folder' | 'plus' | 'menu' | 'arrow' | 'stop' | 'close' }) {
	const paths = {
		folder: 'M2 5h6l2 2h12v13H2z',
		plus: 'M12 5v14M5 12h14',
		menu: 'M4 6h16M4 12h16M4 18h16',
		arrow: 'M12 19V5M5 12l7-7 7 7',
		stop: 'M6 6h12v12H6z',
		close: 'M6 6l12 12M18 6 6 18',
	}
	return (
		<svg
			aria-hidden="true"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.7"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<path d={paths[name]} />
		</svg>
	)
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
	const [jobsOpen, setJobsOpen] = useState(false)
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
				[view.id]: { provider: status.selected?.id ?? '', model: status.selected?.model ?? '' },
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
			setDrafts((all) => ({ ...all, [target]: all[target] === prompt ? '' : (all[target] ?? '') }))
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
			{sideOpen && (
				<button
					type="button"
					className="scrim"
					aria-label="Close sidebar"
					onClick={() => setSideOpen(false)}
				/>
			)}
			<aside
				className={`sidebar ${sideOpen ? 'open' : ''}`}
				aria-label="Projects and conversations"
			>
				<div className="brand">
					<span className="brand-mark">N</span>
					<strong>Namzu</strong>
					<span className="preview-tag">Preview</span>
				</div>
				<button
					type="button"
					className="open-project"
					onClick={() => void act(openProject)}
					disabled={loading}
				>
					<Icon name="folder" />
					{loading ? 'Opening…' : 'Open a project'}
					<kbd>{shortcut} O</kbd>
				</button>
				<div className="section-label">Projects</div>
				<nav className="projects">
					{projects.map((item) => (
						<button
							type="button"
							key={item.id}
							className={item.id === projectId ? 'selected' : ''}
							onClick={() => {
								setProjectId(item.id)
								setSessionId('')
							}}
							title={item.path}
						>
							<Icon name="folder" />
							<span>{item.name}</span>
							<span className={`connection-dot ${item.status}`} />
						</button>
					))}
				</nav>
				<div className="section-heading">
					<span className="section-label">Conversations</span>
					<button
						type="button"
						className="icon-button"
						aria-label="New conversation"
						disabled={!project?.trusted || project.status !== 'ready'}
						onClick={() => void act(newConversation)}
					>
						<Icon name="plus" />
					</button>
				</div>
				<nav className="conversations">
					{conversations
						.filter((item) => item.projectId === projectId)
						.map((item) => (
							<button
								type="button"
								key={item.id}
								className={item.id === sessionId ? 'selected' : ''}
								onClick={() => void act(() => openConversation(item))}
							>
								<span>{item.title}</span>
								{threads[item.id]?.running && <span className="activity" aria-label="Working" />}
							</button>
						))}
				</nav>
				<div className="sidebar-footer">
					Your projects. Your conversations.
					<span>Stored by Namzu on this device.</span>
				</div>
			</aside>
			<main className="workspace">
				<header className="topbar">
					<button
						type="button"
						className="icon-button mobile-menu"
						aria-label="Toggle sidebar"
						onClick={() => setSideOpen(!sideOpen)}
					>
						<Icon name="menu" />
					</button>
					<div className="breadcrumb">
						<span>{project?.name ?? 'Workspace'}</span>
						<span className="divider">/</span>
						<strong>{conversation?.title ?? 'Start a conversation'}</strong>
					</div>
					<button
						type="button"
						className="jobs-button"
						onClick={() => setJobsOpen(!jobsOpen)}
						disabled={!sessionId}
					>
						Background work
						{jobs.some((job) => job.status === 'running') && (
							<span>{jobs.filter((job) => job.status === 'running').length}</span>
						)}
					</button>
				</header>
				{(error || project?.error) && (
					<div role="alert" className="error-banner">
						<span>{error || project?.error}</span>
						{project?.status === 'error' ? (
							<button
								type="button"
								onClick={() =>
									void act(async () => updateProject(await api.reconnectProject(project.id)))
								}
							>
								Reconnect
							</button>
						) : (
							<button
								type="button"
								className="icon-button"
								aria-label="Dismiss error"
								onClick={() => setError('')}
							>
								<Icon name="close" />
							</button>
						)}
					</div>
				)}
				{!project ? (
					<section className="welcome">
						<div className="welcome-mark">N</div>
						<p className="eyebrow">A place to work with your agent</p>
						<h1>What are we building?</h1>
						<p>
							Open a project to pick up where you left off,
							<br />
							or start a new conversation.
						</p>
						<button
							type="button"
							className="primary"
							onClick={() => void act(openProject)}
							disabled={loading}
						>
							<Icon name="folder" />
							Open a project
						</button>
						<p className="quiet">Uses the same providers and conversations as Namzu.</p>
					</section>
				) : !project.trusted ? (
					<section className="welcome">
						<h1>Make this your workspace</h1>
						<p className="project-path">{project.path}</p>
						<p>
							Namzu will work with the files in this folder.
							<br />
							Review the folder before allowing access.
						</p>
						<button
							type="button"
							className="primary"
							disabled={project.status !== 'ready'}
							onClick={() =>
								void act(async () => updateProject(await api.trustProject(project.id)))
							}
						>
							Review folder access
						</button>
					</section>
				) : !sessionId ? (
					<section className="welcome">
						<p className="eyebrow">{project.name}</p>
						<h1>Ready when you are.</h1>
						<p>Choose a conversation, or give Namzu something new to work on.</p>
						<button type="button" className="primary" onClick={() => void act(newConversation)}>
							<Icon name="plus" />
							New conversation
						</button>
					</section>
				) : (
					<>
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
								{thread.messages.length === 0 && (
									<div className="thread-empty">
										<p className="eyebrow">New conversation</p>
										<h2>Give it a starting point.</h2>
										<p>Ask a question, describe a change, or share what is getting in your way.</p>
									</div>
								)}
								{thread.messages.map((message, index) => (
									<article className={`message ${message.role}`} key={`${index}-${message.role}`}>
										<div className="message-label">{message.role === 'user' ? 'You' : 'Namzu'}</div>
										<div className="message-text">{message.text}</div>
									</article>
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
											<details className={`tool ${tool.status}`} key={tool.toolCallId}>
												<summary>
													<span className="tool-dot" />
													<span>{tool.view.kind === 'generic' ? tool.view.label : tool.title}</span>
													<span className="tool-status">
														{tool.status === 'pending'
															? thread.running
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
											<button
												type="button"
												onClick={() => void act(() => api.approve(sessionId, permission.id, false))}
											>
												Decline
											</button>
											<button
												type="button"
												className="primary"
												onClick={() => void act(() => api.approve(sessionId, permission.id, true))}
											>
												Allow once
											</button>
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
						<div className="composer-wrap">
							{thread.queued.length > 0 && (
								<div className="queue">
									<span>
										{thread.queued.length} queued · {thread.queued[0]?.slice(0, 100)}
									</span>
									<button
										type="button"
										onClick={() =>
											void act(async () => {
												const message = await api.takeQueued(sessionId)
												if (message)
													setDrafts((all) => ({
														...all,
														[sessionId]: message,
													}))
											})
										}
									>
										Edit latest
									</button>
								</div>
							)}
							<div className="composer">
								<textarea
									aria-label="Message Namzu"
									ref={input}
									value={draft}
									maxLength={50000}
									placeholder="Ask Namzu to work on something…"
									onChange={(event) =>
										setDrafts((all) => ({
											...all,
											[sessionId]: event.target.value,
										}))
									}
									onKeyDown={(event) => {
										if (
											event.key === 'Enter' &&
											!event.shiftKey &&
											!event.nativeEvent.isComposing
										) {
											event.preventDefault()
											void act(send)
										}
									}}
								/>
								<div className="composer-toolbar">
									<div className="model-controls">
										<select
											aria-label="Provider"
											value={choice.provider}
											disabled={thread.running}
											onChange={(event) =>
												setChoices((all) => ({
													...all,
													[sessionId]: {
														provider: event.target.value,
														model: '',
													},
												}))
											}
										>
											{providers.available.map((item) => (
												<option key={item.id} value={item.id}>
													{item.label}
												</option>
											))}
										</select>
										<input
											aria-label="Model"
											value={choice.model}
											placeholder={
												providers.available.find((item) => item.id === choice.provider)
													?.defaultModel ?? 'Default model'
											}
											disabled={thread.running}
											onChange={(event) =>
												setChoices((all) => ({
													...all,
													[sessionId]: { ...choice, model: event.target.value },
												}))
											}
										/>
										<button
											type="button"
											className="model-apply"
											disabled={thread.running || !choice.provider}
											onClick={() =>
												void act(() => api.selectProvider(sessionId, choice.provider, choice.model))
											}
										>
											Use model
										</button>
									</div>
									<div className="send-controls">
										{thread.running && (
											<button
												type="button"
												className="icon-button stop-button"
												aria-label="Stop turn"
												onClick={() => void act(() => api.cancel(sessionId))}
											>
												<Icon name="stop" />
											</button>
										)}
										<button
											type="button"
											className="send-button"
											aria-label={thread.running ? 'Queue message' : 'Send message'}
											disabled={!draft.trim() || !choice.provider || sending[sessionId]}
											onClick={() => void act(send)}
										>
											{thread.running ? 'Queue' : <Icon name="arrow" />}
										</button>
									</div>
								</div>
							</div>
							<div className="composer-hint">
								<span>
									{thread.running
										? 'Messages wait for the next turn'
										: 'Enter to send · Shift + Enter for a new line'}
								</span>
								<span>Namzu can make mistakes. Review its work.</span>
							</div>
							{providers.available.length === 0 && (
								<p className="notice">Set up a provider in Namzu, then reopen this project.</p>
							)}
						</div>
					</>
				)}
				{jobsOpen && (
					<aside className="jobs-panel" aria-label="Background work">
						<div className="section-heading">
							<h2>Background work</h2>
							<button
								type="button"
								className="icon-button"
								aria-label="Close background work"
								onClick={() => setJobsOpen(false)}
							>
								<Icon name="close" />
							</button>
						</div>
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
										<button
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
										</button>
										{job.status === 'running' && (
											<button
												type="button"
												onClick={() => void act(() => api.stopJob(sessionId, job.id))}
											>
												Stop
											</button>
										)}
									</div>
								</div>
							))
						)}
						{jobOutput && <pre className="job-output">{jobOutput}</pre>}
					</aside>
				)}
			</main>
		</div>
	)
}
createRoot(document.getElementById('root') as HTMLElement).render(
	<React.StrictMode>
		<App />
	</React.StrictMode>,
)
