/**
 * The native helper's watch, client side: what is asked of the helper and how
 * its answers are read. The helper is a fake that answers with the lines of
 * `conformance/namzu-win/`, which the Rust side is held to as well.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { NativeChannel } from '../native/process.js'
import { type NativeOp, NativeProtocolError, decodeReply } from '../native/protocol.js'
import { NativeWatch } from '../native/watch.js'

const vectors = JSON.parse(
	readFileSync(
		fileURLToPath(new URL('../../../../conformance/namzu-win/protocol.json', import.meta.url)),
		'utf8',
	),
) as { replies: { name: string; op: string; wire: Record<string, unknown> }[] }

function vector(name: string): Record<string, unknown> {
	const found = vectors.replies.find((r) => r.name === name)
	if (!found) throw new Error(`no vector named ${name}`)
	return found.wire
}

class FakeHelper implements NativeChannel {
	readonly requests: Record<string, any>[] = []
	answers: Record<string, Record<string, unknown>> = {
		hello: {
			ok: true,
			version: '0.1.0',
			buildHash: 'abc',
			arch: 'x86_64',
			osBuild: '26100',
			caps: ['watch', 'uia'],
			dpiAwareness: 'perMonitorV2',
		},
		'watch.start': vector('watch.start, controls and foreground'),
		'watch.poll': vector('watch.poll, a session'),
		'watch.stop': vector('watch.stop'),
	}
	private line: ((line: string) => void) | undefined
	write(line: string): void {
		const request = JSON.parse(line) as Record<string, any>
		this.requests.push(request)
		const answer = this.answers[request.op]
		if (answer) this.line?.(JSON.stringify({ ...answer, id: request.id }))
	}
	onLine(handler: (line: string) => void): void {
		this.line = handler
	}
	onExit(): void {}
	kill(): void {}
	ops(): string[] {
		return this.requests.map((r) => r.op)
	}
}

function watch(fake: FakeHelper): NativeWatch {
	return new NativeWatch({ executable: 'namzu-win.exe', spawnHelper: () => fake })
}

describe('NativeWatch', () => {
	it('starts with the options it was given and says what came up', async () => {
		const fake = new FakeHelper()
		const w = watch(fake)
		expect(w.running).toBe(false)
		const got = await w.start({ kinds: ['invoke', 'value'], coalesceMs: 300, maxQueue: 500 })
		expect(fake.ops()).toEqual(['hello', 'watch.start'])
		expect(fake.requests[1]).toMatchObject({
			op: 'watch.start',
			kinds: ['invoke', 'value'],
			coalesceMs: 300,
			maxQueue: 500,
		})
		expect(got.controls).toBe(true)
		expect(got.kinds).toContain('value')
		expect(w.running).toBe(true)
		await w.dispose()
	})

	it('reports that the controls are not watched instead of failing', async () => {
		const fake = new FakeHelper()
		fake.answers['watch.start'] = vector('watch.start, controls unavailable')
		const got = await watch(fake).start()
		expect(got).toMatchObject({ controls: false, foreground: true })
	})

	it('refuses a helper that has no watch, without sending the request', async () => {
		const fake = new FakeHelper()
		fake.answers.hello = { ...fake.answers.hello, caps: ['monitor'] }
		await expect(watch(fake).start()).rejects.toThrow(/cannot watch/)
		expect(fake.ops()).not.toContain('watch.start')
	})

	it('polls what happened and how many events were not kept', async () => {
		const fake = new FakeHelper()
		const w = watch(fake)
		await w.start()
		const got = await w.poll()
		expect(got.dropped).toBe(3)
		expect(got.events.map((e) => e.kind)).toEqual([
			'app',
			'focus',
			'value',
			'menu',
			'invoke',
			'value',
			'window',
		])
		expect(got.events[2]).toMatchObject({ role: 'Edit', value: 'overdue invoices' })
		expect(got.events[5]).toMatchObject({ secure: true })
		expect(got.events[5]?.value).toBeUndefined()
	})

	it('stops once and is quiet the second time', async () => {
		const fake = new FakeHelper()
		const w = watch(fake)
		await w.start()
		await w.stop()
		await w.stop()
		expect(fake.ops().filter((o) => o === 'watch.stop')).toHaveLength(1)
		expect(w.running).toBe(false)
	})
})

describe('watch replies', () => {
	const poll = (events: unknown[]): string =>
		JSON.stringify({ id: 1, ok: true, events, dropped: 0 })

	it('refuses a secure field that carries text, whatever a helper sent', () => {
		expect(() =>
			decodeReply(
				'watch.poll' as NativeOp,
				poll([{ kind: 'value', tMs: 1, role: 'Edit', secure: true, value: 'hunter2' }]),
			),
		).toThrow(NativeProtocolError)
	})

	it('has no kind for a key or a mouse button', () => {
		for (const kind of ['key', 'keystroke', 'keyboard', 'click', 'mouse', 'button']) {
			expect(() => decodeReply('watch.poll', poll([{ kind, tMs: 1 }]))).toThrow(NativeProtocolError)
		}
	})
})
