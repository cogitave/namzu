// Runs before the bundle so the first paint already has the saved theme. It only reads
// localStorage keys the renderer itself writes; the app sets the same class again once it mounts.
try {
	var saved = localStorage.getItem('namzu.appearance')
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
// The interface font is the same kind of saved choice: the first paint already has the stacks the
// person picked. `app` (the default) leaves the attribute off; renderer/interface-font.ts owns the key.
try {
	if (localStorage.getItem('namzu.interface-font') === 'system')
		document.documentElement.setAttribute('data-interface-font', 'system')
} catch (error) {}
