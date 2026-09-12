import { appendFile, mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { RunDiskStore } from '../../packages/sdk/dist/index.js';

const root = await mkdtemp(join(tmpdir(), 'namzu-evidence-append-cost-'));
const count = 500;
const rows = [];
for (let round = 0; round < 5; round++) {
  for (const mode of round % 2 ? ['linked', 'baseline'] : ['baseline', 'linked']) {
    const runId = randomUUID();
    const baseDir = join(root, `${round}-${mode}`);
    const store = new RunDiskStore({ baseDir });
    const dir = mode === 'linked' ? await store.initRun(runId) : join(baseDir, runId);
    await mkdir(dir, { recursive: true });
    const path = join(dir, 'transcript.jsonl');
    const started = performance.now();
    for (let i = 0; i < count; i++) {
      const event = i === 0 ? { type: 'run_started', runId, seq: 1 }
        : { type: 'message_completed', runId, seq: i + 1, content: 'x'.repeat(512) };
      if (mode === 'linked') await store.appendEvent(event);
      else await appendFile(path, `${JSON.stringify({ ...event, timestamp: Date.now() })}\n`, 'utf-8');
    }
    rows.push({ round, mode, events: count, milliseconds: performance.now() - started, bytes: (await stat(path)).size });
  }
}
const report = { root, node: process.version, platform: process.platform, rows };
await writeFile(join(root, 'result.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
