import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * Pages for the reach tests: each one isolates a single way a click can miss
 * or a control can hide. They run on two origins: `main` serves everything,
 * `inner` (another port, so another origin) serves only the frame body.
 */
export interface ReachServer {
	readonly main: string
	/** The same server under another host name: a second origin for the origin tests. */
	readonly alias: string
	readonly inner: string
	close(): Promise<void>
}

const shell = (title: string, body: string, style = ''): string =>
	`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>body{font:15px sans-serif;margin:20px}${style}</style></head><body>${body}</body></html>`

function pages(innerOrigin: string): Record<string, string> {
	return {
		// A wide section whose only text is the menu title; the menu opens on :hover.
		'/hover': shell(
			'Hover menu',
			`<section id="bar" style="border:1px solid #ccc;padding:10px;margin:10px 0"><div class="menu"><b>Products</b><div class="dd"><a href="#" id="reports" onclick="document.getElementById('status').textContent='Reports opened';return false">Reports</a><br><a href="#" onclick="document.getElementById('status').textContent='Alerts opened';return false">Alerts</a></div></div> <span id="menumsg"></span></section><p id="status">nothing opened</p>`,
			'.menu{position:relative;display:inline-block}.menu .dd{display:none;position:absolute;background:#eee;border:1px solid #999;padding:6px;min-width:120px}.menu:hover .dd{display:block}',
		),
		// A modal that Escape closes.
		'/modal': shell(
			'Modal',
			`<button id="open" onclick="document.getElementById('m').className='on'">Open settings</button><p id="status">modal closed</p><div id="m"><div role="dialog" aria-label="Settings"><p>Settings are open</p><button>Save settings</button></div></div><script>document.addEventListener('keydown',e=>{if(e.key==='Escape'){document.getElementById('m').className='';document.getElementById('status').textContent='closed by Escape'}})</script>`,
			'#m{display:none;position:fixed;inset:0;background:rgba(0,0,0,.4)}#m.on{display:block}#m div{background:#fff;margin:60px;padding:20px}',
		),
		// Suggestions that only key events produce.
		'/autocomplete': shell(
			'Autocomplete',
			`<label>City <input id="city" aria-label="City" autocomplete="off"></label><ul id="s" role="listbox" aria-label="Suggestions"></ul><p id="status">no choice</p><script>const names=['Lisbon','Lima','Lille','Lyon'];const city=document.getElementById('city');city.addEventListener('keyup',()=>{const v=city.value.toLowerCase();document.getElementById('s').innerHTML=v.length<2?'':names.filter(n=>n.toLowerCase().startsWith(v)).map(n=>'<li role="option" tabindex="0">'+n+'</li>').join('');for(const li of document.querySelectorAll('li')){li.onclick=()=>{city.value=li.textContent;document.getElementById('status').textContent='chose '+li.textContent}}})</script>`,
		),
		// A button inside an open shadow root.
		'/shadow': shell(
			'Shadow',
			`<div id="host"></div><p id="status">not pressed</p><script>const r=document.getElementById('host').attachShadow({mode:'open'});r.innerHTML='<button id="b">Shadow save</button>';r.getElementById('b').onclick=()=>{document.getElementById('status').textContent='shadow pressed'}</script>`,
		),
		// A password field inside a closed shadow root, focused.
		'/closed-shadow': shell(
			'Closed shadow',
			`<div id="host"></div><script>const r=document.getElementById('host').attachShadow({mode:'closed'});r.innerHTML='<input type="password" aria-label="Secret" id="p">';r.getElementById('p').focus()</script>`,
		),
		// A cross-origin frame with a button and a field.
		'/frame': shell(
			'Frame parent',
			`<h1>Parent</h1><iframe src="${innerOrigin}/inner" title="Payment widget" width="420" height="160"></iframe>`,
		),
		'/inner': shell(
			'Frame inner',
			`<button id="go" onclick="document.getElementById('status').textContent='frame button pressed'">Frame action</button><label>Note <input aria-label="Note"></label><p id="status">frame idle</p>`,
		),
		// A control drawn on a canvas: no element, no role, no name.
		'/canvas': shell(
			'Canvas',
			`<canvas id="c" width="300" height="100"></canvas><p id="status">canvas untouched</p><script>const c=document.getElementById('c'),g=c.getContext('2d');g.fillStyle='#36c';g.fillRect(20,20,120,50);g.fillStyle='#fff';g.fillText('Draw OK',45,50);c.onclick=e=>{const r=c.getBoundingClientRect();const x=e.clientX-r.left,y=e.clientY-r.top;if(x>=20&&x<=140&&y>=20&&y<=70)document.getElementById('status').textContent='canvas button hit'}</script>`,
		),
		// A link that opens a tab.
		'/popup': shell(
			'Popup parent',
			`<a href="/popup-child" target="_blank" id="l">Open the report</a><p id="status">parent idle</p>`,
		),
		'/popup-child': shell('Popup child', '<h1>The report</h1><button>Print report</button>'),
		// A button an overlay covers for good.
		'/covered': shell(
			'Covered',
			`<button id="b" onclick="document.getElementById('status').textContent='clicked'">Submit order</button><p id="status">not clicked</p><div style="position:fixed;inset:0;background:rgba(255,255,255,.01)" id="veil"></div>`,
		),
		// Two controls a short name fits.
		'/ambiguous': shell(
			'Ambiguous',
			`<button>Save</button> <button>Save draft</button> <button>Save</button> <a href="#">Delete</a>`,
		),
		// A text field, a password field and a form around both.
		'/credentials': shell(
			'Credentials',
			`<form onsubmit="document.getElementById('status').textContent='form submitted';return false"><label>User <input id="user" name="user"></label> <label>Password <input id="pass" name="pass" type="password"></label> <button type="submit">Sign in</button></form><p id="status">not submitted</p>`,
		),
		// A container whose middle is empty: the control sits at its left edge.
		'/wide': shell(
			'Wide',
			`<div id="wide" role="group" aria-label="Details panel" style="border:1px solid #888;height:200px"><a href="#" onclick="document.getElementById('status').textContent='link clicked';return false">Open details</a></div><p id="status">not clicked</p>`,
		),
		// A text field and a log of the keys it saw.
		'/keys': shell(
			'Keys',
			`<label>Query <input id="q" aria-label="Query" value="start"></label><p id="status"></p><script>const q=document.getElementById('q');q.addEventListener('keydown',e=>{document.getElementById('status').textContent+=e.key+' '})</script>`,
		),
	}
}

