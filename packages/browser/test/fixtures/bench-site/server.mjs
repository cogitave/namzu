// The benchmark site for the browser tools. On demand only; nothing in CI starts it.
//
//   node server.mjs [port]          (default 18765, bound to 127.0.0.1)
//
// It serves one page per task, records every event a page reports in a
// server-side log, and scores a task from that log, so a run is judged by what
// the site saw and never by what the model says it did.
//
//   GET  /              the combined portal (task A2; ?signed=1 skips the sign-in box)
//   GET  /s /h /e /k /d /l /f /sh /t     one micro-task each (see TASKS below)
//   GET  /state         the whole state and event log as JSON
//   GET  /score?task=X  { task, steps: {name: bool}, done, total, extra }
//   GET  /reset         clear state and log
//
// The cross-origin frame of /f is served from http://localhost:<port>, the same
// process under another host name.
import http from 'node:http'

const PORT = Number(process.argv[2] || process.env.BENCH_SITE_PORT || 18765)
const CODE = 'K7Q-481'
const TOKEN = 'T-9F2A'

let st
const reset = () => {
	st = {
		started: Date.now(),
		loggedIn: false,
		loginFails: 0,
		plan: null,
		email: false,
		sms: false,
		terms: false,
		menu: null,
		search: null,
		result: null,
		confirmed: false,
		codeViewed: false,
		verified: false,
		wrongCode: 0,
		color: null,
		tool: null,
		modalOpened: false,
		modalEscape: 0,
		modalButton: 0,
		cookie: false,
		subscribe: 0,
		subscribeBlocked: 0,
		city: null,
		report: 0,
		note: null,
		noteOrigin: null,
		shadow: 0,
		popupOpened: false,
		popupDone: false,
		finish: 0,
		// Every event a page or the server saw, in order: { t (ms since reset), kind, value }.
		log: [],
	}
}
reset()
const note = (kind, value) => st.log.push({ t: Date.now() - st.started, kind, value })

const page = (title, body, extra = '') => `<!doctype html><html><head><meta charset=utf-8><title>${title}</title><style>
body{font:15px sans-serif;margin:20px;max-width:760px}section{border:1px solid #ccc;padding:10px;margin:10px 0}
.menu{position:relative;display:inline-block}.menu .dd{display:none;position:absolute;background:#eee;border:1px solid #999;padding:6px;min-width:120px}.menu:hover .dd{display:block}
.modal{position:fixed;inset:0;background:rgba(0,0,0,.5);display:none;align-items:center;justify-content:center}.modal.on{display:flex}.modal div{background:#fff;padding:20px}
.banner{position:fixed;left:0;right:0;bottom:0;top:0;background:rgba(255,255,255,.92);display:flex;align-items:flex-end;justify-content:center}.banner div{background:#222;color:#fff;padding:14px;width:100%}
td,th{border:1px solid #aaa;padding:4px 10px}</style></head><body>${body}${extra}</body></html>`

const post = `const post=(k,v)=>fetch('/api/'+k,{method:'POST',body:JSON.stringify(v)});const $=s=>document.querySelector(s);`

