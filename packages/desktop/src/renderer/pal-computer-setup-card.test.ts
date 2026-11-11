import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PalComputerSetupCard } from './pal-computer-setup-card.js'

const html = (podmanStopped?: boolean) =>
	renderToStaticMarkup(createElement(PalComputerSetupCard, { palName: 'Kiro', podmanStopped }))

describe('PalComputerSetupCard', () => {
	it('says what the computer needs and costs when nothing is installed', () => {
		const card = html(false)
		expect(card).toContain('Set up Kiro’s computer')
		expect(card).toContain('about 1.2\u00a0GB')
		expect(card).toContain('Docker Desktop or Podman')
	})

	it('names the machine to start, and offers no download, when Podman is installed but stopped', () => {
		const card = html(true)
		expect(card).toContain('Start your Podman machine')
		expect(card).not.toContain('Docker Desktop')
		expect(card).not.toContain('1.2')
	})

	it('is a labelled region', () => {
		expect(html()).toMatch(/<section[^>]*aria-labelledby="pal-computer-setup-title"/)
		expect(html()).toContain('id="pal-computer-setup-title"')
	})
})
