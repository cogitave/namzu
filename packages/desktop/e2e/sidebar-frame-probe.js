// Records where every keyed sidebar row sits on each animation frame, from before the bundle
// runs, so the very first frame is included. Injected into a frozen copy of the app by
// sidebar-startup-stability.test.mjs; never shipped. A frame is recorded only when something on
// it differs from the one before. Rows are keyed by `data-sidebar-key` (project, conversation and
// Pal ids, section headings), never by their text.
;(() => {
	const frames = []
	window.__sidebarFrames = frames
	let last = ''
	const sectionOf = (element) => {
		const group = element.closest('[data-project-group]')
		if (group && group !== element) return `project:${group.getAttribute('data-project-group')}`
		if (element.closest('.sidebar-recents')) return 'recents'
		if (element.closest('.sidebar-pals')) return 'pals'
		return 'root'
	}
	const sample = () => {
		const rows = {}
		for (const element of document.querySelectorAll('#namzu-sidebar [data-sidebar-key]')) {
			if (element.getClientRects().length === 0) continue
			const box = element.getBoundingClientRect()
			rows[element.getAttribute('data-sidebar-key')] = [
				Math.round(box.top * 100) / 100,
				sectionOf(element),
			]
		}
		const aside = document.getElementById('namzu-sidebar')
		const state = {
			rows,
			settled: aside?.getAttribute('data-start-settled') === 'true',
			mark: window.__sidebarMark ?? '',
			// The error banner of the main pane, if one is drawn on this frame.
			banner: document.querySelector('.connection-error')?.textContent ?? '',
		}
		const key = JSON.stringify(state)
		if (key !== last) {
			last = key
			frames.push({ t: Math.round(performance.now()), ...state })
		}
		requestAnimationFrame(sample)
	}
	requestAnimationFrame(sample)
})()
