import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8')

describe('the capture processor under the page’s script policy', () => {
	const html = read('../../index.html')
	const policy = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)?.[1] ?? ''
	const directive = (name: string) =>
		policy
			.split(';')
			.map((part) => part.trim())
			.find((part) => part.startsWith(`${name} `))
	const worklet = read('../../public/voice-capture-worklet.js')

	it('the page allows its own files as scripts, and loads no code from strings or blobs', () => {
		expect(directive('script-src')).toBe("script-src 'self' 'wasm-unsafe-eval'")
		expect(policy).not.toContain('blob:')
		expect(policy).not.toContain("'unsafe-eval'")
		expect(directive('script-src')).not.toContain('data:')
		// Worklet modules follow script-src; no separate worker policy is needed or added.
		expect(directive('worker-src')).toBeUndefined()
	})

	it('the processor is a plain file in public/, which the build copies beside the page', () => {
		expect(worklet).toContain("registerProcessor('namzu-voice-capture'")
		expect(worklet).not.toMatch(/\beval\s*\(|new Function|importScripts|fetch\(|import\s*\(/)
	})

	it('the processor name the window creates is the one the file registers', () => {
		expect(read('./voice-capture.ts')).toContain("'namzu-voice-capture'")
		expect(read('./voice-capture.ts')).toContain('voice-capture-worklet.js')
	})

	it('the processor writes no output, so nothing the microphone hears is played back', () => {
		expect(worklet).not.toMatch(/outputs\s*\[/)
	})
})
