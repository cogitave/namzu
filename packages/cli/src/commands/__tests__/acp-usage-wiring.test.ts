import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'

/**
 * The usage feed belongs to the desktop host only. The shared ACP mode must
 * never build one, and the desktop's feed is closed when the process shuts down.
 */

const created: Array<{ close: ReturnType<typeof vi.fn> }> = []
vi.mock('../desktop-usage-feed.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../desktop-usage-feed.js')>()
	return {
		...actual,
		createUsageFeed: (options: Parameters<typeof actual.createUsageFeed>[0]) => {
			const feed = actual.createUsageFeed(options)
			const close = vi.fn(() => feed.close())
			created.push({ close })
			return { observe: feed.observe, close }
		},
	}
})

let root: string
beforeEach(() => {
	created.length = 0
	root = mkdtempSync(join(tmpdir(), 'namzu-acp-usage-wiring-'))
	mkdirSync(join(root, 'state'))
	vi.stubEnv('NAMZU_HOME', join(root, 'state'))
})
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	removeTempDir(root)
})

async function runUntilStdinEnds(desktop: boolean): Promise<void> {
	const { runAcpCommand } = await import('../acp.js')
	const ctx = {
		config: {},
		formatter: { name: 'text', print() {}, info() {}, error() {} },
	} as unknown as Parameters<typeof runAcpCommand>[0]
	const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
	try {
		const done = runAcpCommand(ctx, desktop)
		// Wait for the process to hold on stdin (its own close listener), then end the stream.
		await vi.waitFor(() => expect(process.stdin.listenerCount('close')).toBeGreaterThan(0))
		process.stdin.emit('end')
		await done
		const frames = write.mock.calls.map((call) => String(call[0]))
		expect(frames.some((line) => line.includes('namzu/session/usage'))).toBe(false)
	} finally {
		write.mockRestore()
	}
}

it('does not build a usage feed for the shared ACP mode', async () => {
	await runUntilStdinEnds(false)
	expect(created).toHaveLength(0)
})

it('builds one usage feed for the desktop and closes it at shutdown', async () => {
	await runUntilStdinEnds(true)
	expect(created).toHaveLength(1)
	expect(created[0]?.close).toHaveBeenCalledTimes(1)
})
