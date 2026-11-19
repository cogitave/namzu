/**
 * The keypad Enter sends a message and the keypad digits are typed, through the same stream
 * wrapper the terminal session installs.
 */

import { render } from 'ink-testing-library'
import React from 'react'
import { describe, expect, it } from 'vitest'

import { Composer } from '../Composer.js'
import { installKeypadKeys } from '../keypad-keys.js'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

function mount() {
	const sent: string[] = []
	const app = render(
		React.createElement(Composer, {
			onSubmit: (value: string) => {
				sent.push(value)
			},
			history: [],
		}),
	)
	installKeypadKeys(app.stdin as unknown as { read: (...args: never[]) => unknown })
	return { app, sent }
}

const press = async (app: ReturnType<typeof render>, input: string) => {
	app.stdin.write(input)
	await tick()
}

describe('keypad keys in the message box', () => {
	it('types a keypad digit', async () => {
		const { app } = mount()
		await tick()
		await press(app, '\x1b[57401u')
		expect(app.lastFrame()).toContain('2')
		app.unmount()
	})

	it('sends the message on the keypad Enter', async () => {
		const { app, sent } = mount()
		await tick()
		await press(app, 'h')
		await press(app, 'i')
		await press(app, '\x1b[57401u')
		await press(app, '\x1b[57414u')
		expect(sent).toEqual(['hi2'])
		app.unmount()
	})

	it('keeps shift+keypad Enter from sending, as shift+Enter does not', async () => {
		const { app, sent } = mount()
		await tick()
		await press(app, 'h')
		await press(app, '\x1b[57414;2u')
		expect(sent).toEqual([])
		app.unmount()
	})
})
