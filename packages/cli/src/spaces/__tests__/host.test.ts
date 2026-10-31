import { describe, expect, it } from 'vitest'
import type { FakePty } from '../../terminal/__tests__/support/fake-pty.js'
import { SpacesHost } from '../host.js'
import { DEFAULT_PREFIX } from '../prefix.js'
import { setup } from './support/harness.js'

describe('SpacesHost', () => {
	it('starts one child with the host environment, sized to the main area, and shows the sidebar', async () => {
		const t = setup()
		t.host.start()
		expect(t.spawned).toHaveLength(1)
		const pty = t.spawned[0] as FakePty
		expect(pty.file).toBe('node')
		expect(pty.options.env).toEqual({ A: '1' })
		expect(pty.options).toMatchObject({ cols: 74, rows: 30, cwd: '/work/namzu' })
		expect(t.state.raw).toBe(true)
		pty.print('hello from the child')
		await t.frame()
		const lines = await t.screen()
		expect(lines[0]).toContain('spaces')
		expect(lines.join('\n')).toContain('1 namzu')
		expect(lines[0]).toContain('hello from the child')
	})

	it('sends keys to the child and keeps the prefix for itself', () => {
		const t = setup()
		t.host.start()
		const pty = t.spawned[0] as FakePty
		t.type('ls\r')
		t.type('\x02')
		t.type('j')
		expect(pty.writes).toEqual(['ls\r'])
	})

	it('sends one literal ctrl+b to the child when it is pressed twice', () => {
		const t = setup()
		t.host.start()
		const pty = t.spawned[0] as FakePty
		t.type('\x02\x02')
		expect(pty.writes).toEqual(['\x02'])
	})

	it('shows the navigate hints while navigating', async () => {
		const t = setup()
		t.host.start()
		t.type('\x02')
		await t.frame()
		expect((await t.screen()).join('\n')).toContain('j/k session')
		t.type('\x1b')
		await t.frame()
		expect((await t.screen()).join('\n')).toContain('ctrl+b to navigate')
	})

	it('resizes the child to the main area when the terminal changes, and when the sidebar is hidden', async () => {
		const t = setup()
		t.host.start()
		const pty = t.spawned[0] as FakePty
		t.output.columns = 80
		t.output.rows = 20
		for (const l of t.resizeListeners) l()
		expect(pty.resizes.at(-1)).toEqual({ cols: 59, rows: 20 })
		t.type('\x02')
		t.type('b')
		expect(pty.resizes.at(-1)).toEqual({ cols: 80, rows: 20 })
		await t.frame()
		expect((await t.screen()).join('\n')).not.toContain('spaces')
		t.type('q')
		await t.frame()
		expect((await t.screen()).join('\n')).toContain('Quit all sessions?')
	})

	it('answers the child terminal queries through its own emulator', async () => {
		const t = setup()
		t.host.start()
		const pty = t.spawned[0] as FakePty
		pty.print('\x1b[6n')
		await t.frame()
		expect(pty.writes).toEqual(['\x1b[1;1R'])
	})

	it('asks the real terminal for bracketed paste only while the child wants it', async () => {
		const t = setup()
		t.host.start()
		const pty = t.spawned[0] as FakePty
		pty.print('\x1b[?2004h')
		await t.frame()
		expect(t.written.join('')).toContain('\x1b[?2004h')
		pty.print('\x1b[?2004l')
		await t.frame()
		expect(t.written.join('')).toContain('\x1b[?2004l')
	})

	it('greys the row and says so when the child stops, without stopping the host', async () => {
		const t = setup()
		t.host.start()
		const pty = t.spawned[0] as FakePty
		pty.print('working')
		pty.end(1)
		await t.frame()
		const text = (await t.screen()).join('\n')
		expect(text).toContain('This session stopped. Its conversation is saved.')
		expect(text).toContain('Leave with ctrl+b q')
		// Typing, resizing and waiting for it no longer reach the dead pseudo-terminal.
		t.type('abc')
		t.output.columns = 90
		for (const l of t.resizeListeners) l()
		expect(pty.writes).toEqual([])
		expect(pty.resizes).toEqual([])
	})

	it('survives a pseudo-terminal that throws when written or resized after it is gone', () => {
		const t = setup()
		t.host.start()
		const pty = t.spawned[0] as FakePty
		pty.write = () => {
			throw new Error('EBADF')
		}
		pty.resize = () => {
			throw new Error('EBADF')
		}
		expect(() => t.type('x')).not.toThrow()
		t.output.columns = 90
		expect(() => {
			for (const l of t.resizeListeners) l()
		}).not.toThrow()
	})

	it('shows a plain message when the child could not start', async () => {
		const t = setup()
		const host = new SpacesHost({
			input: { on: () => undefined, off: () => undefined },
			output: t.output,
			binding: {
				spawn: () => {
					throw new Error('spawn failed')
				},
			},
			spec: () => ({ file: 'node', args: [], cwd: '/x', env: {} }),
			folder: { cwd: '/x', name: 'x' },
			prefix: DEFAULT_PREFIX,
			schedule: () => () => undefined,
		})
		host.start()
		await host.render()
		expect(t.written.join('')).toContain('could not start')
	})

	it('asks before quitting a live session, then hangs it up and leaves the terminal', async () => {
		const t = setup()
		t.host.start()
		const pty = t.spawned[0] as FakePty
		t.type('\x02')
		t.type('q')
		await t.frame()
		expect((await t.screen()).join('\n')).toContain('Quit all sessions?')
		t.type('n')
		expect(pty.kills).toEqual([])
		t.type('q')
		t.type('y')
		expect(pty.kills).toEqual(['SIGHUP'])
		pty.end(0, 1)
		await expect(t.host.done).resolves.toBe(0)
		expect(t.state.raw).toBe(false)
		expect(t.written.join('')).toContain('\x1b[?1049l')
		expect(t.dataListeners.size).toBe(0)
	})

	it('quits at once when the session has already ended', async () => {
		const t = setup()
		t.host.start()
		;(t.spawned[0] as FakePty).end(0)
		t.type('\x02')
		t.type('q')
		await expect(t.host.done).resolves.toBe(0)
	})

	it('ends a session that ignores the hang-up when the grace period passes', async () => {
		const t = setup()
		t.host.start()
		const pty = t.spawned[0] as FakePty
		t.host.quit()
		const grace = t.timers.find((x) => x.ms >= 1000)
		expect(grace).toBeDefined()
		;(grace as { run: () => void }).run()
		await expect(t.host.done).resolves.toBe(0)
		expect(pty.kills).toEqual(['SIGHUP', 'SIGKILL'])
	})
	it('survives a drawing error, keeps drawing afterwards, and closes if it keeps failing', async () => {
		const t = setup()
		t.host.start()
		const write = t.output.write
		;(t.spawned[0] as FakePty).print('first\r\n')
		t.output.write = () => {
			throw new Error('closed pipe')
		}
		await expect(t.host.render()).resolves.toBeUndefined()
		t.output.write = write
		await t.frame()
		expect((await t.screen()).join('\n')).toContain('Could not redraw')
		t.output.write = () => {
			throw new Error('closed pipe')
		}
		for (let i = 0; i < 3; i++) {
			;(t.spawned[0] as FakePty).print(`line ${i}\r\n`)
			await t.host.render()
		}
		t.output.write = write
		expect((t.spawned[0] as FakePty).kills).toEqual(['SIGHUP'])
	})

	it('hands the terminal back when the process exits without a clean close', () => {
		const t = setup()
		t.host.start()
		process.emit('exit', 0)
		expect(t.state.raw).toBe(false)
		expect(t.written.join('')).toContain('\x1b[?1049l')
		expect((t.spawned[0] as FakePty).kills).toEqual(['SIGHUP'])
	})
})
