#!/usr/bin/env python3
"""Build private reference solutions without modifying the model's workspace."""
import argparse
from pathlib import Path
import shutil

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("output_dir", type=Path, help="Directory previously populated by build-fixture.py")
args = parser.parse_args()
root = args.output_dir.resolve() / "private"
base = root / "baseline-workspace"
if not (root / "preservation.json").is_file() or not base.is_dir() or base.is_symlink():
    parser.error("output_dir does not contain a generated private baseline")
for name in ("reference-base", "reference-steered"):
    if (root / name).exists() or (root / name).is_symlink():
        parser.error(f"refusing to overwrite private reference: {name}")
for name,steered in [('reference-base',False),('reference-steered',True)]:
    target=root/name
    shutil.copytree(base,target)
    p=target/'src/identity.mjs'; p.write_text(p.read_text().replace('return key','return JSON.stringify([tenant, key])'))
    p=target/'src/retry.mjs'; p.write_text(p.read_text().replace('attempts <= policy.maxAttempts','attempts < policy.maxAttempts'))
    p=target/'src/accounting.mjs'; p.write_text(p.read_text().replace('job.workMs = durationMs','job.workMs += durationMs'))
    p=target/'src/queue.mjs'; text=p.read_text().replace('job.readyAt = startedAt + retryDelay','job.readyAt = finishedAt + retryDelay')
    if steered:
        text=text.replace('  async function runDue(handler) {', '''  function cancel(tenant, key) {
    const job = jobs.get(jobIdentity(tenant, key))
    if (!job || !['queued', 'retrying', 'running'].includes(job.status)) return false
    job.status = 'cancelled'
    job.readyAt = null
    return true
  }
  async function runDue(handler) {''')
        text=text.replace('      if (failure === undefined) {', "      if (job.status === 'cancelled') {\n        job.readyAt = null\n      } else if (failure === undefined) {")
        text=text.replace('return { enqueue, get, list, runDue }','return { enqueue, get, list, runDue, cancel }')
    p.write_text(text)
print('Private base/steered reference copies created; model workspace unchanged.')
