import { afterEach } from 'vitest'
import { fakeBinding } from '../../../terminal/__tests__/support/fake-pty.js'
import { HeadlessScreen } from '../../../terminal/screen.js'
import { WorkspacesHost } from '../../host.js'
import { DEFAULT_PREFIX } from '../../prefix.js'

const opened: { close: () => void }[] = []

// Every host adds a listener to the process's exit; closing them keeps those from piling up.
afterEach(() => {
	for (const item of opened.splice(0)) item.close()
})

export function setup(
	size = { columns: 100, rows: 30 },
	extra: Partial<ConstructorParameters<typeof WorkspacesHost>[0]> = {},
) {
	const { binding, spawned } = fakeBinding()
	const written: string[] = []
	const resizeListeners = new Set<() => void>()
	const dataListeners = new Set<(chunk: string | Buffer) => void>()
	const timers: { run: () => void; ms: number; live: boolean }[] = []
	const state = { raw: false }
	const output = {
		columns: size.columns,
		rows: size.rows,
		write: (data: string) => void written.push(data),
		on: (_e: 'resize', l: () => void) => void resizeListeners.add(l),
		off: (_e: 'resize', l: () => void) => void resizeListeners.delete(l),
	}
	const input = {
		on: (_e: 'data', l: (c: string | Buffer) => void) => void dataListeners.add(l),
		off: (_e: 'data', l: (c: string | Buffer) => void) => void dataListeners.delete(l),
		setRawMode: (raw: boolean) => {
			state.raw = raw
		},
	}
	const host = new WorkspacesHost({
		input,
		output,
		binding,
		spec: ({ cwd }) => ({
			file: 'node',
			args: ['bin.js'],
			cwd,
			env: { A: '1' },
		}),
		folder: { cwd: '/work/namzu', name: 'namzu' },
		prefix: DEFAULT_PREFIX,
		colors: 'truecolor',
		// No test reads a real repository; the ones about branches pass their own lookup.
		git: () => Promise.resolve(undefined),
		isDirectory: (path) => path.startsWith('/work/'),
		homeDirectory: '/home/me',
		kill: (pty, signal) => pty.kill(signal),
		schedule: (run, ms) => {
			const timer = { run, ms, live: true }
			timers.push(timer)
			return () => {
				timer.live = false
			}
		},
		// No test reaches a real clipboard tool, whatever machine runs it.
		clipboard: {
			platform: 'linux',
			which: () => null,
			exists: () => false,
			kernelVersion: () => '',
		},
		...extra,
	})
	opened.push({
		close: () => {
			host.quit()
			for (const pty of spawned) (pty as unknown as { end(code?: number): void }).end(0)
		},
	})
	/** Fires every pending frame timer and waits for the paint. */
	const frame = async () => {
		for (const t of timers.filter((x) => x.live && x.ms < 1000)) {
			t.live = false
			t.run()
		}
		await host.render()
	}
	/** Fires the pending timers that were set for exactly `ms`. */
	const tick = (ms: number) => {
		for (const t of timers.filter((x) => x.live && x.ms === ms)) {
			t.live = false
			t.run()
		}
	}
	/** What the real terminal shows after everything written to it so far. */
	const screen = async () => {
		const shown = new HeadlessScreen(output.columns, output.rows, 0)
		shown.write(written.join(''))
		await shown.settled()
		return shown.lines()
	}
	/** The cell at a position of what the real terminal shows, for colours. */
	const cellAt = async (x: number, y: number) => {
		const shown = new HeadlessScreen(output.columns, output.rows, 0)
		shown.write(written.join(''))
		await shown.settled()
		return shown.cells().cell(x, y)
	}
	const type = (chunk: string) => {
		for (const l of dataListeners) l(chunk)
	}
	return {
		host,
		spawned,
		written,
		output,
		input,
		state,
		timers,
		frame,
		tick,
		cellAt,
		screen,
		type,
		resizeListeners,
		dataListeners,
	}
}
