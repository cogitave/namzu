const u='https://opengraph.githubassets.com/794bd82ff5b952503c05ff33591d90aa159a0c2973fd403844b71f9d647a9a6b/composio-community/open-dot'
const bad='https://opengraph.githubassets.com/0000000000000000000000000000000000000000000000000000000000000000/composio-community/open-dot'
const c={}
for (let i=0;i<40;i++){ const r=await fetch(u+(i%2?'?x='+i:''),{redirect:'manual'}); await r.arrayBuffer(); c[r.status]=(c[r.status]||0)+1 }
console.log(c)
const r=await fetch(bad,{redirect:'manual'}); console.log('badhash',r.status,r.headers.get('content-type'),r.headers.get('location'))
const r2=await fetch('https://opengraph.githubassets.com/1/composio-community/open-dot',{redirect:'manual'}); console.log('hash1',r2.status,r2.headers.get('content-type'),r2.headers.get('location'))
