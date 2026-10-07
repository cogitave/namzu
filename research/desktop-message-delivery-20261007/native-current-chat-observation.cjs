'use strict';
// Read only the currently focused native chat. Full contents remain private.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
assert.equal(process.platform, 'win32');
const root = path.join(process.env.LOCALAPPDATA, 'Namzu', 'Development');
const output = path.resolve(process.argv[2] ?? '');
assert.equal(path.dirname(output).toLowerCase(), root.toLowerCase());
assert(!fs.existsSync(output));
const config = JSON.parse(fs.readFileSync(path.join(root, 'launch.json')));
const pid = Number(fs.readFileSync(path.join(root, 'desktop.pid'), 'utf8'));
process.kill(pid, 0);
const { chromium } = require(path.join(root, 'runtime/packages/p39'));
(async () => {
 const port = Number(fs.readFileSync(path.join(process.env.APPDATA, 'Namzu', 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]);
 const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
 try {
  const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url() === new URL(config.url).href);
  assert(page);
  const observation = await page.evaluate(async () => {
   const api = window.namzu;
   const workspace = await api.workspace();
   const current = workspace.layout.windows.find(w => w.id === workspace.windowId);
   const visit = n => !n ? [] : n.kind === 'group' ? [n] : [...visit(n.first), ...visit(n.second)];
   const group = visit(current.root).find(g => g.id === current.focusedGroupId);
   const projects = await api.projects();
   const matches = await Promise.all(projects.filter(p => p.status === 'ready').map(async p => ({ project: p, view: (await api.conversations(p.id)).find(v => v.id === group.activeTabId) })));
   const owner = matches.find(m => m.view);
   if (!owner || owner.view.palId) throw new Error('The focused ordinary chat is unavailable.');
   const history = await api.openConversation(owner.project.id, owner.view.id);
   return {workspace, group, project: owner.project, view: owner.view, history,
    draft: await api.draft(owner.view.id), settings: await api.draftSettings(owner.view.id),
    dom: {working: [...document.querySelectorAll('.transcript')].map(e => e.innerText.slice(-4000)),
     inputDisabled: document.querySelector('textarea[aria-label="Message Namzu"]')?.disabled,
     buttons: [...document.querySelectorAll('button[aria-label]')].filter(b => /send|queue|stop/i.test(b.ariaLabel)).map(b => ({label:b.ariaLabel,disabled:b.disabled}))}};
  });
  fs.writeFileSync(output, JSON.stringify({pid,at:new Date().toISOString(),observation},null,2)+'\n',{flag:'wx'});
  const thread = observation.history.thread;
  console.log(JSON.stringify({observed:true,ownerDigest:crypto.createHash('sha256').update(observation.view.id).digest('hex'),harness:observation.view.harness??'namzu',running:thread?.running,responding:thread?.responding,queued:thread?.queued?.length,stopReason:thread?.stopReason,messageCount:observation.history.messages.length,inputDisabled:observation.dom.inputDisabled,buttons:observation.dom.buttons}));
 } finally {await browser.close();}
 process.kill(pid,0);
})().catch(error=>{console.error(error.name);process.exitCode=1;});
