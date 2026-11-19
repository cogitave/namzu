/**
 * A suggested next message in an empty composer: it replaces the placeholder, Tab takes it into
 * the draft, and nothing else uses it. With no suggestion Tab on an empty composer does what it did.
 */

import { render } from 'ink-testing-library'
import React from 'react'
import { describe, expect, it } from 'vitest'

import { Composer, type ComposerProps } from './Composer.js'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

function mount(extra: Partial<ComposerProps> = {}) {
	const sent: string[] = []
	const app = render(
		React.createElement(Composer, {
			onSubmit: (value) => {
				sent.push(value)
			},
			history: [],
			...extra,
		}),
	)
	return { app, sent }
}

const press = async (app: ReturnType<typeof render>, input: string) => {
	app.stdin.write(input)
	await tick()
}

describe('prompt suggestion in the composer', () => {
	it('shows the suggestion in place of the placeholder, with how to use it', async () => {
		const { app } = mount({ promptSuggestion: 'run the tests' })
		await tick()
		const frame = app.lastFrame() ?? ''
		expect(frame).toContain('run the tests · Tab to use')
		expect(frame).not.toContain('Type a message')
	})

	it('puts the suggestion in the draft on Tab, and Enter sends it as typed', async () => {
		const { app, sent } = mount({ promptSuggestion: 'run the tests' })
		await tick()
		await press(app, '\t')
		expect(app.lastFrame()).toContain('run the tests')
		expect(app.lastFrame()).not.toContain('Tab to use')
		expect(sent).toEqual([])
		await press(app, '\r')
		expect(sent).toEqual(['run the tests'])
	})

	it('leaves the suggestion unused once something else is typed', async () => {
		const { app, sent } = mount({ promptSuggestion: 'run the tests' })
		await tick()
		await press(app, 'x')
		expect(app.lastFrame()).not.toContain('run the tests')
		await press(app, '\r')
		expect(sent).toEqual(['x'])
	})

	it('keeps the plain placeholder, and Tab sends nothing, when there is no suggestion', async () => {
		const { app, sent } = mount()
		await tick()
		expect(app.lastFrame()).toContain('Type a message')
		await press(app, '\t')
		expect(sent).toEqual([])
	})
})
