import { describe, expect, it, vi } from 'vitest'

import { terminalNotificationEnabled, writeTerminalNotification } from './terminal.js'

describe('terminalNotificationEnabled', () => {
	it('keeps absence, false and an empty event list disabled', () => {
		const event = { kind: 'approval-required' } as const
		expect(terminalNotificationEnabled(undefined, event)).toBe(false)
		expect(terminalNotificationEnabled(false, event)).toBe(false)
		expect(terminalNotificationEnabled([], event)).toBe(false)
	})

	it('keeps `true` to the two original events and asks for the idle notice by name', () => {
		const idle = { kind: 'idle-prompt' } as const
		expect(terminalNotificationEnabled(true, idle)).toBe(false)
		expect(terminalNotificationEnabled(['idle-prompt'], idle)).toBe(true)
		expect(terminalNotificationEnabled(['turn-settled'], idle)).toBe(false)
	})

	it('lets true select both events and a list select only the named one', () => {
		const approval = { kind: 'approval-required' } as const
		const settled = { kind: 'turn-settled', outcome: 'completed' } as const
		expect(terminalNotificationEnabled(true, approval)).toBe(true)
		expect(terminalNotificationEnabled(true, settled)).toBe(true)
		expect(terminalNotificationEnabled(['approval-required'], approval)).toBe(true)
		expect(terminalNotificationEnabled(['approval-required'], settled)).toBe(false)
	})
})

describe('writeTerminalNotification', () => {
	it.each([
		[{ kind: 'approval-required' } as const, 'Namzu: approval required'],
		[{ kind: 'turn-settled', outcome: 'completed' } as const, 'Namzu: turn completed'],
		[{ kind: 'turn-settled', outcome: 'stopped' } as const, 'Namzu: turn needs attention'],
		[{ kind: 'turn-settled', outcome: 'failed' } as const, 'Namzu: turn failed'],
	])('writes the exact fixed OSC 9 request for %s', (notification, text) => {
		const write = vi.fn()

		expect(writeTerminalNotification(notification, 'osc9', { isTTY: true, write })).toEqual({
			kind: 'request-sent',
		})
		expect(write).toHaveBeenCalledOnce()
		expect(write).toHaveBeenCalledWith(`\x1b]9;${text}\x07`)
	})

	it('writes the idle notice in the iTerm2 form', () => {
		const write = vi.fn()
		writeTerminalNotification({ kind: 'idle-prompt' }, 'osc9', { isTTY: true, write })
		expect(write).toHaveBeenCalledWith('\x1b]9;Namzu: waiting for your input\x07')
	})

	it("writes kitty's three-part notification under one id", () => {
		const write = vi.fn()
		writeTerminalNotification({ kind: 'idle-prompt' }, 'kitty', { isTTY: true, write })
		const calls = write.mock.calls.map(([data]) => data as string)
		expect(calls).toHaveLength(3)
		const first = calls[0] ?? ''
		const id = first.slice('\x1b]99;i='.length, first.indexOf(':'))
		expect(Number.isInteger(Number(id))).toBe(true)
		expect(first).toBe(`\x1b]99;i=${id}:d=0:p=title;Namzu\x07`)
		expect(calls[1]).toBe(`\x1b]99;i=${id}:p=body;waiting for your input\x07`)
		expect(calls[2]).toBe(`\x1b]99;i=${id}:d=1:a=focus;\x07`)
	})

	it("writes ghostty's OSC 777 notify", () => {
		const write = vi.fn()
		writeTerminalNotification({ kind: 'approval-required' }, 'ghostty', { isTTY: true, write })
		expect(write).toHaveBeenCalledOnce()
		expect(write).toHaveBeenCalledWith('\x1b]777;notify;Namzu;approval required\x07')
	})

	it('writes only BEL when that method is selected', () => {
		const write = vi.fn()

		writeTerminalNotification({ kind: 'approval-required' }, 'bel', { isTTY: true, write })

		expect(write).toHaveBeenCalledWith('\x07')
	})

	it('refuses non-interactive stdout without writing', () => {
		const write = vi.fn()

		expect(
			writeTerminalNotification({ kind: 'approval-required' }, 'osc9', {
				isTTY: false,
				write,
			}),
		).toEqual({ kind: 'unavailable', detail: 'stdout is not an interactive terminal' })
		expect(write).not.toHaveBeenCalled()
	})

	it('reports a write failure without claiming the terminal displayed anything', () => {
		const write = vi.fn(() => {
			throw new Error('stream closed')
		})

		expect(
			writeTerminalNotification({ kind: 'approval-required' }, 'osc9', {
				isTTY: true,
				write,
			}),
		).toEqual({ kind: 'write-failed', detail: 'stream closed' })
	})
})
