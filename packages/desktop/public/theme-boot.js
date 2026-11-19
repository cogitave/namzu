// Runs before the bundle so the first paint already has the saved theme. It reads the saved
// interface state main handed to the preload (window.namzu.viewState.snapshot), and falls back to
// localStorage for a first start after an update, before the app has moved those keys into main's
// store. The app sets the same class again once it mounts.
function readSaved(key) {
	try {
		var snapshot = window.namzu && window.namzu.viewState && window.namzu.viewState.snapshot
		if (snapshot && typeof snapshot[key] === 'string') return snapshot[key]
	} catch (error) {}
	return localStorage.getItem(key)
}
try {
	var saved = readSaved('namzu.appearance')
	var dark =
		saved === 'light'
			? false
			: saved === 'system'
				? window.matchMedia('(prefers-color-scheme: dark)').matches
				: true
	document.documentElement.classList.toggle('dark', dark)
} catch (error) {
	document.documentElement.classList.add('dark')
}
// A font name is drawn only when it holds nothing that could end a quoted CSS string. This is the
// test in shared/settings-catalogue.ts (FONT_NAME_PATTERN).
var fontName = /^[\p{L}\p{N} ._()+&-]+$/u
function safeFont(name) {
	return typeof name === 'string' && name.length <= 80 && fontName.test(name)
}
// The interface font is the same kind of saved choice: the first paint already has the stacks the
// person picked. `app` (the default) leaves the attribute off; renderer/interface-font.ts owns the key.
// A font installed on this computer is stored as `family:<name>`.
try {
	var face = readSaved('namzu.interface-font')
	var root = document.documentElement
	if (face === 'system') root.setAttribute('data-interface-font', 'system')
	else if (typeof face === 'string' && face.indexOf('family:') === 0 && safeFont(face.slice(7))) {
		root.setAttribute('data-interface-font', face)
		root.style.setProperty('--font-sans', '"' + face.slice(7).trim() + '", var(--font-sans-app)')
	}
} catch (error) {}
// The rest of Settings > Appearance: text size, width, motion, drawing off-screen turns and the
// response font. renderer/appearance-prefs.ts writes the values here (namzu.appearance-prefs) and
// sets the same attributes; absent or unreadable means the values Namzu has always had.
try {
	var prefs = JSON.parse(readSaved('namzu.appearance-prefs') || '{}')
	var html = document.documentElement
	if (prefs.transcriptTextSize === 'small' || prefs.transcriptTextSize === 'large')
		html.setAttribute('data-transcript-size', prefs.transcriptTextSize)
	if (prefs.transcriptWidth === 'medium' || prefs.transcriptWidth === 'wide')
		html.setAttribute('data-transcript-width', prefs.transcriptWidth)
	if (prefs.motion === 'reduce' || prefs.motion === 'full')
		html.setAttribute('data-motion', prefs.motion)
	if (prefs.virtualizeConversations === false) html.setAttribute('data-virtualize', 'off')
	var response = prefs.responseFont
	var stack
	if (response === 'app') stack = 'var(--font-sans-app)'
	else if (response === 'system') stack = 'var(--font-sans-system)'
	else if (typeof response === 'string' && response.indexOf('family:') === 0 && safeFont(response.slice(7)))
		stack = '"' + response.slice(7).trim() + '", var(--font-sans)'
	if (stack) {
		html.setAttribute('data-response-font', 'on')
		html.style.setProperty('--font-response', stack)
	}
	// Code: the font (for code and the terminal) and its size. The colour sets are read by the diff
	// and file views from the same mirror when they mount.
	if (safeFont(prefs.codeFont)) {
		var mono = '"' + prefs.codeFont.trim() + '", var(--font-mono-app)'
		html.style.setProperty('--font-mono', mono)
		html.style.setProperty('--font-terminal', mono)
	}
	var codeSize = prefs.codeFontSize
	if (typeof codeSize === 'number' && codeSize % 1 === 0 && codeSize >= 11 && codeSize <= 18 && codeSize !== 13)
		html.style.setProperty('--font-size-code', codeSize + 'px')
} catch (error) {}
