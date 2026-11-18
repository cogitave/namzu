import { createElement, useContext } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { LinkRouteContext, LinkRoutedToasts } from './link-route.js'

describe('the link route', () => {
	it('is absent by default, so a link goes to the system browser as before', () => {
		let seen: unknown = 'unset'
		const Probe = () => {
			seen = useContext(LinkRouteContext)
			return null
		}
		renderToStaticMarkup(createElement(Probe))
		expect(seen).toBeNull()
	})

	it('reaches whatever is drawn inside the toasts, and answers whether it took the link', () => {
		const route = vi.fn((url: string) => url.startsWith('https://'))
		let seen: ((url: string) => boolean) | null = null
		const Probe = () => {
			seen = useContext(LinkRouteContext)
			return null
		}
		renderToStaticMarkup(
			createElement(
				LinkRoutedToasts,
				{ route, focused: true, pane: { current: null } },
				createElement(Probe),
			),
		)
		expect(seen).toBe(route)
		expect((seen as unknown as (url: string) => boolean)('https://example.com')).toBe(true)
		expect((seen as unknown as (url: string) => boolean)('mailto:a@b.c')).toBe(false)
	})
})