// ---------------------------------------------------------------- the portal (A2)
const portal = `<h1>Tidewater Portal</h1>
<section id=loginbox><h2>Sign in</h2><p>Demo account: <b>demo</b> / <b>sesame</b></p>
<form id=lf><label>Username <input name=user id=user></label> <label>Password <input type=password name=pass id=pass></label> <button type=submit>Sign in</button></form><p id=lmsg style="color:red"></p></section>
<div id=app style="display:none">
<section><h2>Account</h2><label>Plan <select id=plan><option value="">-- choose --</option><option>Free</option><option>Silver</option><option>Gold</option><option>Platinum</option></select></label><br>
<label><input type=checkbox id=email> Email updates</label> <label><input type=checkbox id=sms> SMS updates</label> <label><input type=checkbox id=terms> Accept terms</label></section>
<section><h2>Plans</h2><table><tr><th>Plan</th><th>Monthly price</th><th>Seats</th></tr><tr><td>Free</td><td>$0</td><td>1</td></tr><tr><td>Silver</td><td>$17</td><td>5</td></tr><tr><td>Gold</td><td>$42</td><td>20</td></tr><tr><td>Platinum</td><td>$99</td><td>100</td></tr></table></section>
<section><div class=menu><b>Products</b><div class=dd><a href="#" id=m-reports>Reports</a><br><a href="#" id=m-alerts>Alerts</a></div></div> <span id=menumsg></span></section>
<section><h2>Search</h2><input id=q placeholder="Search docs"> <button id=sb>Search</button><ul id=res></ul></section>
<section><a href="/code" target=_blank id=codelink>Get verification code</a></section>
<section><h2>Verify</h2><iframe src="/frame" width=500 height=130 title=verify></iframe></section>
<div style="height:1600px"></div>
<section><button id=confirm>Confirm order</button> <span id=cmsg></span></section></div>
<div class=modal id=modal><div><p>Are you sure you want to confirm the order?</p><button id=no>Cancel</button> <button id=yes>Yes</button></div></div>
<script>${post}
$('#lf').onsubmit=async e=>{e.preventDefault();const r=await(await fetch('/api/login',{method:'POST',body:JSON.stringify({u:$('#user').value,p:$('#pass').value})})).json();if(r.ok){$('#loginbox').innerHTML='<p>Signed in as demo</p>';$('#app').style.display='block'}else $('#lmsg').textContent='Invalid username or password'}
$('#plan').onchange=e=>post('plan',e.target.value);for(const k of['email','sms','terms'])$('#'+k).onchange=e=>post(k,e.target.checked)
$('#m-reports').onclick=e=>{e.preventDefault();post('menu','Reports');$('#menumsg').textContent='Reports opened'};$('#m-alerts').onclick=e=>{e.preventDefault();post('menu','Alerts');$('#menumsg').textContent='Alerts opened'}
$('#sb').onclick=async()=>{const r=await(await fetch('/api/search',{method:'POST',body:JSON.stringify($('#q').value)})).json();$('#res').innerHTML=r.map(x=>'<li><a href="#" class=hit>'+x+'</a></li>').join('')||'<li>No results</li>';for(const a of document.querySelectorAll('.hit'))a.onclick=e=>{e.preventDefault();post('result',a.textContent)}}
$('#q').onkeydown=e=>{if(e.key==='Enter')$('#sb').click()}
$('#confirm').onclick=()=>$('#modal').classList.add('on');$('#no').onclick=()=>$('#modal').classList.remove('on');$('#yes').onclick=()=>{post('confirm',1);$('#modal').classList.remove('on');$('#cmsg').textContent='Order confirmed'}
</script>`

