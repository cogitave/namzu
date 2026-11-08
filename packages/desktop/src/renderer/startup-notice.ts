import type { NotifyOptions } from './notify.js'

interface NoticeApi {
	boot?: { notice?: { id: string; text: string } }
	acknowledgeNotice?(id: string): Promise<void>
}

const shown = new Set<string>()

/**
 * Shows main's one-time start-up sentence (a saved file that was damaged and set aside) and keeps
 * it on screen until it is dismissed. Only then is main told, so a window that crashes with the
 * sentence still showing is handed it again by the reloaded page. One document shows it once.
 */
export function showStartupNotice(
	api: NoticeApi | undefined,
	notify: (text: string, options: NotifyOptions) => string,
): void {
	const notice = api?.boot?.notice
	if (!notice || shown.has(notice.id)) return
	shown.add(notice.id)
	notify(notice.text, {
		tone: 'warning',
		timeoutMs: 0,
		onClose: () => void api?.acknowledgeNotice?.(notice.id).catch(() => undefined),
	})
}
