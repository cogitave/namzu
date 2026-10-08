// Records what each animation frame of the renderer shows, from before the bundle runs.
// Injected into a frozen copy of the app by harness.mjs (instrumentFrames); never shipped.
(() => {
	const frames = []
	window.__frames = frames
	let last = ''
	const sample = () => {
		const root = document.getElementById('root')
		const text = root ? root.innerText || '' : ''
		const state = {
			root: root ? root.childElementCount : -1,
			dark: document.documentElement.classList.contains('dark'),
			tabs: document.querySelectorAll('.conversation-tab').length,
			heading: /What should we work on in|What would you like to work on/.test(text),
			welcome: /Add new project/.test(text),
			hello: text.includes('Scripted hello back.'),
			skeleton: !!document.querySelector('[data-skeleton]'),
			composer: !!document.querySelector('[aria-label="Message Namzu"]'),
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
