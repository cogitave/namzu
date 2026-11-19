import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Layout rules found by looking at the real window (the layout sweep), kept as checks on the stylesheets
// so they cannot slip back. Each reads a rule's declarations; nothing here depends on time or a browser.

const read = (name: string) =>
	readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), 'utf8').replace(
		/\/\*[\s\S]*?\*\//g,
		'',
	)

/** The declarations of the first rule whose selector list is exactly `selector`, as a map. */
function rule(css: string, selector: string): Record<string, string> {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
	const match = new RegExp(`(?:^|[}\\s])${escaped}\\s*\\{([^}]*)\\}`).exec(css)
	if (!match) throw new Error(`no rule for ${selector}`)
	const out: Record<string, string> = {}
	for (const line of (match[1] as string).split(';')) {
		const colon = line.indexOf(':')
		if (colon > 0) out[line.slice(0, colon).trim()] = line.slice(colon + 1).trim()
	}
	return out
}

describe('the conversation bar', () => {
	const css = read('conversation-bar.css')
	it('the project label gives way before the title, and the title keeps a floor', () => {
		const project = rule(css, '.conversation-bar-project')
		expect(project['min-width']).toBe('0')
		expect(Number(project.flex?.split(/\s+/)[1])).toBeGreaterThan(1)
		expect(rule(css, '.conversation-bar-title')['min-width']).toBe('min(100%, 96px)')
	})
	it('the project is hidden while the bar still has room for a whole title', () => {
		const query = /@container conversation-bar \(max-width: (\d+)px\)\s*\{\s*\.conversation-bar-project/.exec(css)
		expect(Number(query?.[1])).toBeGreaterThanOrEqual(440)
	})
})
