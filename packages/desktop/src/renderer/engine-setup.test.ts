import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ChatErrorBanner } from './chat-error-banner.js'
import { engineSetup, setupPlatform, signInHelpFor } from './engine-setup.js'

describe('setupPlatform', () => {
	it('reads the system from the user agent', () => {
		expect(setupPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('windows')
		expect(setupPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)')).toBe('mac')
		expect(setupPlatform('Mozilla/5.0 (X11; Linux x86_64)')).toBe('linux')
		expect(setupPlatform('')).toBe('linux')
	})
})

describe('engineSetup', () => {
	it('knows how each engine is installed and signed in to', () => {
		expect(engineSetup('codex-cli', 'mac').install[0]?.command).toBe('npm install -g @openai/codex')
		expect(engineSetup('codex-cli', 'mac').signIn.command).toBe('codex login')
		expect(engineSetup('claude-code', 'windows').install[0]?.command).toContain('install.ps1')
		expect(engineSetup('claude-code', 'linux').install[0]?.command).toContain('install.sh')
	})
})

describe('signInHelpFor', () => {
	it('recognises the signed-out Codex error and names the command', () => {
		expect(signInHelpFor('Codex CLI requires its own signed-in account.')).toMatchObject({
			engine: 'codex-cli',
			name: 'Codex CLI',
			command: 'codex login',
		})
	})
	it('gives no advice for errors that are not about signing in, or name no engine', () => {
		expect(signInHelpFor('Codex returned an invalid model page.')).toBeUndefined()
		expect(signInHelpFor('Please sign in again.')).toBeUndefined()
		expect(signInHelpFor('')).toBeUndefined()
	})
})

describe('ChatErrorBanner sign-in help', () => {
	it('says what to run, offers Copy and Open terminal, and keeps Retry setup', () => {
		const message = 'Codex CLI requires its own signed-in account.'
		const html = renderToStaticMarkup(
			createElement(ChatErrorBanner, {
				message,
				signIn: signInHelpFor(message),
				onOpenTerminal: () => {},
				onRetry: () => {},
				retryLabel: 'Retry setup',
			}),
		)
		expect(html).toContain('Sign in to Codex CLI in a terminal first')
		expect(html).toContain('<code>codex login</code>')
		expect(html).toContain('Open terminal')
		expect(html).toContain('Retry setup')
	})
	it('shows no sign-in lines for an ordinary error', () => {
		const html = renderToStaticMarkup(createElement(ChatErrorBanner, { message: 'Offline' }))
		expect(html).not.toContain('Sign in')
		expect(html).not.toContain('Open terminal')
	})
})
