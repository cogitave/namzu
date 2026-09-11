import { InMemorySessionStore } from '../memory.js'
import { sessionStoreContract } from './session-store-contract.js'

sessionStoreContract('InMemorySessionStore', () => new InMemorySessionStore())
