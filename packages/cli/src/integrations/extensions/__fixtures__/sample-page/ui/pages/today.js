// A page of a test extension. It can only call what its manifest declares, through window.namzu.
const state = document.getElementById('state')
const rows = document.getElementById('rows')
async function load() {
	try {
		const counts = await window.namzu.call('query:counts')
		state.textContent = `${counts.count} rows today`
		const all = await window.namzu.call('query:rows')
		for (const r of all.rows) {
			const tr = document.createElement('tr')
			tr.textContent = r.join(' ')
			rows.appendChild(tr)
		}
	} catch (e) {
		state.textContent = e.message
	}
}
document.getElementById('collected').addEventListener('click', () => {
	window.namzu.call('host:openNamzu', { where: 'what-is-collected' })
})
window.namzu.on('state', load)
load()
