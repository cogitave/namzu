// An owned local protocol fixture: no provider, credentials, computer or external effects.
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
const workspace = process.env.FIXTURE_PAL_WORKSPACE
const pal = { id: 'one', name: 'One', purpose: '', revision: 1, workspace, model: null, paused: false, createdAt: '2026-10-05', updatedAt: '2026-10-05' }
const required = ['namzu/project/status', 'namzu/project/trust', 'namzu/conversations/list', 'namzu/conversations/history', 'namzu/providers/status', 'namzu/providers/select', 'namzu/jobs/list', 'namzu/jobs/read', 'namzu/jobs/stop']
const pals = ['namzu/pals/list', 'namzu/pals/get', 'namzu/pals/create', 'namzu/pals/update', 'namzu/pals/conversations/list', 'namzu/pals/conversations/claim', 'namzu/pals/computer/status', 'namzu/pals/computer/start', 'namzu/pals/computer/stop', 'namzu/pals/computer/screen']
const communication = ['peers', 'inbox', 'permissions/update', 'subscriptions/list', 'subscriptions/create', 'subscriptions/disable'].map((method) => `namzu/pals/communication/${method}`)
let outgoing = { revision: 0, enabled: false, allowWake: false }
const incoming = { revision: 0, enabled: false, allowWake: false }
let subscriptions = []
const sessions = []
const sources = [{ palId: 'one', name: 'One', conversations: [{ id: 'original-one', title: 'Original One plan', profileRevision: 1 }] }, { palId: 'two', name: 'Two', conversations: [{ id: 'original-two', title: 'Original Two plan', profileRevision: 2 }] }]
const send = (value) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`)
const lines = createInterface({ input: process.stdin })
lines.on('close', () => process.exit(0))
lines.on('line', (line) => {
  const { id, method, params = {} } = JSON.parse(line)
  const reply = (result) => send({ id, result })
  const error = () => send({ id, error: { code: -32000, message: 'Fixture conflict PRIVATE' } })
  if (method === 'initialize') reply({ agentInfo: { name: 'namzu' }, extensions: [...required, ...pals, ...(process.env.FIXTURE_NO_COMMUNICATION ? [] : communication)] })
  else if (method === 'namzu/project/status') reply({ trusted: true, ...(process.cwd() === workspace ? { pal } : {}) })
  else if (method === 'namzu/pals/get') reply(pal)
  else if (method === 'namzu/pals/list') reply([pal])
  else if (method === 'namzu/pals/conversations/list') reply(sessions.map((id) => ({ id, title: 'Chat', updatedAt: '2026-10-05' })))
  else if (method === 'session/new') { const sessionId = randomUUID(); sessions.push(sessionId); reply({ sessionId }) }
  else if (method === 'namzu/pals/conversations/claim') reply({ sessionId: params.sessionId, palId: 'one', revision: 1 })
  else if (method === 'session/load') reply({ sessionId: params.sessionId })
  else if (method === 'namzu/conversations/list') reply([])
  else if (method === 'namzu/conversations/history') reply({ messages: [], partial: false })
  else if (method === 'namzu/providers/status') reply({ available: [], selected: null })
  else if (method === 'namzu/jobs/list') reply([])
  else if (method === communication[0]) reply({ v: 1, palId: params.palId, peers: [{ palId: 'two', name: 'Two', paused: false, outgoing, incoming, secret: 'PRIVATE' }] })
  else if (method === communication[1]) reply({ v: 1, palId: params.palId, messages: [{ id: 'message-one', status: 'pending', sourceKind: 'pal', sourcePalId: 'two', body: 'PRIVATE' }] })
  else if (method === communication[2]) {
    if (params.peerPalId !== 'two' || params.expectedRevision !== outgoing.revision) { error(); return }
    outgoing = { revision: outgoing.revision + 1, enabled: params.enabled, allowWake: params.allowWake }
    reply({ v: 1, palId: params.palId, peerPalId: 'two', permission: outgoing })
  } else if (method === communication[3]) reply({ v: 1, palId: params.palId, subscriptions, sources })
  else if (method === communication[4]) {
    const subscription = { v: 1, id: randomUUID(), revision: 1, configurationRevision: 1, sourcePalId: params.sourcePalId, sourceConversationId: params.sourceSessionId, sourceProfileRevision: params.sourcePalId === 'two' ? 2 : 1, recipientPalId: params.recipientPalId, enabled: true, permission: { revision: 1, observe: true, disclose: true, receive: true, wake: params.wake }, progress: { lastSequence: null } }
    subscriptions.push(subscription)
    reply({ v: 1, palId: params.palId, subscription })
  } else if (method === communication[5]) {
    const row = subscriptions.find((row) => row.id === params.id)
    if (!row || row.revision !== params.expectedRevision) { error(); return }
    const next = { ...row, enabled: false, revision: row.revision + 1, configurationRevision: row.configurationRevision + 1 }
    subscriptions = subscriptions.map((row) => row.id === next.id ? next : row)
    reply({ v: 1, palId: params.palId, subscription: next })
  } else if (method === 'test/exit') process.exit(0)
  else reply({})
})
