import type { ThreadState } from '../shared/projection.js'
import { CheckIcon, ChevronRightIcon } from './icons.js'
import { Button } from './ui/button.js'
import './conversation-tasks.css'

const labels = {
	pending: 'Pending',
	in_progress: 'In progress',
	completed: 'Completed',
	failed: 'Failed',
}
export function TasksProgress({ thread, onOpen }: { thread: ThreadState; onOpen: () => void }) {
	if (!thread.tasks.length && !thread.tasksNotice) return null
	const completed = thread.tasks.filter((task) => task.status === 'completed').length
	const failed = thread.tasks.filter((task) => task.status === 'failed').length
	return (
		<Button variant="ghost-muted" size="sm" className="tasks-progress" onClick={onOpen}>
			<CheckIcon aria-hidden="true" />
			<span>
				{thread.tasks.length ? `Tasks · ${completed}/${thread.tasks.length} completed` : 'Tasks'}
			</span>
			{failed > 0 && <span className="tasks-failed">{failed} failed</span>}
			{thread.tasksNotice && <span>Unavailable</span>}
			<ChevronRightIcon aria-hidden="true" />
		</Button>
	)
}
/** Planning status is authored by the agent; it does not certify an output passed QA. */
export function ConversationTasks({
	thread,
	palName,
}: { thread: Pick<ThreadState, 'tasks' | 'tasksNotice'>; palName?: string }) {
	if (!thread.tasks.length && !thread.tasksNotice) return null
	const byId = new Map(thread.tasks.map((task) => [task.taskId, task]))
	return (
		<section
			aria-label={palName ? `${palName} tasks` : 'Conversation tasks'}
			className="conversation-tasks"
			tabIndex={palName ? -1 : undefined}
		>
			<h3>Tasks</h3>
			<p className="quiet">
				{palName
					? `${palName}’s plan for this conversation.`
					: 'The agent’s plan for this conversation.'}
			</p>
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
