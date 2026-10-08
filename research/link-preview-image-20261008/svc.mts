import dns from 'node:dns/promises'
import { createLinkPreviewService, isPublicAddress } from '/home/arda/workspaces/@cogitave/cogitave/namzu/packages/desktop/src/main/link-preview.ts'
for (const h of ['opengraph.githubassets.com','github.com','avatars.githubusercontent.com']) {
  const a = [...await dns.resolve4(h).catch(()=>[]), ...await dns.resolve6(h).catch(()=>[])]
  console.log(h, a.map(x=>x+':'+isPublicAddress(x)).join(' '))
}
const network = {
  resolve: async h => (await dns.lookup(h,{all:true})).map(x=>x.address),
  request: async (url, accept, signal) => {
    const r = await fetch(url,{redirect:'manual',signal,headers:{Accept:accept}})
    const it = r.body ? r.body[Symbol.asyncIterator]() : null
    return {status:r.status, location:r.headers.get('location')??undefined, header:n=>r.headers.get(n)??undefined,
      body:{[Symbol.asyncIterator]:()=>it ?? (async function*(){})()}, cancel(){ r.body?.cancel().catch(()=>{}) }}
  }}
const svc = createLinkPreviewService({network})
const p = await svc.page('https://github.com/composio-community/open-dot')
const og = p.head.match(/og:image" content="([^"]+)"/)[1]
const t=Date.now(); const img = await svc.image(og,'image'); console.log('image', img?.slice(0,30), img?.length, Date.now()-t)
