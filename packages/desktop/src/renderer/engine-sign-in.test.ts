import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it } from 'vitest'
import { resetSignedOutEngines, setEngineSignedOut, useSignedOutEngines } from './engine-sign-in.js'

afterEach(resetSignedOutEngines)

const names = () =>
	renderToStaticMarkup(
		createElement(() => createElement('p', null, [...useSignedOutEngines()].join(','))),
	)

it('remembers which engines said no account is signed in, and forgets one that connects', () => {
	expect(names()).toBe('<p></p>')
	setEngineSignedOut('codex-cli', true)
	expect(names()).toBe('<p>codex-cli</p>')
	// A repeat, or clearing an engine that was never recorded, changes nothing.
	setEngineSignedOut('codex-cli', true)
	setEngineSignedOut('claude-code', false)
	expect(names()).toBe('<p>codex-cli</p>')
	setEngineSignedOut('codex-cli', false)
	expect(names()).toBe('<p></p>')
})
