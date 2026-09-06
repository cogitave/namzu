import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import type { ToolContext } from '../../../types/tool/index.js'
import { BashTool } from '../bash.js'

function survivors(token: string): number[] {
	// argv carries a per-test UUID. A fresh process-table check also prevents
	// failure cleanup from signalling a PID which has since been reused.
	const result = spawnSync('pgrep', ['-f', token], { encoding: 'utf8' })
	if (result.error) throw result.error
	return result.stdout
		.split('\n')
		.map((pid) => Number.parseInt(pid, 10))
		.filter((pid) => Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid)
}

function killSurvivors(token: string): void {
	for (const pid of survivors(token)) {
		try {
			process.kill(pid, 'SIGKILL')
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
		}
	}
}

async function within<T>(pending: Promise<T>, timeoutMs: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			pending,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error('process observation deadline')), timeoutMs)
			}),
		])
	} finally {
		if (timer !== undefined) clearTimeout(timer)
	}
}

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

describe.skipIf(process.platform === 'win32')('host bash owns its shell descendants', () => {
	it.each([
		{ stop: 'abort', stubborn: false, escaped: false },
		{ stop: 'timeout', stubborn: false, escaped: false },
		{ stop: 'abort', stubborn: true, escaped: false },
		{ stop: 'timeout', stubborn: true, escaped: false },
		{ stop: 'abort', stubborn: false, escaped: true },
		{ stop: 'timeout', stubborn: false, escaped: true },
		{ stop: 'maxBuffer', stubborn: true, escaped: false },
	])(
		'settles after $stop (ignores TERM: $stubborn, escaped session: $escaped)',
		async ({ stop, stubborn, escaped }) => {
			const dir = mkdtempSync(join(tmpdir(), 'namzu-bash-cancel-'))
			const token = `namzu-bash-owned-${randomUUID()}`
			const caller = new AbortController()
			let running: ReturnType<typeof BashTool.execute> | undefined
			try {
				let tool = BashTool
				if (stop === 'maxBuffer') {
					vi.stubEnv('NAMZU_BASH_MAX_BUFFER_BYTES', '256')
					vi.resetModules()
					tool = (await import('../bash.js')).BashTool
				}
				writeFileSync(
					join(dir, 'leaf.cjs'),
					[
						"const fs = require('node:fs')",
						...(stubborn ? ["process.on('SIGTERM', () => {})"] : []),
						"fs.writeFileSync('ready', 'ready')",
						"process.stdout.write('descendant ready\\n')",
						...(stop === 'maxBuffer'
							? [
									"setInterval(() => { if (fs.existsSync('overflow')) { fs.unlinkSync('overflow'); process.stdout.write('x'.repeat(300)) } }, 20)",
								]
							: []),
						'setInterval(() => {}, 1000)',
						// Independent failure containment if the observer itself crashes.
						'setTimeout(() => process.exit(0), 12000)',
					].join('\n'),
				)
				writeFileSync(
					join(dir, 'parent.cjs'),
					[
						"const { spawn } = require('node:child_process')",
						`spawn(process.execPath, ['leaf.cjs', process.argv[2]], { stdio: 'inherit', detached: ${escaped} })`,
						'setInterval(() => {}, 1000)',
						'setTimeout(() => process.exit(0), 12000)',
					].join('\n'),
				)
				running = tool.execute(
					{
						// Keep a real shell parent instead of permitting tail-call exec.
						command: `${quote(process.execPath)} parent.cjs ${quote(token)}; true`,
						timeout: stop === 'timeout' ? 1000 : 8000,
					},
					{ workingDirectory: dir, abortSignal: caller.signal } as ToolContext,
				)
				const readyDeadline = Date.now() + 2000
				while (!existsSync(join(dir, 'ready'))) {
					if (Date.now() >= readyDeadline) throw new Error('descendant startup deadline')
					await sleep(20)
				}
				expect(survivors(token).length).toBeGreaterThanOrEqual(3)
				if (stop === 'abort') caller.abort(new Error('operator stopped'))
				if (stop === 'maxBuffer') writeFileSync(join(dir, 'overflow'), 'go')
				const result = await within(running, 6500)
				expect(result.success).toBe(false)
				if (stop === 'timeout') {
					expect(result.data).toMatchObject({ timedOut: true })
					expect(result.output).toContain('descendant ready')
				}
				if (stop === 'maxBuffer') {
					expect(result.error).toContain('stdout maxBuffer length exceeded')
					expect(result.data).toMatchObject({ timedOut: false })
					expect(result.output).toContain('descendant ready')
				}
				if (escaped) {
					// Group signalling does not own a deliberately separate session;
					// its inherited pipes must still stop holding the cancelled call.
					expect(survivors(token)).toHaveLength(1)
				} else {
					expect(survivors(token), 'a descendant survived after bash settled').toEqual([])
				}
			} finally {
				vi.unstubAllEnvs()
				caller.abort()
				killSurvivors(token)
				await within(
					Promise.resolve(running).catch(() => {}),
					2000,
				)
				removeTempDir(dir)
			}
		},
		12_000,
	)
})
