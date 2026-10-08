const page = 'https://github.com/composio-community/open-dot'
const r = await fetch(page, {redirect:'manual', headers:{Accept:'text/html'}})
console.log('page', r.status, r.headers.get('content-type'))
const html = (await r.text())
const head = html.slice(0, html.search(/<\/head/i)+7)
const tag = head.match(/<meta[^>]+(?:property|name)=["']og:image["'][^>]*>/i)?.[0]
console.log(tag)
const raw = tag.match(/content=["']([^"']+)["']/i)[1].replaceAll('&amp;','&')
let url = new URL(raw, page).href
for (let hop=0; hop<6; hop++) {
  const x = await fetch(url, {redirect:'manual', headers:{Accept:'image/avif,image/webp,image/png,image/jpeg,image/gif,image/x-icon;q=0.9,*/*;q=0.1'}})
  console.log(hop, x.status, url, x.headers.get('content-type'), x.headers.get('content-length'), x.headers.get('location'))
  const loc = x.headers.get('location')
  if (x.status>=300 && x.status<400 && loc) { url = new URL(loc, url).href; continue }
  const b = Buffer.from(await x.arrayBuffer()); console.log('bytes', b.length, b.subarray(0,12).toString('hex')); break
}
