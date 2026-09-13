// Real interactive host and tools, deterministic transport; no vendor inference.
import assert from 'node:assert/strict'
import { appendFile } from 'node:fs/promises'
import { MockLLMProvider, ProviderRegistry } from '../../packages/sdk/dist/index.js'

const trace = process.env.NAMZU_FILTER_TRACE
const runId = process.env.NAMZU_FILTER_SOURCE_RUN
assert.ok(trace && runId, 'Supply a temporary trace and an authorized fixture run with retrieval copies')
ProviderRegistry.create = () => {
  const provider = new MockLLMProvider({ turns: [
    { toolCalls: [{ id: 'originals', name: 'search_conversation', args: { query: 'ORCHID', runId, limit: 20 } }] },
    { toolCalls: [{ id: 'retrievals', name: 'search_conversation', args: { query: 'ORCHID', runId, limit: 20, includeRetrievalResults: true } }] },
    { text: 'Verified: original-record search omits retrieval copies; explicit inspection can still retrieve them.' },
  ] })
  const stream = provider.chatStream.bind(provider)
  let step = 0
  provider.chatStream = async function* (params) {
    if (step > 0) {
      const last = params.messages.filter(message => message.role === 'tool').at(-1)
      const content = typeof last?.content === 'string' ? last.content
        : (last?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n')
      const result = JSON.parse(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1))
      assert.ok(result.matches.length > 0)
      const copies = result.matches.filter(match => ['search_conversation', 'read_conversation'].includes(match.toolName) && match.isError === false)
      if (step === 1) {
        assert.equal(copies.length, 0)
        assert.ok(result.excludedToolResults > 0)
      } else assert.ok(copies.length > 0)
      await appendFile(trace, JSON.stringify({ step, result }) + '\n')
    }
    step++
    yield* stream(params)
  }
  return { provider }
}
