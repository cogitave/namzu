import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeRecallWire } from './observe-recall-wire.mjs';

test('reads text strings and Responses content blocks without persisting arbitrary text or reasoning', () => {
  const hidden = 'NEVER_PERSIST_SECRET';
  const availability = 'Conversation evidence availability:\n{"status":"unavailable"}';
  const body = {
    model: 'fixture', instructions: hidden, headers: { authorization: hidden },
    tools: [{ name: 'search_conversation', description: hidden }],
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: availability }, { type: 'input_image', image_url: hidden }] },
      { type: 'function_call_output', output: availability },
      { type: 'reasoning', content: availability, encrypted_content: hidden },
    ],
  };
  const summary = summarizeRecallWire(body, { tracking: 'ORIGINAL' }, { tracking: 'REPLACEMENT' });
  assert.deepEqual(summary.input.map(item => item.availability), [true, true, false]);
  assert.equal(JSON.stringify(summary).includes(hidden), false);
  assert.equal(summary.input[2].chars, 0);
});
