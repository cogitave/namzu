// Actual Session.compact entry point used by /compact, applied to the driver's
// real persisted history. No manufactured summary or live model call.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import * as sdk from '../../packages/sdk/dist/index.js';
import { openSessions, resolveConversation, loadConversation, replaceConversation } from '../../packages/cli/dist/integrations/sessions/store.js';
import { createAgentSession, probeAgentSession } from '../../packages/cli/dist/tui/agent.js';

const cwd = process.argv[2];
assert.ok(cwd && process.env.NAMZU_HOME);
const originals = JSON.parse(process.argv[3]);
assert.ok(Array.isArray(originals) && originals.length === 2 && originals.every(s => typeof s === 'string' && s.length > 0));
const sessions = await openSessions(cwd);
const sessionId = await resolveConversation(sessions, 'natural-recall');
const messages = await loadConversation(sessions, sessionId);
const initialRead = messages.find(m => m.role === 'tool' && m.toolCallId === 'initial-read');
assert.ok(initialRead, 'Original read must be visible before compaction.');
const provider = new sdk.MockLLMProvider();
const probe = await probeAgentSession();
sdk.ProviderRegistry.create = () => ({ provider });
const session = await createAgentSession(probe.preferences, probe.detected, {
  cwd, stateRoot: sessions.root, conversationSessions: sessions,
  scope: { sessionId, topicId: sessions.topicId, projectId: sessions.projectId, tenantId: sessions.tenantId },
  sandbox: { enabled: false }, web: { search: 'off' }, memory: { recall: false },
  limits: { maxIterations: 4, tokenBudget: 20_000 },
});
try {
  const compacted = await session.compact(messages);
  assert.ok(compacted && compacted.shed > 0);
  assert.equal(provider.requests.length, 0);
  const initialReadRemoved = !compacted.messages.some(m => m.role === 'tool' && m.toolCallId === 'initial-read');
  const runs = join(sessions.root, 'sessions', sessionId, 'runs');
  let originalToolArchived = false;
  for (const entry of await readdir(runs, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const runDir = join(runs, entry.name);
    const meta = JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8'));
    if (meta.metadata?.agentId !== 'manual-compaction') continue;
    const events = await sdk.readRunEventsIn(runDir, { integrity: 'strict' });
    originalToolArchived ||= events.some(e => e.type === 'compaction_shed' && e.reason === 'manual' &&
      e.messages.some(m => m.role === 'tool' && m.toolCallId === 'initial-read' && m.content === initialRead.content));
  }
  assert.ok(initialReadRemoved && originalToolArchived);
  const visibleOriginalCount = originals.filter(code => JSON.stringify(compacted.messages).includes(code)).length;
  assert.equal(visibleOriginalCount, 0);
  await replaceConversation(sessions, sessionId, compacted.messages);
  console.log(JSON.stringify({ sessionId, beforeMessages: messages.length, afterMessages: compacted.messages.length,
    shed: compacted.shed, initialReadDistance: messages.length - messages.indexOf(initialRead), initialReadRemoved,
    originalToolArchived, visibleOriginalCount, usage: compacted.usage }));
} finally { await session.close(); }
