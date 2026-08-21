/**
 * The notification config is useful only if the default CLI action carries it
 * across the dynamic TUI boundary. The parser has its own tests; this one owns
 * the otherwise-unobserved hop from the resolved config to `launchTui`.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveTrustedProjectContext } from '../config/trusted-project-context.js'
import type { TuiContext } from '../tui/types.js'

const launchTui = vi.hoisted(() => vi.fn(async (_ctx: TuiContext) => {}))

vi.mock('../tui/index.js', () => ({ launchTui }))

const { runCli } = await import('../cli.js')

describe('terminal notification config reaches the TUI', () => {
	const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')

	afterEach(() => {
		launchTui.mockClear()
		vi.restoreAllMocks()
		if (originalIsTTY) Object.defineProperty(process.stdout, 'isTTY', originalIsTTY)
		else Reflect.deleteProperty(process.stdout, 'isTTY')
	})

	it('passes the exact event filter and method through the default CLI action', async () => {
		const cwd = mkdtempSync(join(tmpdir(), 'namzu-tui-notification-'))
		writeFileSync(
			join(cwd, 'namzu.config.json'),
			JSON.stringify({
				tui: { notifications: ['approval-required'], notificationMethod: 'bel' },
			}),
		)
		vi.spyOn(process, 'cwd').mockReturnValue(cwd)
		Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })

		await expect(runCli({ argv: ['node', 'namzu'] })).resolves.toBe(0)

		expect(launchTui).toHaveBeenCalledOnce()
		const bootstrap = launchTui.mock.calls[0]![0]
		expect(bootstrap).not.toHaveProperty('tui')
		expect(resolveTrustedProjectContext(bootstrap, cwd)).toEqual(
			expect.objectContaining({
				cwd,
				tui: {
					notifications: ['approval-required'],
					notificationMethod: 'bel',
				},
			}),
		)
	})
})
