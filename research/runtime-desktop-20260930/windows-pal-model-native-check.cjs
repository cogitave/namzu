// Run through the owned native Windows Electron driver. No model prompt is sent.
// The temporary default-model edit is restored, including on assertion failure.
const assert = require('node:assert/strict')

module.exports = async function verifyPalModel({ page, palId, receipt }) {
 const api = callback => page.evaluate(callback, palId)
 const profile = () => api(async id => (await window.namzu.pals()).find(p => p.id === id))
 const original = await profile()
 assert.ok(original?.model, 'Choose an existing Pal with a catalogued default model')
 const route = () => api(async id => {
  const opened = await window.namzu.openPal(id)
  const latest = [...opened.conversations].sort((a,b) => b.updatedAt.localeCompare(a.updatedAt))[0]
  if (latest) await window.namzu.openConversation(opened.project.id,latest.id)
  return latest ? (await window.namzu.providers(opened.project.id, latest.id)).selected : null
 })
 const originalRoute = await route()
 const { models } = await page.evaluate(provider => window.namzu.palModels(provider), original.model.provider)
 const providers = await page.evaluate(() => window.namzu.palProviders())
 const providerLabel = providers.available.find(p => p.id === original.model.provider).label
 const oldModel = models.find(m => m.id === original.model.model)
 const alternative = models.find(m => m.id !== original.model.model)
 assert.ok(oldModel && alternative, 'Two accessible catalogue entries are required')
 const picker = page.getByRole('button', { name:'Select model', exact:true })
 const option = model => page.getByRole('radio', { name:`${providerLabel} ${model.label}`, exact:true })
 const close = page.getByRole('button', { name:'Close customization', exact:true })
 const customize = async () => {
  await page.getByRole('button', { name:`Customize ${original.name}`, exact:true }).click()
  // Wait for the modal's own initial focus before opening its nested popover.
  await page.waitForFunction(() => document.activeElement?.closest('.pal-name-preview'), undefined, {timeout:30000})
  await page.evaluate(() => Promise.all(document.getAnimations()
   .filter(animation => animation.effect?.getTiming().iterations !== Infinity)
   .map(animation => animation.finished.catch(() => undefined))))
 }
 const save = async () => {
  await page.getByRole('button', { name:'Save', exact:true }).click()
  await close.waitFor({ state:'hidden' })
 }
 try {
  await page.reload()
  await page.getByRole('button', { name:original.name, exact:true }).click()
  await customize()
  assert.equal(await page.getByText('What should your Pal help with?', { exact:true }).count(),0)
  await picker.click()
  await option(oldModel).waitFor()
  assert.equal(await option(oldModel).getAttribute('aria-checked'),'true')
  const layers = await option(alternative).evaluate(node => {
   const box=node.getBoundingClientRect()
   return {
    actionable:node.contains(document.elementFromPoint(box.x+box.width/2,box.y+box.height/2)),
    model:getComputedStyle(node.closest('[data-slot=popover-positioner]')).zIndex,
    dialog:getComputedStyle(document.querySelector('.pal-customize-viewport')).zIndex,
   }
  })
  assert.equal(layers.actionable,true)
  receipt.visibleModelRows=await page.locator('.model-picker-popup [role=radio]').filter({visible:true}).count()
  await option(alternative).click()
  await save()
  const changed=await profile()
  assert.deepEqual(changed.model,{provider:original.model.provider,model:alternative.id})
  assert.equal(changed.name,original.name)
  assert.equal(changed.purpose,original.purpose)
  assert.deepEqual(changed.appearance,original.appearance)
  assert.deepEqual(await route(),originalRoute)
  await customize()
  await picker.click()
  await option(alternative).waitFor()
  assert.equal(await option(alternative).getAttribute('aria-checked'),'true')
  await option(oldModel).click()
  await save()
  assert.deepEqual((await profile()).model,original.model)
  receipt.modelSelection={nativePicker:true,layers,purposeFormRemoved:true,alternativeSaved:true,persistedSelectionReopened:true,currentConversationRouteRetained:true,existingPurposeMetadataRetained:true,originalModelRestored:true}
 } finally {
  const current=await profile()
  if (current && JSON.stringify(current.model)!==JSON.stringify(original.model)) {
   await page.evaluate(({id,revision,model})=>window.namzu.updatePal(id,revision,{model}),{id:current.id,revision:current.revision,model:original.model})
   await page.reload()
  }
 }
 return receipt
}
