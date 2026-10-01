/** Inspect Chromium's resolved font faces, not only its declared CSS list. */
export async function inspectPlatformFonts(page, selectors) {
 await page.evaluate(() => document.fonts.ready)
 const cdp=await page.context().newCDPSession(page)
 try {
  await cdp.send('DOM.enable')
  await cdp.send('CSS.enable')
  const {root}=await cdp.send('DOM.getDocument',{depth:-1,pierce:true})
  const result={}
  for(const [name,selector] of selectors) {
   const styles=await page.locator(selector).first().evaluate(node=>{
    const css=getComputedStyle(node)
    return {fontFamily:css.fontFamily,fontSize:css.fontSize,fontWeight:css.fontWeight,lineHeight:css.lineHeight,letterSpacing:css.letterSpacing}
   })
   const {nodeId}=await cdp.send('DOM.querySelector',{nodeId:root.nodeId,selector})
   const direct=await cdp.send('CSS.getPlatformFontsForNode',{nodeId})
   // Replaced elements such as textarea may not expose glyph nodes to CDP.
   // Record that fact, then resolve an identically styled explicit text probe.
   const id=`font-probe-${name}`
   await page.evaluate(({id,styles})=>{
    const probe=document.createElement('span');probe.id=id;probe.setAttribute('aria-hidden','true')
    Object.assign(probe.style,styles,{position:'fixed',left:'0px',top:'0px',zIndex:'9999',pointerEvents:'none',whiteSpace:'pre'})
    probe.textContent='Namzu Aa 0123456789 Working src/session.ts'
    document.body.append(probe)
   },{id,styles})
   await page.evaluate(async()=>{await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame)})
   const probeNode=await cdp.send('DOM.querySelector',{nodeId:root.nodeId,selector:`#${id}`})
   const probe=await cdp.send('CSS.getPlatformFontsForNode',{nodeId:probeNode.nodeId})
   await page.evaluate(id=>document.getElementById(id).remove(),id)
   result[name]={declared:styles,actualNodeFonts:direct.fonts,explicitTextProbeFonts:probe.fonts}
  }
  return {platform:process.platform,faces:await page.evaluate(()=>[...document.fonts].map(face=>({family:face.family,status:face.status,weight:face.weight}))),roles:result}
 } finally {await cdp.detach()}
}
