import { useEffect } from 'react'
import type { DesktopSettings } from '../shared/settings-protocol.js'
import { applyAppearancePrefs, writePrefsMirror } from './appearance-prefs.js'
import { announceMotionChange } from './motion-setting.js'
import { setNoticeAutoDismiss } from './notify.js'

/**
 * Draw the saved appearance choices. Until main answers, the first paint's values (set by
 * public/theme-boot.js from the last mirror) stay as they are. Every window runs this, so a change
 * made in one repaints all of them through the `settings` event.
 */
export function useAppearancePrefs(settings: DesktopSettings | undefined): void {
	const size = settings?.transcriptTextSize
	const width = settings?.transcriptWidth
	const motion = settings?.motion
	const virtualize = settings?.virtualizeConversations
	const response = settings?.responseFont
	const dismiss = settings?.autoDismissPopups
	useEffect(() => {
		if (
			size === undefined ||
			width === undefined ||
			motion === undefined ||
			virtualize === undefined ||
			response === undefined ||
			dismiss === undefined
		)
			return
		const prefs = {
			transcriptTextSize: size,
			transcriptWidth: width,
			motion,
			virtualizeConversations: virtualize,
			responseFont: response,
			autoDismissPopups: dismiss,
		}
		applyAppearancePrefs(document.documentElement, prefs)
		writePrefsMirror(localStorage, prefs)
		setNoticeAutoDismiss(dismiss)
		announceMotionChange(window)
	}, [size, width, motion, virtualize, response, dismiss])
}
