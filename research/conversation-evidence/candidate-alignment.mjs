import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createEvidenceRecallStep, createUserMessage } from '../../packages/sdk/dist/index.js';
import { passageMatcher } from '../../packages/sdk/dist/store/evidence/passages.js';

// Bounded lexical ablation, not a production feature or archive throughput test.
// Term selection, literal discovery and final ranking use built Namzu code.
const scope = { tenantId: randomUUID(), projectId: randomUUID(), sessionId: randomUUID() };
const runId = randomUUID();
const sourceRun = randomUUID();
const cases = [
  {
    id: 'sentence-substring',
    query: 'Search the original DELTA observations in this conversation.',
    noise: 'Packing information is unrelated.',
    target: 'DELTA original observation: receipt A17.',
  },
  {
    id: 'technical-word-substring',
    query: 'What was the DELTA code?',
    noise: 'The decoder completed an unrelated operation.',
    target: 'DELTA code: receipt A17.',
  },
  {
    id: 'single-digit',
    query: '3',
    noise: 'Record 13000 is unrelated.',
    target: 'Record 3: receipt A17.',
  },
  {
    id: 'unicode-name',
    query: 'İZMİR',
    noise: 'İZMİRLİ observations are unrelated.',
    target: 'İZMİR: receipt A17.',
  },
  {
    id: 'underscore-id',
    query: 'id_1',
    noise: 'id_100 is unrelated.',
    target: 'id_1: receipt A17.',
  },
  {
    id: 'common-whole-word',
    query: 'Search the original DELTA observations in this conversation.',
    noise: 'An unrelated item is in a queue.',
    target: 'DELTA original observation: receipt A17.',
  },
];

function context(query) {
  return { runId, messages: [createUserMessage(query)], steps: [], stepNumber: 1, prepared: {} };
}
async function queryTerms(query) {
  let selected;
  const step = createEvidenceRecallStep({
    scope,
    retrieve: async ({ terms }) => {
      selected = terms;
      return { candidates: [], scannedBytes: 0, incomplete: false };
    },
  });
  await step(context(query));
  return selected ?? [];
}
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function aligned(terms) {
  // Only a full-string reference. Real archive windows need authenticated left
  // context before applying this boundary rule at a chunk's first character.
  const regex = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${terms.map(escape).join('|')})(?![\\p{L}\\p{N}_])`, 'iu');
  return text => terms.length > 0 && regex.test(text);
}
function candidates(documents, accepts, limit = 8) {
  return documents.flatMap((excerpt, index) => accepts(excerpt) ? [{
    scope: { ...scope, runId: sourceRun },
    seq: index + 1,
    part: 0,
    source: 'tool_completed',
    toolName: 'read',
    isError: false,
    retained: 'full',
    excerpt,
  }] : []).slice(0, limit);
}
async function render(query, selected, incomplete) {
  const step = createEvidenceRecallStep({
    scope,
    maxPassages: 1,
    retrieve: async () => ({ candidates: selected, scannedBytes: 0, incomplete }),
  });
  const result = await step(context(query));
  const excerpts = (result?.context?.split('\n') ?? [])
    .filter(line => line.startsWith('{"runId":'))
    .map(line => JSON.parse(line).excerpt);
  return { candidateCount: selected.length, targetSelected: excerpts.some(text => text.includes('A17')), excerpts };
}
async function fingerprints() {
  const result = {};
  for (const file of ['run/evidence-recall.js', 'store/evidence/passages.js'])
    result[file] = createHash('sha256').update(await readFile(new URL('../../packages/sdk/dist/' + file, import.meta.url))).digest('hex');
  return result;
}

const buildBefore = await fingerprints();
const trials = [];
for (const scenario of cases) {
  const terms = await queryTerms(scenario.query);
  const documents = Array.from({ length: 8 }, (_, i) => `${scenario.noise} Unique entry ${i}.`).concat(scenario.target);
  const literal = passageMatcher(terms, false);
  const acceptsLiteral = text => literal(text, 0) !== undefined;
  const reduced = terms.filter(term => !['in', 'this'].includes(term.toLowerCase()));
  const stopFiltered = passageMatcher(reduced, false);
  const acceptsReduced = text => reduced.length > 0 && stopFiltered(text, 0) !== undefined;
  const acceptsToken = aligned(terms);
  trials.push({
    ...scenario, terms,
    current: await render(scenario.query, candidates(documents, acceptsLiteral), true),
    extraStopWords: await render(scenario.query, candidates(documents, acceptsReduced), true),
    tokenAlignedPrototype: await render(scenario.query, candidates(documents, acceptsToken), true),
    fullNineDocumentReference: await render(scenario.query, candidates(documents, acceptsLiteral, 24), false),
  });
}
assert.equal(trials.filter(t => t.current.targetSelected).length, 0);
assert.equal(trials.filter(t => t.extraStopWords.targetSelected).length, 2);
assert.equal(trials.filter(t => t.tokenAlignedPrototype.targetSelected).length, 5);
assert.equal(trials.filter(t => t.fullNineDocumentReference.targetSelected).length, 6);
assert.equal(passageMatcher('code', false)('decoder', 0)?.hit, 2); // Explicit literal search remains useful.
const buildAfter = await fingerprints();
assert.deepEqual(buildBefore, buildAfter);
const report = {
  date: '2026-09-12', revision: 'e1b8bc72', method: 'Synthetic bounded candidate-discovery ablation with actual built SDK ranking; no model or archive I/O.',
  buildBefore, buildAfter, trials,
  totals: { cases: 6, current: 0, extraStopWords: 2, tokenAlignedPrototype: 5, fullNineDocumentReference: 6 },
};
await writeFile(new URL('candidate-alignment-results.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report.totals));
