import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { MAX_PEER_MESSAGE_TEXT_BYTES } from '@namzu/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { decodePeerInput, readBoundedFile, readBoundedStream } from './peer-input.js'
import { peersCommand } from './peers.js'

const dirs: string[] = []
afterEach(() => {
	vi.restoreAllMocks()
	for (const dir of dirs.splice(0)) removeTempDir(dir)
})

const enc = (text: string) => new TextEncoder().encode(text)

it('decodes text and drops one trailing line break', () => {
	expect(decodePeerInput(enc('sélam\nnext\n\n'))).toEqual({ kind: 'text', text: 'sélam\nnext\n' })
})

it('rejects invalid UTF-8 and NUL', () => {
	expect(decodePeerInput(new Uint8Array([0x68, 0xff, 0xfe]))).toMatchObject({ kind: 'invalid' })
	expect(decodePeerInput(enc('a\0b'))).toMatchObject({ kind: 'invalid' })
})

it('refuses input over the limit but accepts exactly the limit', () => {
	expect(decodePeerInput(enc('a'.repeat(MAX_PEER_MESSAGE_TEXT_BYTES)))).toMatchObject({
		kind: 'text',
	})
	expect(decodePeerInput(enc('a'.repeat(MAX_PEER_MESSAGE_TEXT_BYTES + 1)))).toEqual({
		kind: 'too-large',
	})
})

it('stops reading a stream one byte past the limit', async () => {
	let produced = 0
	const endless = Readable.from(
		(function* () {
			for (;;) {
				produced += 1024
				yield Buffer.alloc(1024, 97)
			}
		})(),
	)
	const bytes = await readBoundedStream(endless)
	expect(bytes.byteLength).toBe(MAX_PEER_MESSAGE_TEXT_BYTES + 1)
	expect(produced).toBeLessThan(MAX_PEER_MESSAGE_TEXT_BYTES * 2)
	endless.destroy()
})

it('treats a terminal as no input', async () => {
	const tty = Object.assign(Readable.from([]), { isTTY: true })
	expect((await readBoundedStream(tty)).byteLength).toBe(0)
})

it('reads at most one byte past the limit from a file', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'pi-'))
	dirs.push(dir)
	const file = join(dir, 'big.txt')
	writeFileSync(file, 'a'.repeat(MAX_PEER_MESSAGE_TEXT_BYTES * 3))
	expect((await readBoundedFile(file)).byteLength).toBe(MAX_PEER_MESSAGE_TEXT_BYTES + 1)
})

function run(rawArgs: string[]) {
	const errors: string[] = []
	const out: string[] = []
	vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
		out.push(String(chunk))
		return true
	}) as never)
	const ctx = {
		formatter: { error: (e: { message: string }) => errors.push(e.message), print: () => {} },
		config: { permissionSettings: undefined },
	}
	return peersCommand
		.handler({ ctx, rawArgs } as never)
		.then((code) => ({ code, errors, out: out.join('') }))
}

it('exits 64 for a blank message and 66 for an unreadable file', async () => {
	expect((await run(['send', 't', ''])).code).toBe(64)
	const missing = await run(['send', 't', '--file', '/nonexistent/namzu-peer-input'])
	expect(missing.code).toBe(66)
})

it('exits 65 for a binary file and 64 for an empty file', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'pi-'))
	dirs.push(dir)
	const bin = join(dir, 'bin')
	writeFileSync(bin, Buffer.from([0x61, 0x00, 0x62]))
	const empty = join(dir, 'empty')
	writeFileSync(empty, '\n')
	expect((await run(['send', 't', '--file', bin])).code).toBe(65)
	expect((await run(['send', 't', '--file', empty])).code).toBe(64)
})

it('prints errors as one JSON object with --json', async () => {
	const bad = await run(['send', '--json'])
	expect(bad.code).toBe(64)
	expect(JSON.parse(bad.out)).toMatchObject({ exit: 64 })
	expect(bad.errors).toEqual([])
	const blank = await run(['send', 't', ' ', '--json'])
	expect(JSON.parse(blank.out)).toMatchObject({ error: expect.any(String), exit: 64 })
})
