import { describe, expect, it, vi } from 'vitest'
import type { NotifyOptions } from './notify.js'
import { showStartupNotice } from './startup-notice.js'

describe('showStartupNotice', () => {
	it('shows the sentence until dismissed and acknowledges only then', async () => {
		const acknowledgeNotice = vi.fn(async () => undefined)
		const shown: { text: string; options: NotifyOptions }[] = []
		const notify = (text: string, options: NotifyOptions) => {
			shown.push({ text, options })
			return 'n'
		}
		const api = { boot: { notice: { id: 'a', text: 'Set aside.' } }, acknowledgeNotice }
		showStartupNotice(api, notify)
		showStartupNotice(api, notify)
		expect(shown).toHaveLength(1)
		expect(shown[0]?.options).toMatchObject({ tone: 'warning', timeoutMs: 0 })
		expect(acknowledgeNotice).not.toHaveBeenCalled()
		shown[0]?.options.onClose?.()
		expect(acknowledgeNotice).toHaveBeenCalledWith('a')
	})

	it('does nothing without a notice or without a bridge', () => {
		const notify = vi.fn(() => 'n')
		showStartupNotice(undefined, notify)
		showStartupNotice({ boot: {} }, notify)
		expect(notify).not.toHaveBeenCalled()
	})

	it('survives a bridge that cannot acknowledge', () => {
		const shown: NotifyOptions[] = []
		showStartupNotice({ boot: { notice: { id: 'b', text: 'x' } } }, (_text, options) => {
			shown.push(options)
			return 'n'
		})
		expect(() => shown[0]?.onClose?.()).not.toThrow()
	})
})
