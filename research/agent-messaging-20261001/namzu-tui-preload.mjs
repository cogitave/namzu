// Scripted transport fixture for two real Namzu TUI processes. Never use for real account traffic.
import { appendFileSync, watch } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
const repo = process.env.NAMZU_PEER_FIXTURE_REPO
const root = process.env.NAMZU_PEER_FIXTURE_ROOT
const role = process.env.NAMZU_PEER_FIXTURE_ROLE
if (!repo || !root || !['sender', 'receiver'].includes(role)) throw new Error('Set fixture repo, root and role.')
const { ProviderRegistry, MockLLMProvider, ProviderError } = await import(pathToFileURL(join(repo, 'packages/sdk/dist/index.js')))
const { CodexProvider } = await import(pathToFileURL(join(repo, 'packages/providers/openai/dist/index.js')))
let held = false
let replied = false
const failPeer = process.env.NAMZU_PEER_FIXTURE_FAIL_PEER === '1'
const mock = new MockLLMProvider({ nextTurn(params) {
  const last = params.messages.filter(m => m.role === 'user' && (!m.source || m.source.kind === 'peer-message')).at(-1)
  const all = JSON.stringify(params.messages)
  if (role === 'receiver') {
    if (last?.source?.kind === 'peer-message' && String(last.content).includes('PEER_HELLO_719')) {
      if (!replied) {
        replied = true
        const target = String(last.content).match(/reply to session "([0-9a-f-]+)"/)?.[1]
        if (!target) throw new Error('peer reply identity missing')
        return {toolCalls:[{id:'peer_reply',name:'send_session_message',args:{target,message:'PEER_ACK_719'}}]}
      }
      return {text:'RECEIVER_REPLIED_719'}
    }
    return {text: all.includes('RECEIVER_BUSY') ? 'ORIGINAL_FINAL_719' : 'RECEIVER_READY_719'}
  }
  if (last?.source?.kind === 'peer-message') return {text:'SENDER_ACK_CONFIRMED_719'}
  const listing = params.messages.find(m => m.role === 'tool' && m.toolCallId === 'peer_list')
  if (!listing) return {toolCalls:[{id:'peer_list',name:'list_sessions',args:{}}]}
  const sent = params.messages.find(m => m.role === 'tool' && m.toolCallId === 'peer_send')
  if (!sent) {
    const content = String(listing.content)
    const start = content.indexOf('['), end = content.lastIndexOf(']')
    const peers = JSON.parse(content.slice(start,end+1))
    const recipient = peers.find(peer => !peer.self && peer.accepts_messages)
    if (!recipient) throw new Error('live receiver missing')
    return {toolCalls:[{id:'peer_send',name:'send_session_message',args:{target:recipient.session_id,message:'PEER_HELLO_719'}}]}
  }
  return {text:'SENDER_HELLO_QUEUED_719'}
}})
ProviderRegistry.create = () => {
  const provider = new CodexProvider({accessToken:'fixture',accountId:'fixture'})
  provider.chatStream = async function* (params) {
    appendFileSync(`${root}/${role}-requests.jsonl`,JSON.stringify({role,messages:params.messages})+'\n')
    const last = params.messages.filter(m => m.role === 'user' && (!m.source || m.source.kind === 'peer-message')).at(-1)
    if (role === 'receiver' && failPeer && last?.source?.kind === 'peer-message') {
      throw new ProviderError({code:'invalid_request',message:'PEER_FAILURE_FIXTURE_719',retryable:false})
    }
    if (role === 'receiver' && last?.content === 'RECEIVER_BUSY' && !held) {
      held = true
      await new Promise(resolve => {
        const watcher = watch(root, (_event, file) => { if (file === 'release') { watcher.close(); resolve() } })
        appendFileSync(`${root}/events.jsonl`,JSON.stringify({event:'busy-request-held'})+'\n')
      })
    }
    yield* mock.chatStream(params)
  }
  provider.listModels = async () => [{id:'gpt-5.6-luna',name:'gpt-5.6-luna'}]
  return {provider,capabilities:provider.capabilities}
}
