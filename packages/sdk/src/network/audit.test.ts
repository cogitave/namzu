import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { createFileAuditSink, textHash } from './audit.js'

const dirs: string[] = []
afterEach(() => {
	for (const d of dirs.splice(0)) removeTempDir(d)
})
const dir = () => {
	const d = mkdtempSync(join(tmpdir(), 'namzu-net-audit-'))
	dirs.push(d)
	return d
}

describe('audit sink', () => {
	it('appends one private JSON line per entry and never the text', async () => {
		const d = dir()
		const sink = createFileAuditSink({ dir: d })
		const secret = 'the launch code is 0000'
		await sink.append({
			at: 1,
			event: 'mail_accepted',
			machine: { id12: 'abc', name: 'desk' },
			textHash: textHash(secret),
			bytes: secret.length,
		})
		await sink.append({ at: 2, event: 'mail_held', reason: 'modes differ' })
		const raw = readFileSync(join(d, 'audit.jsonl'), 'utf8')
		expect(raw.trim().split('\n')).toHaveLength(2)
		expect(raw).not.toContain('launch code')
		expect(textHash(secret)).toHaveLength(16)
		if (process.platform !== 'win32')
			expect(statSync(join(d, 'audit.jsonl')).mode & 0o777).toBe(0o600)
	})

	it('rotates once at the limit', async () => {
		const d = dir()
		const sink = createFileAuditSink({ dir: d, rotateBytes: 50 })
		for (let i = 0; i < 4; i++) await sink.append({ at: i, event: 'network_on' })
		expect(statSync(join(d, 'audit.1.jsonl')).size).toBeGreaterThan(0)
	})

	it('reports a failed write once and does not throw', async () => {
		const d = dir()
		const messages: string[] = []
		const sink = createFileAuditSink({
			dir: join(d, 'file-not-dir', 'x'),
			report: (m) => messages.push(m),
		})
		const { writeFileSync } = await import('node:fs')
		writeFileSync(join(d, 'file-not-dir'), 'x')
		await sink.append({ at: 1, event: 'network_on' })
		await sink.append({ at: 2, event: 'network_on' })
		expect(messages).toHaveLength(1)
	})
})
