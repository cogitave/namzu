import { DiskResidentStore } from '../../../../dist/index.js'

const [root, tenantId] = process.argv.slice(2)
const store = new DiskResidentStore(root, { tenantId, agentKey: 'process-check' })
const snapshot = await store.read()
process.once('message', async () => {
  try {
    await store.claim(snapshot, Date.now())
    process.send('claimed', () => process.exit(0))
  } catch (error) {
    process.send(error.name, () => process.exit(0))
  }
})
process.send('ready')
