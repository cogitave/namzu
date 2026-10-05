import { readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises'
import { posix } from 'node:path'
import { encode } from 'fast-png'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalSandboxProvider } from '../sandbox/provider/local.js'
import type { MessageAttachment } from '../types/message/index.js'
import type { Sandbox } from '../types/sandbox/index.js'
import type { ToolContext } from '../types/tool/index.js'
import { generateSessionId, generateTurnId } from '../utils/id.js'
import { NOOP_LOGGER } from '../utils/log/create-logger.js'
import {
	createPalReferenceImageTool,
	importPalReferenceImages,
	preparePalReferenceImages,
} from './reference-images.js'

function image(value = 120): MessageAttachment {
	return {
		type: 'image',
		mediaType: 'image/png',
		data: Buffer.from(
			encode({
				width: 2,
				height: 2,
				channels: 3,
				depth: 8,
				data: new Uint8Array(12).fill(value),
			}),
		).toString('base64'),
	}
}

describe('Pal reference image preflight', () => {
	it('keeps original bytes, attachment positions and inputs unchanged', () => {
		const attachments: readonly MessageAttachment[] = Object.freeze([
			Object.freeze({
				type: 'document',
				mediaType: 'application/pdf',
				data: 'irrelevant',
			}),
			Object.freeze(image()),
		])
		const originals = structuredClone(attachments)
		const references = preparePalReferenceImages(attachments)
		expect(references).toHaveLength(1)
		expect(references[0]?.attachmentIndex).toBe(2)
		expect(references[0]?.data).toBe((attachments[1] as { data: string }).data)
		expect(references[0]?.sha256).toMatch(/^[a-f0-9]{64}$/)
		expect(attachments).toEqual(originals)
		expect(Object.isFrozen(references)).toBe(true)
	})

	it.each([
		{
			type: 'image',
			mediaType: 'image/png',
			data: 'https://example.com/reference.png',
		},
		{
			type: 'image',
			mediaType: 'image/png',
			data: 'data:image/png;base64,aGVsbG8=',
		},
		{ type: 'image', mediaType: 'image/png', data: 'aGVsbG8=' },
		{
			type: 'image',
			mediaType: 'image/jpeg',
			data: (image() as { data: string }).data,
		},
		{
			type: 'stored',
			kind: 'image',
			mediaType: 'image/png',
			ref: 'private-image',
		},
	])(
		'refuses unresolved or mismatched raster input without fallback: $type $mediaType',
		(input) => {
			expect(() => preparePalReferenceImages([image(), input as MessageAttachment])).toThrow()
		},
	)

	it('refuses oversized and excessive batches before guest I/O', () => {
		expect(() =>
			preparePalReferenceImages([
				image(),
				{
					type: 'image',
					mediaType: 'image/png',
					data: 'A'.repeat(4 * 1024 * 1024 + 4),
				},
			]),
		).toThrow('bytes')
		expect(() => preparePalReferenceImages(Array.from({ length: 9 }, () => image()))).toThrow(
			'at most 8',
		)
	})

	it('refuses a missing guest instead of reading or writing a host file', async () => {
		const tool = createPalReferenceImageTool({
			attachments: () => [image()],
			assertCurrentAdmission: vi.fn(),
		})
		const result = await tool.execute({}, {} as ToolContext)
		expect(result.success).toBe(false)
		expect(result.error).toContain('admitted Pal computer')
		expect(tool.permissions).toEqual(['file_write'])
		expect(tool.isReadOnly?.({})).toBe(false)
	})

	it('refuses a direct tool write in plan mode before consulting its attachment closure', async () => {
		const attachments = vi.fn(() => [image()])
		const assertCurrentAdmission = vi.fn()
		const tool = createPalReferenceImageTool({ attachments, assertCurrentAdmission })
		const result = await tool.execute({}, {
			sandbox: {} as Sandbox,
			permissionContext: { mode: 'plan' },
		} as ToolContext)
		expect(result.success).toBe(false)
		expect(result.error).toContain('read-only plan mode')
		expect(attachments).not.toHaveBeenCalled()
		expect(assertCurrentAdmission).not.toHaveBeenCalled()
	})
})

