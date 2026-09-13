// Controlled inference over an index-pages-cli generated archive; real TUI/tools.
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as sdk from '../../packages/sdk/dist/index.js';

const root = process.env.NAMZU_INDEX_PAGES_ROOT;
assert.ok(root); assert.equal(process.env.NAMZU_HOME, join(root, 'home'));
const report = JSON.parse(await readFile(join(root, 'result.json'), 'utf8'));
const { runId, seq, tracking, destination } = report.seed;
let step = 0;
const parse = text => JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
sdk.ProviderRegistry.create = () => ({ provider: new sdk.MockLLMProvider({ nextTurn: request => {
  step++;
  const tool = request.messages.filter(m=>m.role==='tool').at(-1);
  if(step===1) {
    assert.ok(!JSON.stringify(request.messages).includes(tracking));
    return {toolCalls:[{id:'index-search',name:'search_conversation',args:{query:'DELTA',limit:10}}]};
  }
  const result = parse(String(tool.content));
  if(step===2) {
    const match = result.matches.find(m=>m.runId===runId && m.seq===seq);
    assert.ok(match, 'One public search must reach the original past the partial index.');
    assert.ok(result.scannedBytes<=8*1024*1024 && Buffer.byteLength(JSON.stringify(result.matches))<=12000);
    assert.equal(result.unavailableRuns,0);
    appendFileSync(join(root,'tui-trace.jsonl'),JSON.stringify({step,search:result})+'\n');
    return {toolCalls:[{id:'index-read',name:'read_conversation',args:{runId,seq,part:match.part,byteOffset:match.byteOffset}}]};
  }
  assert.equal(step,3);
  assert.ok(result.text.includes(tracking) && result.text.includes(destination));
  appendFileSync(join(root,'tui-trace.jsonl'),JSON.stringify({step,readContainsOriginals:true})+'\n');
  return {text:`İlk kayıttaki kimlikler: ${tracking} · ${destination}`};
} }) });
