// Production native Windows renderer/main/projection; controlled ACP transport.
// This does not send a model prompt or alter the user's projects/conversations.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
assert.equal(process.platform,'win32')
const [app, electron, playwright, fixture, testModule] = process.argv.slice(2)
const require=createRequire(import.meta.url)
const {_electron}=require(playwright)
const {expect}=require(testModule ?? '@playwright/test')
const root=mkdtempSync(join(tmpdir(),'namzu-transcript-native-'))
const project=join(root,'project');mkdirSync(project)
const control=join(root,'control.json');writeFileSync(control,'{}')
const env={...process.env,NAMZU_DESKTOP_CLI:fixture,NAMZU_HOME:join(root,'home'),NAMZU_TRANSCRIPT_CONTROL:control}
delete env.ELECTRON_RUN_AS_NODE;delete env.NAMZU_DESKTOP_DEV_URL
let revision=0
const checks=[]
const native=await _electron.launch({executablePath:electron,args:[app,`--user-data-dir=${join(root,'desktop')}`],env,cwd:root})
try {
 await native.evaluate(({dialog,BrowserWindow},p)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[p]});dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});BrowserWindow.getAllWindows()[0].setBounds({x:0,y:0,width:1678,height:900})},project)
 const page=await native.firstWindow();const faults=[];page.on('pageerror',error=>faults.push(error.message))
 await page.bringToFront();await native.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].focus());await page.waitForFunction(()=>document.hasFocus())
 await page.emulateMedia({reducedMotion:'no-preference'})
 await page.getByRole('button',{name:'Open a project',exact:true}).last().click()
 await page.getByRole('textbox',{name:'Message Namzu',exact:true}).fill('Controlled transcript verification')
 await page.getByRole('button',{name:'Send message',exact:true}).click()
 await expect(page.locator('[data-transcript-phase]')).toHaveAttribute('data-transcript-phase','working')
 const stage=async value=>writeFileSync(control,JSON.stringify({revision:++revision,stage:value}))
 const snap=async name=>{
  await page.evaluate(()=>Promise.all(document.getAnimations().filter(animation=>animation.effect?.getTiming().iterations!==Infinity).map(animation=>animation.finished.catch(()=>undefined))))
  return page.screenshot({path:join(root,`${name}.png`)})
 }
 await snap('working');checks.push('Working before public reasoning')
 await stage('thinking');await expect(page.locator('[data-transcript-phase]')).toHaveAttribute('data-transcript-phase','thinking')
 await expect(page.locator('.project-context-activity').filter({visible:true})).toContainText('Thinking')
 await expect(page.locator('.reasoning')).toContainText('Compare the reported events');await snap('thinking');checks.push('Actual reasoning lifecycle drives Thinking and ordered summary')
 await stage('tools');await expect(page.locator('[data-transcript-phase]')).toHaveAttribute('data-transcript-phase','tools')
 await page.locator('[data-tool-call-id=read] > .tool-trigger').click()
 await expect(page.locator('[data-tool-call-id=read] > .tool-trigger')).toHaveAttribute('aria-expanded','true')
 await stage('more-tools')
 await expect(page.locator('.tool-group .tool-trigger').first()).toContainText('Running commands');await snap('tools')
 await expect(page.locator('[data-tool-call-id=read] > .tool-trigger')).toHaveAttribute('aria-expanded','true');checks.push('Open command details survive admission of the next grouped command')
 await stage('permission');await expect(page.locator('[data-transcript-phase]')).toHaveAttribute('data-transcript-phase','waiting')
 await expect(page.getByRole('region',{name:'Tool approval',exact:true})).toBeVisible();await snap('waiting')
 await page.reload();await page.locator('.conversations').getByRole('button',{name:'Controlled transcript verification',exact:true}).click()
 await expect(page.locator('[data-transcript-phase]')).toHaveAttribute('data-transcript-phase','waiting')
 await page.getByRole('button',{name:'Allow once',exact:true}).click()
 await expect(page.getByRole('region',{name:'Tool approval',exact:true})).toHaveCount(0)
 await expect(page.locator('.tool-group .tool-trigger').first()).toContainText('Ran commands')
 checks.push('Permission priority and live snapshot reload retain exact activity')
 await stage('answer');await expect(page.locator('[data-message-phase=final_answer]')).toContainText('Draft result')
 await expect(page.locator('[data-transcript-phase]')).toHaveAttribute('data-transcript-phase','responding')
 await stage('finish');await expect(page.locator('[data-transcript-phase]')).toHaveCount(0)
 await expect(page.locator('.project-context-activity')).toHaveCount(0)
 await expect(page.locator('[data-message-phase=final_answer]')).toContainText('Verified final result.')
 const activity=page.locator('.activity-trigger').first();await expect(activity).toContainText('Worked for')
 await expect(activity).toHaveAttribute('aria-expanded','false');await snap('completed')
 // Probe finite frame motion with paused animation time, not a wall-clock race.
 const motion=await page.evaluate(()=>new Promise(resolve=>{
  const root=document.querySelector('.turn-activity')
  const observer=new MutationObserver(()=>{
   const panel=root.querySelector('[data-slot=collapsible-panel]');if(!panel)return
   getComputedStyle(panel).height
   const animations=panel.getAnimations();if(!animations.length)return
   observer.disconnect();const frames=[]
   for(const animation of animations){animation.pause();const duration=Number(animation.effect.getTiming().duration);animation.currentTime=duration/2;frames.push({duration,height:getComputedStyle(panel).height,easing:animation.effect.getTiming().easing});animation.finish()}
   resolve({frames,height:getComputedStyle(panel).height})
  })
  observer.observe(root,{subtree:true,childList:true,attributes:true})
  root.querySelector('.activity-trigger').click()
 }))
 process.stdout.write(JSON.stringify({step:'motion',motion})+'\n')
 assert.ok(motion.frames.some(frame=>frame.duration===200));checks.push('Activity frame height animates for 200ms')
 await expect(page.locator('.reasoning')).toBeVisible()
 if(await page.locator('.tool-group > .tool-trigger').getAttribute('aria-expanded')!=='true')await page.locator('.tool-group > .tool-trigger').click();await expect(page.locator('[data-tool-call-id=read]')).toBeVisible()
 if(await page.locator('[data-tool-call-id=read] > .tool-trigger').getAttribute('aria-expanded')!=='true')await page.locator('[data-tool-call-id=read] > .tool-trigger').click();await expect(page.locator('.tool-content').first()).toContainText('Fixture output')
 await snap('expanded');checks.push('Ordered disclosure and actual typed command output')
 await page.getByRole('textbox',{name:'Message Namzu',exact:true}).fill('Second controlled turn')
 await page.getByRole('button',{name:'Send message',exact:true}).click();await expect(page.locator('[data-transcript-phase]')).toHaveAttribute('data-transcript-phase','working')
 await stage('blocked');await expect(page.locator('[data-transcript-phase]')).toHaveCount(0)
 await expect(page.locator('.conversation-body')).not.toContainText('BLOCKED_TRANSCRIPT_FIXTURE')
 await expect(page.locator('.notice').filter({hasText:'guardrail'})).toBeVisible()
 await expect(page.locator('[data-activity-turn="1"] .reasoning')).toContainText('Compare the reported events')
 checks.push('Follow-up retains past thoughts; authoritative empty result clears blocked output')
 await page.getByRole('textbox',{name:'Message Namzu',exact:true}).fill('Cancel controlled turn')
 await page.getByRole('button',{name:'Send message',exact:true}).click();await expect(page.locator('[data-transcript-phase]')).toHaveAttribute('data-transcript-phase','working')
 await page.getByRole('button',{name:'Stop turn',exact:true}).click();await expect(page.locator('.notice').filter({hasText:'Stopped.'})).toBeVisible()
 checks.push('Preparation cancellation gets terminal notice without a streamed end')
 await page.emulateMedia({reducedMotion:'reduce'})
 await activity.click();await activity.click()
 assert.equal(await page.locator('.turn-activity [data-slot=collapsible-panel]').first().evaluate(node=>getComputedStyle(node).transitionDuration),'0s')
 await native.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setBounds({x:0,y:0,width:640,height:620}))
 await expect(page.getByRole('textbox',{name:'Message Namzu',exact:true})).toBeVisible();await snap('narrow-reduced')
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
 checks.push('Reduced motion and narrow/short transcript without horizontal overflow')
 assert.deepEqual(faults,[])
 const receipt={passed:true,nativeWindows:true,productionMainRenderer:true,modelIo:'controlled ACP transport; SDK mapper covered separately',userData:'isolated temporary directory',checks,motion,rendererErrors:0,screenshotDirectory:root}
 writeFileSync(join(root,'receipt.json'),JSON.stringify(receipt,null,2));process.stdout.write(JSON.stringify(receipt)+'\n')
} finally {await native.close()}
