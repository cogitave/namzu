import { createHash } from 'node:crypto';
import { appendFile } from 'node:fs/promises';

// Record a whitelist of structural facts at the actual fetch boundary. Never
// save headers, cookies, account IDs, opaque reasoning or arbitrary request text.
export function summarizeRecallWire(body, original, replacement) {
  const instructions = String(body.instructions ?? '');
  const flags = text => ({
    availability: text.includes('"status":"unavailable"'),
    invalidPlan: text.includes('INVALID_QUERY_PLAN_CONTROL'),
    genericFilesystemRecovery: text.includes('Read a specific window with `read` (offset/limit) or search it with `grep`.'),
    hostRecovery: text.includes('host-authorized retained-output'),
    originals: Object.values(original).map(code => text.includes(code)),
    replacements: Object.values(replacement).map(code => text.includes(code)),
  });
  return {
    model: body.model,
    effort: body.reasoning?.effort,
    toolChoice: body.tool_choice,
    instructions: {
      chars: instructions.length,
      sha256: createHash('sha256').update(instructions).digest('hex'),
      conversationGuidance: instructions.includes('## Conversation evidence'),
      historicalSourceGuidance: instructions.includes('Match the source to the time the question asks about.'),
      scopedRecoveryGuidance: instructions.includes('Recover its contents through search_conversation and read_conversation'),
      ...flags(instructions),
    },
    tools: (body.tools ?? []).map(tool => ({
      name: tool.name ?? tool.type,
      descriptionChars: String(tool.description ?? '').length,
      historicalSourceGuidance: String(tool.description ?? '').includes('current workspace search cannot establish past contents'),
    })),
    input: (body.input ?? []).map(item => {
      // Deliberately exclude all reasoning items, including encrypted content.
      const value = item.content ?? item.output;
      const text = item.type === 'reasoning' ? '' : typeof value === 'string' ? value :
        Array.isArray(value) ? value.map(block => typeof block.text === 'string' ? block.text : '').join('\n') : '';
      return { type: item.type, role: item.role, name: item.name, chars: text.length, ...flags(text) };
    }),
  };
}

export function observeRecallWire(path, original, replacement) {
  const fetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.origin === 'https://chatgpt.com' && url.pathname === '/backend-api/codex/responses') {
      const text = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
      if (typeof text !== 'string') throw new Error('Expected a JSON Responses body for the wire probe.');
      await appendFile(path, JSON.stringify({ phase: process.env.NAMZU_NATURAL_PHASE, ...summarizeRecallWire(JSON.parse(text), original, replacement) }) + '\n');
    }
    return fetch(input, init);
  };
}
