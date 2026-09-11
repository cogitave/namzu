import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DiskResidentAgenda, deliverResidentMessage } from '../../../../dist/index.js'

const [root, tenantId, assignedId] = process.argv.slice(2)
const agenda = new DiskResidentAgenda(root, { tenantId, agentKey: 'outbox-process-check' })
const initial = await agenda.read()
let firstRead = true
const deliveryStore = {
  read: async () => {
    if (!firstRead) return agenda.read()
    firstRead = false
    return initial
  },
  claimMessage: agenda.claimMessage.bind(agenda),
  settleMessage: agenda.settleMessage.bind(agenda),
}
process.once('message', async () => {
  try {
    const result = await deliverResidentMessage(
      deliveryStore,
      async (message) => {
        const effect = { id: message.id, receiptId: `fixture-receipt:${message.id}` }
        await appendFile(join(root, 'delivered.jsonl'), `${JSON.stringify(effect)}\n`)
        process.send({ event: 'effect', id: message.id })
        // Stay alive through IPC until the parent kills us after observing the effect.
        process.on('message', () => undefined)
        await new Promise(() => {})
      },
      {
        signal: new AbortController().signal,
        gate: (message) => message.id === assignedId
          ? { allow: true }
          : { allow: false, nextCheckAt: null, reason: 'Assigned to the other process.' },
      },
    )
    process.send({ event: result.status, reason: result.reason }, () => process.exit(0))
  } catch (error) {
    process.send({ event: 'error', error: String(error) }, () => process.exit(1))
  }
})
process.send({ ready: assignedId, sending: initial.outbox.filter((message) => message.phase === 'sending').length })
