import { useEffect } from 'react'
import type { DesktopSettings } from '../shared/settings-protocol.js'
import { applyAppearancePrefs, writePrefsMirror } from './appearance-prefs.js'
import { setCodePrefs } from './code-prefs.js'
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
	const lightCode = settings?.lightCodeTheme
	const darkCode = settings?.darkCodeTheme
	const codeFont = settings?.codeFont
	const codeSize = settings?.codeFontSize
	useEffect(() => {
		if (
			size === undefined ||
			width === undefined ||
			motion === undefined ||
			virtualize === undefined ||
			response === undefined ||
			dismiss === undefined ||
			lightCode === undefined ||
			darkCode === undefined ||
			codeFont === undefined ||
			codeSize === undefined
		)
			return
		const prefs = {
			transcriptTextSize: size,
			transcriptWidth: width,
			motion,
			virtualizeConversations: virtualize,
			responseFont: response,
			autoDismissPopups: dismiss,
			lightCodeTheme: lightCode,
			darkCodeTheme: darkCode,
			codeFont,
			codeFontSize: codeSize,
		}
		applyAppearancePrefs(document.documentElement, prefs)
		writePrefsMirror(localStorage, prefs)
		setNoticeAutoDismiss(dismiss)
		announceMotionChange(window)
		// After the root's tokens: open terminals and code views read them on this signal.
		setCodePrefs({ lightCodeTheme: lightCode, darkCodeTheme: darkCode })
	}, [size, width, motion, virtualize, response, dismiss, lightCode, darkCode, codeFont, codeSize])
}
