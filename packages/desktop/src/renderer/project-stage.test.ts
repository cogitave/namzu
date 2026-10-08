import { afterEach, expect, it, vi } from 'vitest'
import { afterQuietPeriod, connectingQuietMs, projectStage } from './project-stage.js'

afterEach(() => vi.useRealTimers())

it('never shows the trust gate while a project is still connecting', () => {
	expect(projectStage({ status: 'connecting', trusted: false })).toBe('connecting')
	expect(projectStage({ status: 'connecting', trusted: false, palId: 'pal' })).toBe('connecting')
	expect(projectStage({ status: 'connecting', trusted: false, isChat: true })).toBe('connecting')
})

it('shows the gate only for a ready project that is not trusted', () => {
	expect(projectStage({ status: 'ready', trusted: false })).toBe('gate')
	expect(projectStage({ status: 'ready', trusted: true })).toBe('ready')
})

it('gives a failed folder its own stage, and leaves Pal and chat workspaces on their old path', () => {
	expect(projectStage({ status: 'error', trusted: false })).toBe('error')
	expect(projectStage({ status: 'error', trusted: true })).toBe('error')
	expect(projectStage({ status: 'error', trusted: false, palId: 'pal' })).toBe('gate')
	expect(projectStage({ status: 'error', trusted: false, isChat: true })).toBe('gate')
})

it('keeps the connecting placeholder blank for the first 400 ms', () => {
	vi.useFakeTimers()
	const show = vi.fn()
	afterQuietPeriod(show)
	vi.advanceTimersByTime(connectingQuietMs - 1)
	expect(show).not.toHaveBeenCalled()
	vi.advanceTimersByTime(1)
	expect(show).toHaveBeenCalledTimes(1)
})

it('never shows the placeholder when the project is ready before the quiet period ends', () => {
	vi.useFakeTimers()
	const show = vi.fn()
	const cancel = afterQuietPeriod(show)
	vi.advanceTimersByTime(200)
	cancel()
	vi.advanceTimersByTime(1000)
	expect(show).not.toHaveBeenCalled()
})
