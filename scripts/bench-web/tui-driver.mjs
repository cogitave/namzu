// Runs INSIDE the sandbox: drives the real TUI in a pseudo-terminal and keeps screens and the raw output.
// usage: node tui-driver.mjs <out dir> <project dir> <first msg file> [follow-up file]
// env: CLI (path of the CLI's bin.js), TURN_LIMIT_S, IDLE_S, SNAP_S, CLI_ARGS
// env: TURN_LIMIT_S (per turn, default 600), IDLE_S (quiet seconds that end a turn, default 30), SNAP_S (default 20), CLI_ARGS (space separated)
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
const req = createRequire(join(dirname(process.env.CLI), '..', 'package.json'))
const { spawn } = req('@lydell/node-pty')
const { Terminal } = req('@xterm/headless')
const [out, proj, f1, ...fs] = process.argv.slice(2)
const num = (k, d) => Number(process.env[k] ?? d)
const TURN = num('TURN_LIMIT_S', 600) * 1000, IDLE = num('IDLE_S', 30) * 1000, SNAP = num('SNAP_S', 20) * 1000
const COLS = 120, ROWS = 40
mkdirSync(join(out, 'screens'), { recursive: true })
const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 5000, allowProposedApi: true })
let raw = '', lastData = Date.now(), exited = null, n = 0
const text = () => { const b = term.buffer.active; const l = []; for (let i = 0; i < b.length; i++) l.push(b.getLine(i)?.translateToString(true) ?? ''); return l.join('\n').replace(/\n+$/, '') }
const snap = (tag) => { writeFileSync(join(out, 'screens', String(++n).padStart(3, '0') + '-' + tag + '.txt'), text()) }
const args = [process.env.CLI, '--dangerously-skip-permissions', ...(process.env.CLI_ARGS ? process.env.CLI_ARGS.split(' ').filter(Boolean) : [])]
const first = readFileSync(f1, 'utf8').trim()
const pty = spawn(process.execPath, [...args, '--message', first], { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: proj, env: { PATH: process.env.PATH, HOME: process.env.HOME, TERM: 'xterm-256color', ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH } : {}), ...(process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY } : {}), ...(process.env.XAUTHORITY ? { XAUTHORITY: process.env.XAUTHORITY } : {}) } })
pty.onData((d) => { raw += d; lastData = Date.now(); term.write(d) })
pty.onExit((e) => { exited = e })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function typeSlow(s) { for (let i = 0; i < 60 && !/Type a message/.test(text().split('\n').slice(-8).join('\n')); i++) await sleep(1000); await sleep(1000); for (const ch of s) { pty.write(ch); await sleep(25) } await sleep(300); pty.write('\r') }
async function waitTurn(tag) {
  const t0 = Date.now(); let nextSnap = t0 + SNAP; let sawWork = false
  while (!exited && Date.now() - t0 < TURN) {
    await sleep(1000)
    const scr = text(); const vp = scr.split('\n').slice(-ROWS).join('\n')
    if (/y trust this folder/.test(vp)) { pty.write('y'); await sleep(2500); lastData = Date.now() }
    else if (/Start in bypass mode\? \[y\/N\]/.test(vp) && !/Type a message/.test(vp)) { pty.write('y\r'); await sleep(3000); lastData = Date.now() }
    if (Date.now() >= nextSnap) { snap(tag + '-t' + Math.round((Date.now() - t0) / 1000)); nextSnap += SNAP }
    const composer = /Type a message/.test(scr.split('\n').slice(-8).join('\n'))
    if (Date.now() - t0 > 15000 && Date.now() - lastData > IDLE && (composer || Date.now() - lastData > 3 * IDLE)) break
  }
  snap(tag + (exited ? '-exited' : Date.now() - t0 >= TURN ? '-timeout' : '-idle'))
}
await sleep(4000)
await waitTurn('turn1')
for (let i = 0; i < fs.length && !exited; i++) { await typeSlow(readFileSync(fs[i], 'utf8').trim()); await waitTurn('turn' + (i + 2)) }
if (!exited) { pty.write('\x03'); await sleep(800); pty.write('\x03'); await sleep(1500) }
writeFileSync(join(out, 'raw.txt'), raw)
writeFileSync(join(out, 'final-screen.txt'), text())
writeFileSync(join(out, 'driver-result.json'), JSON.stringify({ exited, ms: Date.now() }))
try { pty.kill() } catch {}
process.exit(0)
