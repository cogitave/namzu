import type { ThreadState } from '../shared/projection.js'
import { CheckIcon, ChevronRightIcon, ListTodoIcon, LoaderCircleIcon, XIcon } from './icons.js'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from './ui/collapsible.js'
import './conversation-tasks.css'

const labels = {
	pending: 'Pending',
	in_progress: 'In progress',
	completed: 'Completed',
	failed: 'Failed',
}
/** Plan milestones are reported states, not measured execution percentages. */
function PalTaskProgress({
	thread,
	name,
}: { thread: Pick<ThreadState, 'tasks' | 'tasksNotice'>; name: string }) {
	const completed = thread.tasks.filter((task) => task.status === 'completed').length
	const failed = thread.tasks.filter((task) => task.status === 'failed').length
	const allDone = thread.tasks.length > 0 && completed === thread.tasks.length
	const byId = new Map(thread.tasks.map((task) => [task.taskId, task]))
	return (
		<section
			aria-label={`${name} tasks`}
			className="conversation-tasks pal-plan-progress"
			tabIndex={-1}
		>
			<h3>Progress</h3>
			{thread.tasksNotice && <output className="quiet">{thread.tasksNotice}</output>}
			{thread.tasks.length > 0 && (
				<Collapsible defaultOpen={!allDone || Boolean(thread.tasksNotice)}>
					<CollapsibleTrigger
						className="pal-plan-toggle"
						aria-label="View plan steps"
						aria-description={`${completed} of ${thread.tasks.length} ${thread.tasks.length === 1 ? 'step' : 'steps'} done`}
					>
						{allDone ? <CheckIcon aria-hidden="true" /> : <ListTodoIcon aria-hidden="true" />}
						<span className="pal-plan-summary">
							<span
								className="pal-plan-count"
								title={`${completed} of ${thread.tasks.length} ${thread.tasks.length === 1 ? 'step' : 'steps'} done`}
							>
								<span className="pal-plan-number">{completed}</span>
								{' of '}
								<span className="pal-plan-number">{thread.tasks.length}</span>
								{thread.tasks.length === 1 ? ' step' : ' steps'}
							</span>
							{failed > 0 && (
								<span className="tasks-failed">
									{failed} {failed === 1 ? 'needs' : 'need'} attention
								</span>
							)}
						</span>
						<ChevronRightIcon className="pal-plan-chevron" aria-hidden="true" />
					</CollapsibleTrigger>
					<CollapsiblePanel>
						<ul className="pal-plan-steps">
							{thread.tasks.map((task) => {
								const dependencies = task.blockedBy.map((id) => byId.get(id))
								const waiting =
									task.status === 'pending' &&
									dependencies.some(
										(dep) => !dep || dep.status === 'pending' || dep.status === 'in_progress',
									)
								const Icon =
									task.status === 'completed'
										? CheckIcon
										: task.status === 'failed'
											? XIcon
											: task.status === 'in_progress'
												? LoaderCircleIcon
												: undefined
								const state =
									task.status === 'completed'
										? 'Done'
										: task.status === 'failed'
											? 'Needs attention'
											: task.status === 'in_progress'
												? 'In progress'
												: waiting
													? 'Waiting'
													: 'Not started'
								const remaining = dependencies.filter((dep) => dep?.status !== 'completed')
								return (
									<li key={task.taskId} data-status={task.status}>
										<span className="pal-step-mark" aria-hidden="true">
											{Icon && (
												<Icon
													className={
														task.status === 'in_progress' ? 'pal-context-loading' : undefined
													}
												/>
											)}
										</span>
										<div className="pal-step-copy">
											<div className="pal-step-row">
												<span className="pal-step-subject">{task.subject}</span>
												<span className="task-state pal-step-state">{state}</span>
											</div>
											{task.status !== 'completed' && remaining.length > 0 && (
												<p className="quiet">
													{waiting ? 'Waiting on: ' : 'Earlier step: '}
													{remaining
														.map((dep) =>
															dep
																? `${dep.subject}${dep.status === 'failed' ? ' (needs attention)' : ''}`
																: 'Unavailable step',
														)
														.join(', ')}
												</p>
											)}
										</div>
									</li>
								)
							})}
						</ul>
					</CollapsiblePanel>
				</Collapsible>
			)}
		</section>
	)
}
/** Planning status is authored by the agent; it does not certify an output passed QA. */
export function ConversationTasks({
	thread,
	palName,
}: { thread: Pick<ThreadState, 'tasks' | 'tasksNotice'>; palName?: string }) {
	if (!thread.tasks.length && !thread.tasksNotice) return null
	if (palName) return <PalTaskProgress thread={thread} name={palName} />
	const byId = new Map(thread.tasks.map((task) => [task.taskId, task]))
	return (
		<section aria-label="Conversation tasks" className="conversation-tasks">
			<h3>Tasks</h3>
			<p className="quiet">The agent’s plan for this conversation.</p>
			{thread.tasksNotice && <output className="quiet">{thread.tasksNotice}</output>}
			<ul>
				{thread.tasks.map((task) => (
					<li key={task.taskId} data-status={task.status}>
						<div>
							<span>{task.subject}</span>
							<span className="task-state">{labels[task.status]}</span>
						</div>
						{task.blockedBy.length > 0 && (
							<p className="quiet">
								Depends on:{' '}
								{task.blockedBy.map((id) => byId.get(id)?.subject ?? 'Unavailable task').join(', ')}
							</p>
						)}
					</li>
				))}
			</ul>
		</section>
	)
}