export async function startReachServer(): Promise<ReachServer> {
	let innerOrigin = ''
	let mainPort = 0
	const mainPages = () => pages(innerOrigin)
	const main: Server = createServer((req, res) => {
		const path = new URL(req.url ?? '/', 'http://x').pathname
		const html = mainPages()[path]
		res.writeHead(html ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' })
		res.end(html ?? shell('Not found', '<h1>Not found</h1>'))
	})
	const inner: Server = createServer((req, res) => {
		const path = new URL(req.url ?? '/', 'http://x').pathname
		const html = path === '/inner' ? mainPages()['/inner'] : undefined
		res.writeHead(html ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' })
		res.end(html ?? shell('Not found', '<h1>Not found</h1>'))
	})
	await Promise.all([
		new Promise<void>((resolve) => inner.listen(0, '127.0.0.1', resolve)),
		new Promise<void>((resolve) => main.listen(0, '127.0.0.1', resolve)),
	])
	innerOrigin = `http://localhost:${(inner.address() as AddressInfo).port}`
	mainPort = (main.address() as AddressInfo).port
	const stop = (server: Server) =>
		new Promise<void>((resolve) => {
			server.closeAllConnections()
			server.close(() => resolve())
		})
	return {
		main: `http://127.0.0.1:${mainPort}`,
		alias: `http://localhost:${mainPort}`,
		inner: innerOrigin,
		close: async () => {
			await Promise.all([stop(main), stop(inner)])
		},
	}
}
