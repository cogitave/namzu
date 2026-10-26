/**
 * The theme and the reduced-motion setting reach the screen: the working line
 * stands still when asked, the light themes draw no near-white text, and the
 * picker's sample follows the theme. Colours are asserted as the escape codes
 * chalk writes, with a fake clock and no waiting.
 */

import { createRequire } from 'node:module'

import { render } from 'ink-testing-library'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('ink', async (importOriginal) => {
	const actual = await importOriginal<typeof import('ink')>()
	return {
		...actual,
		useStdout: () => {
			const real = actual.useStdout()
			return { ...real, stdout: Object.assign(Object.create(real.stdout), { isTTY: true }) }
		},
	}
})

const { LiveActivity } = await import('../LiveActivity.js')
const { ComposerFrame } = await import('../ComposerFrame.js')
const { ChoicePicker } = await import('../ChoicePicker.js')
const { ThemeSample } = await import('../ThemeSample.js')
const { setReducedMotion } = await import('../motion.js')
const { resetThemeStore, setThemeSetting } = await import('../theme-store.js')

const inkRequire = createRequire(createRequire(import.meta.url).resolve('ink'))
const chalk = (await import(inkRequire.resolve('chalk'))).default as { level: number }
const originalLevel = chalk.level

beforeAll(() => {
	chalk.level = 3
})
afterAll(() => {
	chalk.level = originalLevel
})
beforeEach(() => {
	vi.stubEnv('NO_COLOR', undefined)
	vi.stubEnv('FORCE_COLOR', '3')
	vi.stubEnv('TERM', 'xterm-256color')
	vi.useFakeTimers({
		toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance'],
	})
	vi.setSystemTime(new Date('2026-10-25T09:00:00Z'))
})
afterEach(() => {
	vi.useRealTimers()
	vi.unstubAllEnvs()
	setReducedMotion(false)
	resetThemeStore()
})

/** One frame of the working line per 240 ms of fake time. */
async function framesOfWorkingLine(count: number): Promise<string[]> {
	const view = render(<LiveActivity activeTools={[]} working tokens={5} />)
	try {
		const frames: string[] = [view.lastFrame() ?? '']
		for (let i = 1; i < count; i += 1) {
			await vi.advanceTimersByTimeAsync(240)
			frames.push(view.lastFrame() ?? '')
		}
		return frames
	} finally {
		view.unmount()
	}
}

describe('reduced motion', () => {
	it('moves the working line when it is off', async () => {
		const frames = await framesOfWorkingLine(4)
		expect(new Set(frames).size).toBeGreaterThan(1)
	})

	it('holds the working line still when it is on, with the same words', async () => {
		const moving = await framesOfWorkingLine(1)
		setReducedMotion(true)
		const frames = await framesOfWorkingLine(4)
		expect(new Set(frames).size).toBe(1)
		// biome-ignore lint/suspicious/noControlCharactersInRegex: strips colour escapes from a frame.
		const words = (frame: string) => frame.replace(/\u001b\[[0-9;]*m/g, '')
		expect(words(frames[0] ?? '')).toBe(words(moving[0] ?? ''))
	})

	it('draws the composer rule plain while the session mode glows', async () => {
		const glowing = async (): Promise<string> => {
			const view = render(
				<ComposerFrame mode="hypermode" columns={40} activation={0}>
					{null}
				</ComposerFrame>,
			)
			try {
				view.rerender(
					<ComposerFrame mode="hypermode" columns={40} activation={1}>
						{null}
					</ComposerFrame>,
				)
				await vi.advanceTimersByTimeAsync(240)
				return view.lastFrame() ?? ''
			} finally {
				view.unmount()
			}
		}
		expect(await glowing(), 'control: the glow shows when motion is on').toContain('38;5;183')
		setReducedMotion(true)
		const still = await glowing()
		expect(still).not.toContain('38;5;183')
		expect(still).not.toContain('38;5;97')
	})
})

describe('the light theme', () => {
	it('draws the working line with no white on white', async () => {
		setThemeSetting('light', { env: {} })
		const frames = await framesOfWorkingLine(5)
		for (const frame of frames) {
			expect(frame).not.toContain('38;2;255;255;255')
			expect(frame).not.toContain('97m')
			expect(frame).not.toMatch(/38;5;(15|231|255)m/)
		}
	})

	it('draws the sample change in the theme’s diff colours', () => {
		vi.stubEnv('COLORTERM', 'truecolor')
		setThemeSetting('light', { env: {} })
		const frame = render(<ThemeSample width={40} />).lastFrame() ?? ''
		expect(frame).toContain('48;2;200;238;208')
		expect(frame).toContain('48;2;255;214;220')
		resetThemeStore()
		setThemeSetting('dark-daltonized', { env: {} })
		const after = render(<ThemeSample width={40} />).lastFrame() ?? ''
		expect(after).toContain('48;2;0;68;102')
		expect(after).not.toContain('48;2;200;238;208')
	})

	it('paints the picker in the theme, whatever the theme was when it was first drawn', () => {
		const options = [{ label: 'Dark mode', description: 'x', current: true }]
		const dark = render(
			<ChoicePicker title="Theme" options={options} selected={0} columns={60} />,
		).lastFrame()
		setThemeSetting('light-ansi', { env: {} })
		const light = render(
			<ChoicePicker title="Theme" options={options} selected={0} columns={60} />,
		).lastFrame()
		expect(dark).not.toBe(light)
		expect(light).not.toContain('38;5;')
	})
})
