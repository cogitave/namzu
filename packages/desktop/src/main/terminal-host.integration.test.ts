import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { RuntimeClient } from './rpc-client.js'
import { TerminalHostClient } from './terminal-client.js'

/**
 * Both ends of the protocol together: this package's client against the built
 * `namzu acp --desktop` host, which owns a real pseudo-terminal. Waits are on the
 * client's own events; nothing here depends on how fast the machine is.
 */
const cliDist = fileURLToPath(new URL('../../../cli/dist/', import.meta.url))
const entry = join(cliDist, 'bin.js')
let pty = false
if (existsSync(entry)) {
	try {
		const { loadHostPty } = (await import(
			pathToFileURL(join(cliDist, 'terminal/pty.js')).href
		)) as {
			loadHostPty: () => Promise<unknown>
		}
		await loadHostPty()
		pty = true
	} catch {
		pty = false
	}
}

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step()
})

describe.skipIf(!pty || process.platform === 'win32')('host terminals over the real host', () => {
	it('creates, drives, replays, resizes and ends a terminal', async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), 'namzu-terminal-desktop-')))
		cleanup.push(() => rmSync(root, { recursive: true, force: true }))
		mkdirSync(join(root, 'home'))
		const runtime = new RuntimeClient(root, {
			program: process.execPath,
			args: [entry, 'acp', '--desktop'],
			env: { ...process.env, NAMZU_HOME: join(root, 'home'), NAMZU_MODEL_CATALOGUE_REFRESH: '0' },
		})
		cleanup.push(() => runtime.close())
		await runtime.start()
		expect(runtime.supportsTerminals()).toBe(true)

		const terminals = new TerminalHostClient(runtime, { ackEvery: 1 })
		cleanup.push(() => terminals.dispose())
		expect((await terminals.status()).available).toBe(true)

		const info = await terminals.create({
			command: '/bin/sh',
			env: { PS1: 'ready> ' },
			cols: 90,
			rows: 20,
			title: 'Shell',
		})
		expect(info).toMatchObject({ title: 'Shell', cwd: root, cols: 90, rows: 20, status: 'running' })

		let printed = ''
		const waiting: (() => void)[] = []
		terminals.on('data', (note: { data: string }) => {
			printed += note.data
			for (const wake of waiting.splice(0)) wake()
		})
		const exited = new Promise<{ exitCode: number }>((resolve) => terminals.once('exit', resolve))
		const until = async (done: () => boolean) => {
			while (!done()) await new Promise<void>((resolve) => waiting.push(resolve))
		}

		const first = await terminals.attach(info.id, 'main', { writer: true })
		printed = first.data
		await until(() => printed.includes('ready> '))
		await terminals.write(info.id, 'main', 'echo from-the-desktop-$((6*7)); stty size\r')
		await until(() => printed.includes('from-the-desktop-42') && printed.includes('20 90'))

		// A second view attaches late and rebuilds the same screen.
		const late = await terminals.attach(info.id, 'late', { fromOffset: 0 })
		expect(late.mode).toBe('replay')
		expect(late.data).toContain('from-the-desktop-42')
		await expect(terminals.write(info.id, 'late', 'x')).rejects.toThrow(/keyboard/)

		await terminals.resize(info.id, 'main', 120, 40)
		await terminals.write(info.id, 'main', 'stty size\r')
		await until(() => printed.includes('40 120'))

		await terminals.kill(info.id)
		expect((await exited).exitCode).toBeTypeOf('number')
		expect((await terminals.list())[0]?.status).toBe('exited')
		await terminals.close(info.id)
		expect(await terminals.list()).toEqual([])
	}, 60_000)
})
