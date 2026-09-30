// Optional live probe; only the configured public anonymous model is called.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
const repo = resolve(process.argv[2] ?? '.')
const root = await mkdtemp(join(tmpdir(), 'namzu-desktop-live-zen-'))
const project = join(root, 'project'); const state = join(root, 'state')
await mkdir(join(project, '.git'), { recursive: true }); await mkdir(state)
await writeFile(join(state, 'preferences.json'), JSON.stringify({ version: 3, providers: [{ id: 'zen', model: 'space-bunny-free' }], subagents: { active: [] } }))
await writeFile(join(project, 'namzu.config.json'), JSON.stringify({ sandbox: { enabled: false }, limits: { timeoutMs: 120000 } }))
const env = { ...process.env, NAMZU_HOME: state }
for (const name of ['OPENCODE_API_KEY', 'OPENCODE_ZEN_API_KEY', 'OPENCODE_GO_API_KEY']) delete env[name]
const child = spawn(process.execPath, [join(repo, 'packages/cli/dist/bin.js'), 'exec', '--cwd', project, '--provider', 'zen', '--model', 'space-bunny-free', '--max-iterations', '4', '--token-budget', '20000', '--permission-mode', 'strict', '--trust', '--json', 'Reply exactly NAMZU_LIVE_ZEN_OK. Do not use any tools.'], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] })
let output = ''; let diagnostic = ''
child.stdout.on('data', (chunk) => { output += chunk }); child.stderr.on('data', (chunk) => { diagnostic += chunk })
const [exitCode, signal] = await once(child, 'close')
await writeFile(join(root, 'stdout.jsonl'), output); await writeFile(join(root, 'stderr.log'), diagnostic)
const frames = output.trim().split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return { type: 'unframed' } } })
const done = frames.findLast((frame) => frame.type === 'done' || frame.kind === 'done')
const errors = frames.filter((frame) => frame.type === 'error' || frame.kind === 'error')
console.log(JSON.stringify({ root, provider: 'zen', model: 'space-bunny-free', anonymous: true, exitCode, signal, types: [...new Set(frames.map((frame) => frame.type ?? frame.kind))], done, errors }))

assert.equal(exitCode, 0)
assert.equal(done?.stopReason, 'end_turn')
assert.equal(done?.text, 'NAMZU_LIVE_ZEN_OK')
assert.deepEqual(errors, [])
