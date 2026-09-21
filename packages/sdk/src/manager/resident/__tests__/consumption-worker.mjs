import { open, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DiskResidentAgenda, inspectResidentConsumption } from '../../../../dist/index.js'

const [root, tenantId, pursuitId, mode] = process.argv.slice(2)
const agenda = new DiskResidentAgenda(root, {tenantId, agentKey: 'consumption-process'})
const state = await agenda.read()
if (!state) throw new Error('Missing process fixture agenda.')
process.once('message', async () => {
  try {
    if (mode === 'admit') {
      const pursuit = state.pursuits.find(p => p.id === pursuitId)
      if (!pursuit) throw new Error('Missing pursuit.')
      const claim = await agenda.execution(pursuitId).claim(pursuit.state, Date.now())
      const receipt = {sessionId: randomUUID(), turnId: randomUUID(), ownTokens: 120, treeTokens: 180, ownCostUsd: null,
        unpricedOwnTokens: null, usageFinal: false, cleanup: 'unknown', verification: 'unconfirmed'}
      await writeFile(join(root, `${claim.claimId}.json`), JSON.stringify(receipt))
      process.send({claim})
      // Parent kills this exact worker after the partial receipt is durable.
      setInterval(() => {}, 1000)
    } else {
      const report = await inspectResidentConsumption(agenda.activity(state.revision), {
        maxReadBytes: 4096,
        async resolve(admission) {
          const path = join(root, `${admission.claimId}.json`)
          const file = await open(path, 'r')
          try {
            const stat = await file.stat()
            if (!stat.isFile() || stat.size > 4096) throw new Error('Fixture receipt exceeds its bound.')
            const bytes = Buffer.alloc(stat.size)
            const {bytesRead} = await file.read(bytes, 0, bytes.length, 0)
            if (bytesRead !== bytes.length) throw new Error('Short fixture receipt.')
            return JSON.parse(bytes.toString('utf8'))
          } finally { await file.close() }
        },
      })
      process.send({report}, () => process.exit(0))
    }
  } catch (error) {
    process.send({error: String(error)}, () => process.exit(1))
  }
})
process.send('ready')
