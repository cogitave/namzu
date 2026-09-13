// Reuse a generated natural-cli case's actual compacted history. --prepare
// restores only its pre-question projection; archives remain immutable.
import assert from 'node:assert/strict';
import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as sdk from '../../packages/sdk/dist/index.js';
import { openSessions, loadConversation, replaceConversation } from '../../packages/cli/dist/integrations/sessions/store.js';

const root = process.env.NAMZU_SUMMARY_TUI_ROOT;
const failPlan = process.env.NAMZU_SUMMARY_TUI_FAIL_PLAN === '1';
assert.ok(root);
assert.equal(process.env.NAMZU_HOME, join(root, 'home'));
const result = JSON.parse(await readFile(join(root, 'result.json'), 'utf8'));
const sessionId = result.compaction.sessionId;
const originals = Object.values(result.original);
const question = result.turns.find(t => t.phase === 2).prompt;
if (process.argv[2] === '--prepare') {
  const sessions = await openSessions(join(root, 'workspace'));
  const messages = await loadConversation(sessions, sessionId);
  const index = messages.findIndex(m => m.role === 'user' && m.content === question);
  assert.ok(index > 0);
  const compacted = messages.slice(0, index);
  assert.equal(compacted.length, result.compaction.afterMessages);
  assert.ok(compacted.some(m => m.source?.type === 'compaction-summary'));
  assert.ok(originals.every(value => !JSON.stringify(compacted).includes(value)));
  await replaceConversation(sessions, sessionId, compacted);
  console.log(JSON.stringify({ sessionId, question, messages: compacted.length }));
} else {
  sdk.ProviderRegistry.create = () => ({ provider: new sdk.MockLLMProvider({ nextTurn: request => {
    const planner = String(request.messages[0]?.content).startsWith('Resolve a conversation-history search query.');
    if (planner) {
      const input = JSON.parse(String(request.messages[1].content));
      if (failPlan) return { text: 'INVALID_QUERY_PLAN_CONTROL' };
      const row = input.history.find(m => m.source === 'compaction-summary');
      assert.ok(row && row.text.includes('DELTA'));
      assert.ok(originals.every(value => !JSON.stringify(input).includes(value)));
      const delta = input.tokens.find(([, value]) => value === 'DELTA');
      return { text: JSON.stringify({ mode: 'contextual', time: 'past', termIds: [delta[0]], focusIds: [delta[0]], basis: [{ message: row.message, quote: 'DELTA' }] }) };
    }
    const contexts = request.messages.filter(m => m.source?.type === 'runtime-context' && m.source.kind === 'step-context');
    assert.ok(originals.every(value => JSON.stringify(contexts).includes(value)));
    assert.ok(originals.every(value => !JSON.stringify(request.messages.filter(m => !contexts.includes(m))).includes(value)));
    assert.ok(contexts.map(m => m.content).join('\n').includes(failPlan ? '"fallback":"literal_query"' : 'compaction-summary'));
    assert.ok(!JSON.stringify(request.messages).includes('INVALID_QUERY_PLAN_CONTROL'));
    return { text: `Arşivdeki ilk kayıt: ${originals.join(' · ')}` };
  } }) });
  // Assertions live in the provider; trace the final main request without source text.
  const create = sdk.ProviderRegistry.create;
  sdk.ProviderRegistry.create = (...args) => {
    const created = create(...args);
    const stream = created.provider.chatStream.bind(created.provider);
    created.provider.chatStream = async function* (params) {
      await appendFile(join(root, 'summary-tui-trace.jsonl'), JSON.stringify({ planner: String(params.messages[0]?.content).startsWith('Resolve a conversation-history search query.'), messages: params.messages.length }) + '\n');
      yield* stream(params);
    };
    return created;
  };
}