// These tests run the real sandbox API and guest Python filesystem transaction.
// Native Windows Pal hosts use the same Linux guest path; host-only Windows
// LocalSandboxProvider paths cannot supply this guest contract.
describe.skipIf(process.platform === 'win32')('Pal guest reference publication', () => {
	const guests: Sandbox[] = []
	afterEach(async () => {
		for (const sandbox of guests.splice(0)) await sandbox.destroy()
	})
	async function guest() {
		const sandbox = await new LocalSandboxProvider(NOOP_LOGGER).create()
		guests.push(sandbox)
		return sandbox
	}

	it('writes exact original bytes, publishes stable paths and reuses matching files', async () => {
		const sandbox = await guest()
		const originals = [image(), image(40), image()]
		const references = preparePalReferenceImages(originals)
		const assertCurrentAdmission = vi.fn()
		const write = vi.spyOn(sandbox, 'writeFile')
		const receipts = await importPalReferenceImages(references, {
			sandbox,
			assertCurrentAdmission,
		})
		expect(receipts).toHaveLength(3)
		expect(receipts[0]?.path).toBe(receipts[2]?.path)
		expect(write).toHaveBeenCalledTimes(2)
		for (const [index, receipt] of receipts.entries()) {
			expect(receipt.path).toMatch(/\/\.namzu\/references\/[a-f0-9]{64}\.png$/)
			expect(await sandbox.readFile(receipt.path)).toEqual(
				Buffer.from((originals[index] as { data: string }).data, 'base64'),
			)
			expect((await stat(receipt.path)).mode & 0o222).toBe(0)
		}
		expect(await readdir(posix.join(sandbox.rootDir, '.namzu', 'reference-imports'))).toEqual([])
		write.mockClear()
		expect(
			await importPalReferenceImages(references, {
				sandbox,
				assertCurrentAdmission,
			}),
		).toEqual(receipts)
		expect(write).not.toHaveBeenCalled()
		expect(JSON.stringify(receipts)).not.toContain((originals[0] as { data: string }).data)
		expect(assertCurrentAdmission.mock.calls.length).toBeGreaterThan(4)
	})

	it('refuses a collision before copying any member and preserves the existing file', async () => {
		const sandbox = await guest()
		const first = await importPalReferenceImages(preparePalReferenceImages([image()]), {
			sandbox,
			assertCurrentAdmission: () => {},
		})
		const collided = first[0]?.path
		if (!collided) throw new Error('No guest reference receipt.')
		const { chmod } = await import('node:fs/promises')
		await chmod(collided, 0o600)
		await writeFile(collided, 'original guest file must survive')
		const write = vi.spyOn(sandbox, 'writeFile')
		await expect(
			importPalReferenceImages(preparePalReferenceImages([image(40), image()]), {
				sandbox,
				assertCurrentAdmission: () => {},
			}),
		).rejects.toThrow('preflight failed')
		expect(write).not.toHaveBeenCalled()
		expect(await readFile(collided, 'utf8')).toBe('original guest file must survive')
		expect(await readdir(posix.dirname(collided))).toHaveLength(1)
	})

	it('refuses a reference-directory symlink and never writes into its target', async () => {
		const sandbox = await guest()
		const outside = await guest()
		await sandbox.writeFile('.namzu/prepare', '')
		await symlink(outside.rootDir, posix.join(sandbox.rootDir, '.namzu', 'references'))
		const write = vi.spyOn(sandbox, 'writeFile')
		await expect(
			importPalReferenceImages(preparePalReferenceImages([image()]), {
				sandbox,
				assertCurrentAdmission: () => {},
			}),
		).rejects.toThrow('preflight failed')
		expect(write).not.toHaveBeenCalled()
		expect(await readdir(outside.rootDir)).toEqual([])
	})

	it('refuses forged metadata or a revoked admission before any guest operation', async () => {
		const sandbox = await guest()
		const references = preparePalReferenceImages([image()])
		const reference = references[0]
		if (!reference) throw new Error('No prepared reference.')
		const exec = vi.spyOn(sandbox, 'exec')
		const write = vi.spyOn(sandbox, 'writeFile')
		await expect(
			importPalReferenceImages([{ ...reference, sha256: '0'.repeat(64) }], {
				sandbox,
				assertCurrentAdmission: () => {},
			}),
		).rejects.toThrow('metadata')
		await expect(
			importPalReferenceImages([{ ...reference, data: 'https://example.com/reference.png' }], {
				sandbox,
				assertCurrentAdmission: () => {},
			}),
		).rejects.toThrow('supported raster image')
		await expect(
			importPalReferenceImages([{ ...reference, data: 'A'.repeat(4 * 1024 * 1024 + 4) }], {
				sandbox,
				assertCurrentAdmission: () => {},
			}),
		).rejects.toThrow('bytes')
		await expect(
			importPalReferenceImages(references, {
				sandbox,
				assertCurrentAdmission: () => {
					throw new Error('The operator took control.')
				},
			}),
		).rejects.toThrow('operator took control')
		expect(exec).not.toHaveBeenCalled()
		expect(write).not.toHaveBeenCalled()
	})

	it('withholds a manifest when authority is revoked during the staging write', async () => {
		const sandbox = await guest()
		let active = true
		const originalWrite = sandbox.writeFile.bind(sandbox)
		vi.spyOn(sandbox, 'writeFile').mockImplementation(async (path, data) => {
			await originalWrite(path, data)
			active = false
		})
		const exec = vi.spyOn(sandbox, 'exec')
		await expect(
			importPalReferenceImages(preparePalReferenceImages([image()]), {
				sandbox,
				assertCurrentAdmission: () => {
					if (!active) throw new Error('Admission revoked.')
				},
			}),
		).rejects.toThrow('Admission revoked')
		expect(exec).toHaveBeenCalledTimes(1)
		expect(await readdir(posix.join(sandbox.rootDir, '.namzu', 'references'))).toEqual([])
	})

	it('returns a usable manifest through the real tool execution without modifying attachments', async () => {
		const sandbox = await guest()
		const attachments = Object.freeze([Object.freeze(image())])
		const tool = createPalReferenceImageTool({
			attachments: () => attachments,
			assertCurrentAdmission: () => {},
		})
		const result = await tool.execute(
			{},
			{
				sessionId: generateSessionId(),
				turnId: generateTurnId(),
				workingDirectory: sandbox.rootDir,
				abortSignal: new AbortController().signal,
				env: {},
				log: () => {},
				sandbox,
			},
		)
		expect(result.success).toBe(true)
		const receipt = JSON.parse(result.output ?? '').references[0]
		expect(await sandbox.readFile(receipt.path)).toEqual(
			Buffer.from((attachments[0] as { data: string }).data, 'base64'),
		)
		expect(attachments[0]).toEqual(image())
	})
})
