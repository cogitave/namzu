import { describe, expect, it } from 'vitest'
import { type LinkPreviewTag, selectLinkPreview } from './link-preview-parse.js'

const page = 'https://example.test/articles/one'
const meta = (key: string, content: string, attr: 'property' | 'name' = 'property') =>
	({ tag: 'meta', attrs: { [attr]: key, content } }) satisfies LinkPreviewTag
const link = (attrs: Record<string, string>) => ({ tag: 'link', attrs }) satisfies LinkPreviewTag

describe('selectLinkPreview', () => {
	it('prefers Open Graph over Twitter over plain tags', () => {
		const details = selectLinkPreview(
			[
				{ tag: 'title', attrs: {}, text: 'Plain title' },
				meta('description', 'Plain description', 'name'),
				meta('twitter:title', 'Twitter title', 'name'),
				meta('twitter:description', 'Twitter description', 'name'),
				meta('og:title', 'OG title'),
				meta('og:site_name', 'Example'),
				meta('application-name', 'App', 'name'),
			],
			page,
		)
		expect(details).toMatchObject({
			title: 'OG title',
			description: 'Twitter description',
			siteName: 'Example',
		})
		expect(
			selectLinkPreview([{ tag: 'title', attrs: {}, text: ' Only\n  title ' }], page).title,
		).toBe('Only title')
	})
	it('reads keys case-insensitively from property or name', () => {
		const details = selectLinkPreview([meta('OG:Title', 'Cased', 'name')], page)
		expect(details.title).toBe('Cased')
	})
	it('picks the share image in priority order and resolves relative addresses', () => {
		expect(
			selectLinkPreview([meta('twitter:image', '/t.png', 'name'), meta('og:image', '/o.png')], page)
				.imageUrl,
		).toBe('https://example.test/o.png')
		expect(
			selectLinkPreview(
				[
					meta('og:image', 'https://cdn.test/a.png'),
					meta('og:image:secure_url', 'https://cdn.test/s.png'),
				],
				page,
			).imageUrl,
		).toBe('https://cdn.test/s.png')
	})
	it('keeps only credential-free HTTPS URLs of bounded length', () => {
		for (const bad of [
			'http://cdn.test/a.png',
			'javascript:alert(1)',
			'data:image/png;base64,AAAA',
			'https://user:pw@cdn.test/a.png',
			`https://cdn.test/${'a'.repeat(2100)}`,
		])
			expect(selectLinkPreview([meta('og:image', bad)], page).imageUrl).toBeUndefined()
	})
	it('resolves against an HTTPS base and ignores any other base', () => {
		const image = meta('og:image', 'img/a.png')
		expect(
			selectLinkPreview([{ tag: 'base', attrs: { href: 'https://static.test/dir/' } }, image], page)
				.imageUrl,
		).toBe('https://static.test/dir/img/a.png')
		expect(
			selectLinkPreview([{ tag: 'base', attrs: { href: 'http://static.test/dir/' } }, image], page)
				.imageUrl,
		).toBe('https://example.test/articles/img/a.png')
	})
	it('chooses the icon nearest 32px, then PNG, then the first', () => {
		const icon = (attrs: Record<string, string>) => link({ rel: 'icon', ...attrs })
		expect(
			selectLinkPreview(
				[
					icon({ href: '/16.png', sizes: '16x16' }),
					icon({ href: '/32.png', sizes: '32x32' }),
					icon({ href: '/180.png', sizes: '180x180' }),
				],
				page,
			).iconUrl,
		).toBe('https://example.test/32.png')
		expect(
			selectLinkPreview(
				[icon({ href: '/a.ico' }), icon({ href: '/b.png', type: 'image/png' })],
				page,
			).iconUrl,
		).toBe('https://example.test/b.png')
		expect(
			selectLinkPreview([icon({ href: '/a.ico' }), icon({ href: '/b.ico' })], page).iconUrl,
		).toBe('https://example.test/a.ico')
		expect(selectLinkPreview([link({ rel: 'shortcut icon', href: '/s.png' })], page).iconUrl).toBe(
			'https://example.test/s.png',
		)
	})
	it('passes over vector icons, which previews cannot show', () => {
		const icon = (attrs: Record<string, string>) => link({ rel: 'icon', ...attrs })
		expect(
			selectLinkPreview(
				[
					icon({ href: '/logo.svg', type: 'image/svg+xml', sizes: 'any' }),
					icon({ href: '/32.png', sizes: '32x32' }),
				],
				page,
			).iconUrl,
		).toBe('https://example.test/32.png')
		expect(
			selectLinkPreview(
				[icon({ href: '/logo.svg?v=2' }), link({ rel: 'apple-touch-icon', href: '/t.png' })],
				page,
			).iconUrl,
		).toBe('https://example.test/t.png')
		expect(selectLinkPreview([icon({ href: '/only.svg' })], page).iconUrl).toBe(
			'https://example.test/only.svg',
		)
	})
	it('excludes mask icons, falls back to the touch icon and then favicon.ico', () => {
		expect(
			selectLinkPreview(
				[
					link({ rel: 'mask-icon', href: '/m.svg' }),
					link({ rel: 'apple-touch-icon', href: '/t.png' }),
				],
				page,
			).iconUrl,
		).toBe('https://example.test/t.png')
		expect(selectLinkPreview([link({ rel: 'mask-icon', href: '/m.svg' })], page).iconUrl).toBe(
			'https://example.test/favicon.ico',
		)
		expect(selectLinkPreview([], page).iconUrl).toBe('https://example.test/favicon.ico')
	})
	it('collapses whitespace, drops empties and clamps with an ellipsis', () => {
		const details = selectLinkPreview(
			[
				meta('og:title', `  ${'t'.repeat(300)} `),
				meta('og:description', 'a\n\n b\t c'),
				meta('og:site_name', '   '),
			],
			page,
		)
		expect(Array.from(details.title ?? '')).toHaveLength(200)
		expect(details.title?.endsWith('…')).toBe(true)
		expect(details.description).toBe('a b c')
		expect(details.siteName).toBeUndefined()
		expect(
			Array.from(
				selectLinkPreview([meta('og:description', 'd'.repeat(400))], page).description ?? '',
			),
		).toHaveLength(300)
	})
})