// ---------------------------------------------------------------- micro-task pages
const pages = {
	// S: a native select. The page never echoes the value; the model has to read it back.
	'/s': page(
		'Colour picker',
		`<h1>Colour picker</h1><section><label>Colour <select id=color><option value="">-- choose --</option><option>Red</option><option>Green</option><option>Teal</option><option>Violet</option></select></label></section>
<script>${post}$('#color').onchange=e=>post('color',e.target.value)</script>`,
	),
	// H: a menu that opens on hover; its trigger is plain text inside a wide block.
	'/h': page(
		'Tools menu',
		`<h1>Tools</h1><section><div class=menu><b>Tools</b><div class=dd><a href="#" id=t-export>Export</a><br><a href="#" id=t-archive>Archive</a></div></div> <span id=tmsg></span></section>
<script>${post}for(const [i,n] of [['t-export','Export'],['t-archive','Archive']])$('#'+i).onclick=e=>{e.preventDefault();post('tool',n);$('#tmsg').textContent=n+' done'}</script>`,
	),
	// E: a page-made modal that closes on Escape and on its Close button.
	'/e': page(
		'Settings',
		`<h1>Settings</h1><section><button id=open>Open settings</button><p id=state>Settings closed</p></section>
<div class=modal id=modal role=dialog aria-label="Settings"><div><p>Display settings</p><button id=close>Close</button></div></div>
<script>${post}const m=$('#modal');$('#open').onclick=()=>{m.classList.add('on');post('modalOpened',1)};$('#close').onclick=()=>{m.classList.remove('on');post('modalButton',1);$('#state').textContent='Settings closed'}
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&m.classList.contains('on')){m.classList.remove('on');post('modalEscape',1);$('#state').textContent='Settings closed'}})</script>`,
	),
	// K: a cookie banner covers the page; the Subscribe button is under it.
	'/k': page(
		'Newsletter',
		`<h1>Newsletter</h1><section><button id=sub>Subscribe</button> <span id=smsg></span></section>
<div class=banner id=banner><div>We use cookies. <button id=accept>Accept cookies</button></div></div>
<script>${post}$('#accept').onclick=()=>{$('#banner').remove();post('cookie',1)};$('#sub').onclick=()=>{post('subscribe',1);$('#smsg').textContent='Subscribed'}
$('#banner').addEventListener('click',e=>{if(e.target===$('#banner'))post('subscribeBlocked',1)})</script>`,
	),
	// D: an autocomplete that builds its list from key events only (a plain fill never fires them).
	'/d': page(
		'City search',
		`<h1>City search</h1><section><label>City <input id=city autocomplete=off></label><ul id=sug></ul><p id=cmsg></p></section>
<script>${post}const all=['Lisbon','Limassol','Lima','Lisburn','Oslo'];const sug=$('#sug');
$('#city').addEventListener('keydown',()=>setTimeout(()=>{const v=$('#city').value.toLowerCase();sug.innerHTML=v?all.filter(c=>c.toLowerCase().startsWith(v)).map(c=>'<li><a href="#" class=pick>'+c+'</a></li>').join(''):'';for(const a of sug.querySelectorAll('.pick'))a.onclick=e=>{e.preventDefault();post('city',a.textContent);$('#cmsg').textContent='City set to '+a.textContent;sug.innerHTML=''}},0))</script>`,
	),
	// L: the content is built 1.5 s after load.
	'/l': page(
		'Reports',
		`<h1>Reports</h1><div id=root><p>Loading…</p></div>
<script>${post}setTimeout(()=>{$('#root').innerHTML='<section><h2>Quarterly summary</h2><button id=dl>Download summary</button> <span id=lmsg></span></section>';$('#dl').onclick=()=>{post('report',1);$('#lmsg').textContent='Summary downloaded'}},1500)</script>`,
	),
	// F: a form in a frame served from another origin.
	'/f': page(
		'Feedback',
		`<h1>Feedback</h1><section><iframe id=fb src="http://localhost:${PORT}/f-frame" width=520 height=140 title=feedback></iframe></section>`,
	),
	// SH: a button inside an open shadow root.
	'/sh': page(
		'Shadow',
		`<h1>Shadow</h1><section><div id=host></div><p id=smsg></p></section>
<script>${post}const r=$('#host').attachShadow({mode:'open'});r.innerHTML='<button id=go>Shadow go</button>';r.querySelector('#go').onclick=()=>{post('shadow',1);$('#smsg').textContent='Shadow went'}</script>`,
	),
	// T: a link opens a popup tab with a button; the task finishes on the first tab.
	'/t': page(
		'Help desk',
		`<h1>Help desk</h1><section><a href="/t-popup" target=_blank id=help>Open help</a></section><section><button id=finish>Finish</button> <span id=fmsg></span></section>
<script>${post}$('#finish').onclick=()=>{post('finish',1);$('#fmsg').textContent='Finished'};$('#help').addEventListener('click',()=>post('popupOpened',1))</script>`,
	),
	'/t-popup': page(
		'Help',
		`<h1>Help</h1><p>Read the notice, then confirm.</p><button id=done>Mark read</button> <span id=dmsg></span>
<script>${post}$('#done').onclick=()=>{post('popupDone',1);$('#dmsg').textContent='Marked'}</script>`,
	),
}

const send = (res, code, body, type = 'text/html') => {
	res.writeHead(code, { 'content-type': type })
	res.end(body)
}
const json = (res, v) => send(res, 200, JSON.stringify(v), 'application/json')

// ---------------------------------------------------------------- scoring
const TASKS = {
	A2: {
		plan: () => st.plan === 'Gold' && st.email && st.terms && !st.sms,
		menu: () => st.menu === 'Reports',
		search: () => st.result === 'Tide tables',
		confirm: () => st.confirmed,
		verify: () => st.verified,
	},
	S: { color: () => st.color === 'Teal' },
	H: { tool: () => st.tool === 'Archive' },
	E: { opened: () => st.modalOpened, escape: () => st.modalEscape > 0 },
	K: { cookie: () => st.cookie, subscribe: () => st.subscribe > 0 },
	D: { city: () => st.city === 'Lisbon' },
	L: { report: () => st.report > 0 },
	F: { note: () => st.note === 'hello' },
	SH: { shadow: () => st.shadow > 0 },
	T: { popup: () => st.popupDone, finish: () => st.finish > 0 },
}

