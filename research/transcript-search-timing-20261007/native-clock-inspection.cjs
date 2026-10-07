"use strict";
const fs=require('node:fs'),path=require('node:path');
const root=path.join(process.env.LOCALAPPDATA,'Namzu','Development');
const config=JSON.parse(fs.readFileSync(path.join(root,'launch.json')));
const {chromium}=require(path.join(root,'runtime/packages/p39'));
(async()=>{
 const port=Number(fs.readFileSync(path.join(process.env.APPDATA,'Namzu','DevToolsActivePort'),'utf8').split(/\r?\n/)[0]);
 const browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
 try{
  const page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url()===new URL(config.url).href);
  const data=await page.evaluate(async()=>{
   const api=window.namzu,w=await api.workspace();
   const win=w.layout.windows.find(item=>item.id===w.windowId);
   const visit=n=>!n?[]:n.kind==='group'?[n]:[...visit(n.first),...visit(n.second)];
   const groups=visit(win.root);
   const projects=await api.projects();
   const views=(await Promise.all(projects.filter(p=>p.status==='ready').map(p=>api.conversations(p.id)))).flat();
   return Promise.all(groups.flatMap(g=>g.tabs).map(async id=>{
    const v=views.find(v=>v.id===id),h=await api.openConversation(v.projectId,id);
    return {id,active:groups.some(g=>g.activeTabId===id),pal:Boolean(v.palId),harness:v.harness??'namzu',running:h.thread?.running,queued:h.thread?.queued?.length,messages:h.messages.map((m,index)=>({index,role:m.role,id:m.messageId,time:m.time})),workAnchors:h.thread?.historyWork?.messages};
   }));
  });
  const output=path.join(root,'native-clock-inspection-private-20261007-v1.json');
  fs.writeFileSync(output,JSON.stringify(data,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify(data));
 }finally{await browser.close();}
})().catch(e=>{console.error(e.name);process.exitCode=1;});
