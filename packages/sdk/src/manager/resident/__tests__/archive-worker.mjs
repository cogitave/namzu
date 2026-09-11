import { DiskResidentAgenda } from '../../../../dist/index.js'

const [root, tenantId, messageId, mode] = process.argv.slice(2)
const agenda = new DiskResidentAgenda(root, { tenantId, agentKey: 'archive-process-check' })
const snapshot = await agenda.read()
if (!snapshot) throw new Error('Archive fixture is missing.')
process.once('message', async () => {
  try {
    if (mode === 'duplicate') {
      const archived = await agenda.listArchived()
      const message = archived.entries.flatMap((entry) => entry.messages).find((item) => item.id === messageId)
      if (!message) throw new Error('Archived message is missing.')
      const result = await agenda.enqueueMessage(snapshot, message)
      const current = await agenda.read()
      process.send({ result: result.phase, active: current.outbox?.length ?? 0 }, () => process.exit(0))
    } else {
      await agenda.archive(snapshot, { messageIds: [messageId] })
      process.send({ result: 'archived' }, () => process.exit(0))
    }
  } catch (error) {
    process.send({ result: error?.name, error: String(error) }, () => process.exit(0))
  }
})
process.send('ready')
