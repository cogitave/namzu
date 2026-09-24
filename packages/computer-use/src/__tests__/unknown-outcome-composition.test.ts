import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	type ToolContext,
	ToolRegistry,
	createComputerUseTool,
	generateSessionId,
	generateTurnId,
} from '@namzu/sdk'
import { describe, expect, it } from 'vitest'
import { SubprocessComputerUseHost } from '../SubprocessComputerUseHost.js'
import type { Adapter } from '../adapters/types.js'
import { runCommandOrThrow } from '../util/spawn.js'

/** Only its IHDR is read: a capture that already fits is passed through undecoded. */
function pngHeader(width: number, height: number): Buffer {
	const header = Buffer.alloc(33)
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0)
	header.writeUInt32BE(width, 16)
	header.writeUInt32BE(height, 20)
	return header
}

function makeContext(workingDirectory: string): ToolContext {
	return {
		sessionId: generateSessionId(),
		turnId: generateTurnId(),
		workingDirectory,
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
	}
}

describe('computer-use unknown-outcome composition', () => {
	it('reports a real post-effect non-zero exit as unsafe to replay through ToolRegistry', async () => {
		const root = await mkdtemp(join(tmpdir(), 'namzu-computer-use-unknown-'))
		const marker = join(root, 'desktop-changed.txt')
		let clicks = 0
		const adapter: Adapter = {
			capabilities: Object.freeze({
				displayServer: 'x11',
				screenshot: true,
				mouse: true,
				keyboard: true,
				cursorPosition: true,
				clipboard: true,
			}),
			async getDisplayGeometry() {
				return { width: 1920, height: 1080, scaleFactor: 1 }
			},
			async execute(action) {
				if (action.type === 'screenshot')
					return {
						type: 'screenshot',
						result: {
							data: pngHeader(800, 600),
							mimeType: 'image/png',
							width: 800,
							height: 600,
						},
					}
				clicks += 1
				await runCommandOrThrow(process.execPath, [
					'-e',
					'require("node:fs").writeFileSync(process.argv[1], "clicked"); process.exit(7)',
					marker,
				])
				return { type: 'ok' }
			},
		}

		try {
			const host = new SubprocessComputerUseHost({ adapter })
			const registry = new ToolRegistry()
			registry.register(createComputerUseTool(host, { settleMs: 0 }))

			// Coordinates are pixels of a screenshot: take one first.
			expect(
				(await registry.execute('computer_use', { type: 'screenshot' }, makeContext(root))).success,
			).toBe(true)
			const result = await registry.execute(
				'computer_use',
				{ type: 'mouse_click', at: { x: 50, y: 60 }, button: 'left' },
				makeContext(root),
			)

			expect(await readFile(marker, 'utf8')).toBe('clicked')
			expect(clicks).toBe(1)
			expect(result.success).toBe(false)
			expect(result.error).toMatch(/outcome is unknown/i)
			expect(result.error).toMatch(/do not automatically retry/i)
			expect(result.data).toMatchObject({
				code: 'computer_use_outcome_unknown',
				action: 'mouse_click',
				outcome: 'unknown',
				retrySafety: 'unsafe',
				timedOut: false,
				exitCode: 7,
			})
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})
})