function score(task) {
	const defs = TASKS[task]
	if (!defs) return null
	const steps = {}
	for (const [name, ok] of Object.entries(defs)) steps[name] = Boolean(ok())
	const done = Object.values(steps).filter(Boolean).length
	// Wrong actions the site saw: a click that hit the banner, a wrong code, a wrong menu item.
	const extra = { wrongCode: st.wrongCode, subscribeBlocked: st.subscribeBlocked }
	return { task, steps, done, total: Object.keys(defs).length, extra, events: st.log.length }
}

process.on('uncaughtException', (error) => console.error('bench site:', error))
http
	.createServer(async (req, res) => {
		let b = ''
		for await (const c of req) b += c
		let url
		try {
			url = new URL(req.url, 'http://x')
		} catch {
			// A model probing the site with curl can send an address that is not one; answer, never crash.
			return send(res, 400, 'bad request')
		}
		const u = url.pathname
		if (u === '/')
			return send(
				res,
				200,
				page(
					'Tidewater Portal',
					url.searchParams.has('signed')
						? portal
								.replace('<div id=app style="display:none">', '<div id=app>')
								.replace('<section id=loginbox>', '<section id=loginbox style="display:none">')
						: portal,
				),
			)
		if (pages[u]) return send(res, 200, pages[u])
		if (u === '/f-frame')
			return send(
				res,
				200,
				page(
					'Feedback form',
					`<form method=post action="/f-submit"><label>Note <input name=note id=note></label> <button type=submit>Send note</button></form>`,
				),
			)
		if (u === '/f-submit') {
			const v = new URLSearchParams(b).get('note')
			st.note = v
			st.noteOrigin = req.headers.host
			note('note', v)
			return send(res, 200, page('Sent', `<p id=ok>Note sent: ${String(v).replace(/[<&]/g, '')}</p>`))
		}
		if (u === '/code') {
			st.codeViewed = true
			note('codeViewed', 1)
			return send(res, 200, page('Verification code', `<h1>Verification code</h1><p>Your code is <b id=code>${CODE}</b></p>`))
		}
		if (u === '/frame')
			return send(
				res,
				200,
				page('Verify', `<form method=post action="/verify"><label>Code <input name=code id=code></label> <button type=submit>Verify</button></form>`),
			)
		if (u === '/verify') {
			const c = new URLSearchParams(b).get('code')
			if (c === CODE && st.codeViewed) {
				st.verified = true
				note('verified', 1)
				return send(res, 200, page('Verified', `<p id=ok>Verified. Token: <b>${TOKEN}</b></p>`))
			}
			st.wrongCode++
			note('wrongCode', c)
			return send(res, 200, page('Verify', '<p>Wrong code. <a href="/frame">Back</a></p>'))
		}
		if (u === '/state') return json(res, st)
		if (u === '/score') return json(res, score(url.searchParams.get('task') ?? ''))
		if (u === '/reset') {
			reset()
			return send(res, 200, 'ok')
		}
		if (u.startsWith('/api/')) {
			const k = u.slice(5)
			let v
			try {
				v = JSON.parse(b)
			} catch {}
			note(k, v)
			if (k === 'login') {
				const ok = v?.u === 'demo' && v?.p === 'sesame'
				if (ok) st.loggedIn = true
				else st.loginFails++
				return json(res, { ok })
			}
			if (k === 'search') {
				st.search = v
				const all = ['Tide tables', 'Tidal energy primer', 'Harbour map', 'Tide gauge manual']
				return json(res, all.filter((x) => x.toLowerCase().includes(String(v).toLowerCase())))
			}
			if (k === 'confirm') st.confirmed = true
			else if (['modalOpened', 'modalButton', 'cookie', 'popupOpened', 'popupDone'].includes(k)) st[k] = true
			else if (['modalEscape', 'subscribe', 'subscribeBlocked', 'report', 'shadow', 'finish'].includes(k)) st[k]++
			else st[k] = v
			return json(res, {})
		}
		send(res, 404, 'not found')
	})
	.listen(PORT, '127.0.0.1', () => console.log('bench site on', PORT))
