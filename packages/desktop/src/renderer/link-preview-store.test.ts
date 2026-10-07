import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinkPreviewDetails } from './link-preview-parse.js'
import {
	LINK_PREVIEW_CACHE_LIMIT,
	clearLinkPreviewCache,
	loadLinkPreview,
	settledLinkPreview,
} from './link-preview-store.js'

const details: LinkPreviewDetails = {
	title: 'Title',
	imageUrl: 'https://example.test/i.png',
	iconUrl: 'https://example.test/f.png',
}
const parse = vi.fn(() => details)
const page = { url: 'https://example.test/a', head: '<head></head>' }

beforeEach(() => {
	clearLinkPreviewCache()
	parse.mockClear()
})

describe('loadLinkPreview', () => {
	it('is unavailable without the bridge or without a page', async () => {
		expect(await loadLinkPreview('https://a.test/', {}, parse)).toEqual({ status: 'unavailable' })
		expect(await loadLinkPreview('https://a.test/x', undefined, parse)).toEqual({
			status: 'unavailable',
		})
		const linkPreview = vi.fn().mockResolvedValue(null)
		expect(await loadLinkPreview('https://b.test/', { linkPreview }, parse)).toEqual({
			status: 'unavailable',
		})
		expect(parse).not.toHaveBeenCalled()
	})
	it('is ready with details and both images', async () => {
		const linkPreview = vi.fn().mockResolvedValue(page)
		const linkPreviewImage = vi.fn(
			async (_url: string, kind: string) => `data:image/png;base64,${kind}`,
		)
		const result = await loadLinkPreview(
			'https://a.test/',
			{ linkPreview, linkPreviewImage },
			parse,
		)
		expect(result).toEqual({
			status: 'ready',
			details,
			image: 'data:image/png;base64,image',
			icon: 'data:image/png;base64,icon',
		})
		expect(linkPreviewImage).toHaveBeenCalledWith('https://example.test/i.png', 'image')
		expect(linkPreviewImage).toHaveBeenCalledWith('https://example.test/f.png', 'icon')
	})
	it('stays ready without an image that failed or is absent', async () => {
		const linkPreview = vi.fn().mockResolvedValue(page)
		const linkPreviewImage = vi.fn(async (_url: string, kind: string) => {
			if (kind === 'image') throw new Error('boom')
			return null
		})
		expect(
			await loadLinkPreview('https://a.test/', { linkPreview, linkPreviewImage }, parse),
		).toEqual({
			status: 'ready',
			details,
		})
		clearLinkPreviewCache()
		expect(await loadLinkPreview('https://a.test/', { linkPreview }, parse)).toEqual({
			status: 'ready',
			details,
		})
	})
	it('exposes a settled result for an immediate reopen', async () => {
		const linkPreview = vi.fn().mockResolvedValue(page)
		const pending = loadLinkPreview('https://settled.test/', { linkPreview }, parse)
		expect(settledLinkPreview('https://settled.test/')).toBeUndefined()
		const result = await pending
		expect(settledLinkPreview('https://settled.test/')).toBe(result)
		clearLinkPreviewCache()
		expect(settledLinkPreview('https://settled.test/')).toBeUndefined()
	})
	it('shares one request per address', async () => {
		const linkPreview = vi.fn().mockResolvedValue(null)
		const first = loadLinkPreview('https://a.test/', { linkPreview }, parse)
		const second = loadLinkPreview('https://a.test/', { linkPreview }, parse)
		expect(second).toBe(first)
		await first
		expect(linkPreview).toHaveBeenCalledTimes(1)
	})
	it('forgets a rejected load', async () => {
		const api = { linkPreview: vi.fn().mockResolvedValue(page) }
		const broken = vi.fn(() => {
			throw new Error('bad head')
		})
		await expect(loadLinkPreview('https://a.test/', api, broken)).rejects.toThrow('bad head')
		await Promise.resolve()
		expect(await loadLinkPreview('https://a.test/', api, parse)).toMatchObject({ status: 'ready' })
		expect(api.linkPreview).toHaveBeenCalledTimes(2)
	})
	it('evicts the least recently used entry past the limit', async () => {
		const linkPreview = vi.fn().mockResolvedValue(null)
		const api = { linkPreview }
		for (let i = 0; i < LINK_PREVIEW_CACHE_LIMIT; i++)
			await loadLinkPreview(`https://a.test/${i}`, api, parse)
		await loadLinkPreview('https://a.test/0', api, parse) // refresh the oldest
		await loadLinkPreview('https://a.test/new', api, parse)
		expect(linkPreview).toHaveBeenCalledTimes(LINK_PREVIEW_CACHE_LIMIT + 1)
		await loadLinkPreview('https://a.test/0', api, parse)
		expect(linkPreview).toHaveBeenCalledTimes(LINK_PREVIEW_CACHE_LIMIT + 1)
		await loadLinkPreview('https://a.test/1', api, parse)
		expect(linkPreview).toHaveBeenCalledTimes(LINK_PREVIEW_CACHE_LIMIT + 2)
	})
})
