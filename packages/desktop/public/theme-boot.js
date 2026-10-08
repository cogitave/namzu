// Runs before the bundle so the first paint already has the saved theme. It only reads one
// localStorage key the renderer itself writes; the app sets the same class again once it mounts.
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
