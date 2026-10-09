import { describe, expect, it } from 'vitest'
import { engineTerminalRequest, shellTerminalRequest } from './terminal-request.js'

const base = { projectId: 'p', groupId: 'g', draft: '' }

describe('engineTerminalRequest', () => {
	it('gives the Namzu terminal app every choice and the message', () => {
		expect(
			engineTerminalRequest({
				...base,
				engine: 'namzu',
				provider: 'openai',
				model: 'gpt-5',
				effort: 'high',
				permissionMode: 'plan',
				draft: 'hello',
			}),
		).toEqual({
			kind: 'engine',
			engine: 'namzu',
			projectId: 'p',
			groupId: 'g',
			cols: 100,
			rows: 30,
			provider: 'openai',
			model: 'gpt-5',
			effort: 'high',
			permissionMode: 'plan',
			prompt: 'hello',
		})
	})

	it('starts an installed engine on the message and its model, and not on its own provider id', () => {
		expect(
			engineTerminalRequest({
				...base,
				engine: 'codex-cli',
				provider: 'codex-cli',
				model: 'gpt-5-codex',
				permissionMode: 'accept-edits',
				draft: '  fix the build \n',
			}),
		).toMatchObject({
			engine: 'codex-cli',
			model: 'gpt-5-codex',
			prompt: 'fix the build',
			permissionMode: 'accept-edits',
		})
		const request = engineTerminalRequest({ ...base, engine: 'claude-code', provider: 'x' })
		expect(request).not.toHaveProperty('provider')
	})

	it('leaves the model to an installed engine when the choice is only its default', () => {
		const request = engineTerminalRequest({
			...base,
			engine: 'claude-code',
			model: 'default',
			modelIsDefault: true,
		})
		expect(request).not.toHaveProperty('model')
		// The Namzu terminal app still states the model it was showing.
		expect(
			engineTerminalRequest({ ...base, engine: 'namzu', model: 'm', modelIsDefault: true }),
		).toMatchObject({ model: 'm' })
	})

	it('asks first when no mode was chosen, and omits an unchosen effort', () => {
		const request = engineTerminalRequest({ ...base, engine: 'namzu' })
		expect(request).toMatchObject({ permissionMode: 'prompt' })
		expect(request).not.toHaveProperty('effort')
		expect(request).not.toHaveProperty('prompt')
	})
})

describe('shellTerminalRequest', () => {
	it('is a plain shell in the project with the initial size', () => {
		expect(shellTerminalRequest('p', 'g')).toEqual({
			kind: 'shell',
			projectId: 'p',
			groupId: 'g',
			cols: 100,
			rows: 30,
		})
	})
})
