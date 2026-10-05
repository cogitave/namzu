// Owned stdio fixture only: no credentials, provider, computer or external effects.
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
const methods = ['namzu/project/status', 'namzu/project/trust', 'namzu/conversations/list', 'namzu/conversations/history', 'namzu/providers/status', 'namzu/providers/select', 'namzu/jobs/list', 'namzu/jobs/read', 'namzu/jobs/stop']
if (!process.env.FIXTURE_NO_TASKS) methods.push('namzu/tasks/list')
const row = (taskId, status = 'pending') => ({ taskId, subject: `Plan ${taskId}`, status, blockedBy: [] })
const tasks = new Map([
  ['cold-session', [row('first', 'in_progress'), row('second', 'failed')]],
  ['other-session', [row('other')]],
])
const send = (frame) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`)
const reply = (id, result) => send({ id, result })
const notify = (params) => {
  const rows = tasks.get(params.sessionId) ?? []
  if (params.task?.taskId) {
    const next = rows.filter((task) => task.taskId !== params.task.taskId)
    if (!params.deleted) next.push(params.task)
    tasks.set(params.sessionId, next)
  }
  send({ method: 'namzu/tasks/update', params })
}
const pending = new Map()
const lines = createInterface({ input: process.stdin })
lines.on('close', () => process.exit(0))
lines.on('line', (line) => {
  const { id, method, params } = JSON.parse(line)
  if (!method) {
    const prompt = pending.get(id)
    if (!prompt) return
    pending.delete(id)
    send({ method: 'session/update', params: { sessionId: prompt.sessionId, update: { kind: 'turn_ended', stopReason: 'end_turn' } } })
    reply(prompt.id, { stopReason: 'end_turn' })
  } else if (method === 'initialize') reply(id, { agentInfo: { name: 'namzu' }, extensions: methods, promptOptions: true, receivedCapabilities: params.capabilities })
  else if (method === 'namzu/project/status') reply(id, { cwd: process.cwd(), trusted: true })
  else if (method === 'namzu/conversations/list') reply(id, ['cold-session', 'other-session'].map((id) => ({ id, title: id, updatedAt: '2026-10-05' })))
  else if (method === 'namzu/conversations/history') reply(id, { messages: [{ role: 'user', text: 'Existing plan' }], partial: false })
  else if (method === 'namzu/tasks/list') reply(id, { tasks: tasks.get(params.sessionId) ?? [] })
  else if (method === 'namzu/providers/status') reply(id, { available: [], selected: null })
  else if (method === 'session/load') reply(id, { sessionId: params.sessionId })
  else if (method === 'session/new') { const sessionId = randomUUID(); tasks.set(sessionId, []); reply(id, { sessionId }) }
  else if (method === 'session/prompt') {
    if (params.prompt === 'Finish') { reply(id, { stopReason: 'end_turn' }); return }
    const requestId = `review-${id}`
    pending.set(requestId, { id, sessionId: params.sessionId })
    send({ id: requestId, method: 'session/request_permission', params: { sessionId: params.sessionId, toolCalls: [] } })
  } else if (method === 'session/cancel') {
    for (const [key, prompt] of pending) if (prompt.sessionId === params.sessionId) { pending.delete(key); reply(prompt.id, { stopReason: 'cancelled' }) }
    reply(id, {})
  } else if (method === 'test/task') { notify(params); reply(id, {}) }
  else if (method === 'test/exit') process.exit(0)
  else reply(id, {})
})
