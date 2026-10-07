"use strict";
// PREPARED ONLY. The owner reviews and explicitly runs this bounded UI repair.
// It opens two settled disclosures and restores the original distance to the end.
// No direct storage writes, model requests, inputs, installs or lifecycle actions.
// Manual toggles/scrolling may invoke the app's own presentation writer.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const hash = value => crypto.createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex");
const flags = process.argv.slice(2);
assert(flags.every(arg => arg === "--execute" || arg.startsWith("--activation=") || arg.startsWith("--expected-pid=")));
if (!flags.includes("--execute") || process.env.NAMZU_NATIVE_MOTION_REPAIR !== "1") {
	console.log(JSON.stringify({ preparedOnly: true, requires: "NAMZU_NATIVE_MOTION_REPAIR=1, --execute, --activation=transcript-motion-apply-private-20261007-v1.json and --expected-pid=25764", settledDisclosures: 2, directStorageWrites: 0, modelRequests: 0, restarts: 0 }));
} else {
	assert.equal(process.platform, "win32");
	assert.equal(flags.filter(arg => arg === "--execute").length, 1);
	const activationFlags = flags.filter(arg => arg.startsWith("--activation="));
	const pidFlags = flags.filter(arg => arg.startsWith("--expected-pid="));
	assert.equal(activationFlags.length, 1); assert.equal(pidFlags.length, 1);
	const activationName = activationFlags[0].slice("--activation=".length);
	assert(/^transcript-motion-apply-private-20261007-v[12]\.json$/.test(activationName));
	const expectedPid = Number(pidFlags[0].slice("--expected-pid=".length));
	assert(/^\d+$/.test(pidFlags[0].slice("--expected-pid=".length)));
	assert(Number.isSafeInteger(expectedPid) && expectedPid > 0 && expectedPid <= 2147483647);
	Promise.resolve().then(() => run(activationName, expectedPid)).catch(error => {console.error(JSON.stringify({passed:false,errorType:error.name,seePrivateReceipt:true}));process.exitCode=1});
}

async function run(activationName, expectedPid) {
	const root = path.join(process.env.LOCALAPPDATA, "Namzu", "Development");
	const rootReal = fs.realpathSync(root);
	function readPrivate(name) {
		assert.equal(path.basename(name),name);
		const file = path.join(root,name), real = fs.realpathSync(file);
		assert(!path.relative(rootReal,real).startsWith(".."));
		const stat=fs.lstatSync(file);assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=32*1024*1024);
		return {file,bytes:fs.readFileSync(file)};
	}
	const configInput=readPrivate("launch.json"),config=JSON.parse(configInput.bytes);
	const activationInput=readPrivate(activationName),activation=JSON.parse(activationInput.bytes);
	assert.equal(activation.phase,"verify");assert.equal(activation.passed,false);
	assert.equal(activation.cliModuleCopies,0);assert.equal(activation.sdkCopies,0);
	assert.equal(activation.error?.name,"AssertionError");
	assert(activation.error.message.startsWith("Protected presentation changed across activation"));
	assert(Array.isArray(activation.cliReviewedModules)&&activation.cliReviewedModules.length===7);
	assert(Array.isArray(activation.sdkReviewedModules)&&activation.sdkReviewedModules.length===2);
	for(const item of [...activation.cliReviewedModules,...activation.sdkReviewedModules])assert.equal(item.beforeSha256,item.afterSha256);
	const snapshotInput=readPrivate(activation.privateSnapshot),snapshot=JSON.parse(snapshotInput.bytes);
	const oldTail=Math.max(0,snapshot.dom.transcriptScrollRange-snapshot.dom.transcriptScrollTop);
	assert.equal(oldTail,443,"Only the reviewed original 443px reading distance may be restored");
	assert.equal(snapshot.groups.length,1);
	const expectedGroup=snapshot.groups[0];
	assert.equal(expectedGroup.activeTabId,snapshot.dom.activeTabId);
	const configHash=hash(configInput.bytes),activationHash=hash(activationInput.bytes),snapshotHash=hash(snapshotInput.bytes);
	const saved=entries=>entries.filter(([key])=>key!==`namzu.workspace.presentation:${snapshot.dom.activeTabId}`);
	const originalSaved=saved(snapshot.dom.presentations);
	const receiptPath=path.join(root,`transcript-motion-ui-repair-private-${new Date().toISOString().replaceAll(/[-:.]/g,"")}.json`);
	assert(!fs.existsSync(receiptPath));
	const receipt={at:new Date().toISOString(),preparedOnly:false,nativeWindows:true,expectedPid,activationName,activationSha256:activationHash,snapshotName:activation.privateSnapshot,snapshotSha256:snapshotHash,passed:false,phase:"preflight",actions:{disclosureClicks:0,wheelGestures:0,scrollAssignments:0,directStorageWrites:0,modelRequests:0,inputs:0,restarts:0},presentationWriter:"The app may save the manual UI choices and scroll position; the helper never writes storage directly",originalTailDistance:oldTail};
	const {chromium}=require(path.join(root,"runtime/packages/p39"));
	let browser;
	const assertPid=()=>{assert.equal(Number(fs.readFileSync(path.join(root,"desktop.pid"),"utf8").trim()),expectedPid);process.kill(expectedPid,0)};
	function journalHashes() {
		const wanted=activation.durableJournals;assert(wanted&&typeof wanted==="object");
		const ids=new Set(Object.keys(wanted)), found={};
		const directory=path.join(process.env.USERPROFILE,".namzu","projects");
		let entries=0;
		const visit=(dir,depth)=>{assert(depth<=2);for(const item of fs.readdirSync(dir,{withFileTypes:true})){assert(++entries<=50000);const file=path.join(dir,item.name),stat=fs.lstatSync(file);assert(!stat.isSymbolicLink());if(stat.isDirectory()){if(depth<2)visit(file,depth+1)}else if(stat.isFile()&&item.name.endsWith(".jsonl")){const id=item.name.slice(0,-6);if(!ids.has(id))continue;assert(!Object.hasOwn(found,id)&&stat.size<=128*1024*1024);found[id]=hash(fs.readFileSync(file))}}};
		assert(fs.lstatSync(directory).isDirectory()&&!fs.lstatSync(directory).isSymbolicLink());visit(directory,0);
		assert.deepEqual(found,wanted,"Authored journals changed before/during UI repair");return found;
	}
	try {
		assertPid();receipt.journalsBefore=journalHashes();
		const port=Number(fs.readFileSync(path.join(process.env.APPDATA,"Namzu","DevToolsActivePort"),"utf8").split(/\r?\n/)[0]);
		assert(Number.isInteger(port)&&port>0&&port<65536);
		browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
		const pages=browser.contexts().flatMap(context=>context.pages()).filter(page=>page.url()===new URL(config.url).href);
		assert.equal(pages.length,1);const page=pages[0];
		page.setDefaultTimeout(15000);
		const readUi=async()=>{
			assertPid();
			const raw=await page.evaluate(async()=>{
				const workspace=await window.namzu.workspace();
				const visit=node=>!node?[]:node.kind==="group"?[node]:[...visit(node.first),...visit(node.second)];
				const windowView=workspace.layout.windows.find(item=>item.id===workspace.windowId),groups=visit(windowView?.root);
				const group=groups.find(item=>item.id===windowView.focusedGroupId);
				const pane=[...document.querySelectorAll("[data-workspace-group]")].find(item=>item.dataset.workspaceGroup===group?.id);
				const normal=pane?.querySelector(".normal-transcript"),transcript=pane?.querySelector(".transcript");
				if(!normal||!transcript)throw new Error("Reviewed ordinary focused transcript absent");
				const visible=selector=>[...document.querySelectorAll(selector)].some(item=>item.getClientRects().length>0);
				if(visible('[role="dialog"], [role="alertdialog"], .thread-running-indicator, .composer-approval-strip, .queued-messages, .pal-computer-view canvas')||normal.querySelector('.working[aria-hidden="false"]'))throw new Error("Native UI has active work or another interactive context");
				return {workspace,groups,focusedGroupId:group.id,activeTabId:group.activeTabId,appearance:localStorage.getItem("namzu.appearance"),collapsedPreference:localStorage.getItem("namzu.sidebar-collapsed"),page:document.querySelector(".workspace")?.dataset.page,sidebarCollapsed:document.querySelector(".workspace-host")?.dataset.sidebarCollapsed,presentations:Object.keys(localStorage).filter(key=>key.startsWith("namzu.workspace.presentation:")).sort().map(key=>[key,localStorage.getItem(key)]),scroll:{top:transcript.scrollTop,range:transcript.scrollHeight-transcript.clientHeight,scrollHeight:transcript.scrollHeight,clientHeight:transcript.clientHeight},panels:[...normal.querySelectorAll(".turn-activity")].map(item=>{const trigger=item.querySelector(".activity-trigger"),panel=item.querySelector(':scope > [data-slot="collapsible-panel"]');return {turn:item.dataset.activityTurn,label:trigger.getAttribute("aria-label"),expanded:trigger.getAttribute("aria-expanded"),height:panel.getBoundingClientRect().height,opacity:getComputedStyle(panel).opacity,display:getComputedStyle(panel).display}}),authoredDom:[...normal.querySelectorAll(".message")].map(item=>({identity:item.dataset.transcriptEntryKey,role:item.dataset.messageRole,text:item.textContent})),drafts:[...pane.querySelectorAll(".composer-input textarea")].map(item=>item.value)};
			});
			assert.equal(raw.workspace.layout.windows.length,1);assert.equal(raw.groups.length,1);
			assert(!raw.workspace.pendingTransfer&&!raw.workspace.outgoingTransfer&&!raw.workspace.closingWindow);
			assert.equal(raw.activeTabId,snapshot.dom.activeTabId);assert.deepEqual(raw.groups[0].tabs,expectedGroup.tabs);
			assert.equal(raw.page,snapshot.dom.page);assert.equal(raw.appearance,snapshot.dom.appearance);
			assert.equal(raw.collapsedPreference,snapshot.dom.collapsedPreference);assert.equal(raw.sidebarCollapsed,snapshot.dom.sidebarCollapsed);
			assert.deepEqual(saved(raw.presentations),originalSaved,"Protected saved views changed");
			assert.equal(raw.panels.length,2);assert(raw.panels.every(panel=>panel.label&&!panel.label.startsWith("Working")));
			const authoredHash=hash(raw.authoredDom),draftHash=hash(raw.drafts);
			delete raw.authoredDom;delete raw.drafts;
			return {...raw,authoredHash,draftHash};
		};
		const original=await readUi();
		receipt.before={panels:original.panels.map(({label,...rest})=>rest),scroll:original.scroll};
		receipt.authoredDomBeforeSha256=original.authoredHash;receipt.draftsBeforeSha256=original.draftHash;
		const groupId=original.focusedGroupId;
		const selector=`[data-workspace-group=${JSON.stringify(groupId)}] .normal-transcript .turn-activity .activity-trigger`;
		const triggers=page.locator(selector);assert.equal(await triggers.count(),2);
		receipt.phase="open-settled-disclosures";
		for(let index=0;index<2;index++){
			assertPid();
			if(await triggers.nth(index).getAttribute("aria-expanded")==="false"){
				await triggers.nth(index).click();receipt.actions.disclosureClicks++;
				await page.evaluate(async groupId=>{const pane=[...document.querySelectorAll("[data-workspace-group]")].find(item=>item.dataset.workspaceGroup===groupId);await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const animations=pane.getAnimations({subtree:true}).filter(item=>Number.isFinite(item.effect?.getComputedTiming().endTime));await Promise.all(animations.map(item=>item.finished.catch(()=>{})));await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))},groupId);
			}
		}
		const opened=await readUi();
		receipt.opened={panels:opened.panels.map(({label,...rest})=>rest),scroll:opened.scroll};
		assert.equal(opened.authoredHash,original.authoredHash);assert.equal(opened.draftHash,original.draftHash);
		assert(opened.panels.every(panel=>panel.expanded==="true"&&panel.height>0&&panel.opacity==="1"&&panel.display!=="none"));
		assert(opened.scroll.range>=oldTail,"Opened work is still too short to restore the original reading distance; stop here");
		receipt.phase="restore-reading-distance";
		const transcript=page.locator(`[data-workspace-group=${JSON.stringify(groupId)}] .transcript`);
		const bounds=await transcript.boundingBox();assert(bounds&&bounds.height>2&&bounds.width>2);
		await page.mouse.move(bounds.x+2,bounds.y+2);await page.mouse.wheel(0,-1);receipt.actions.wheelGestures++;
		// Pointer/focus can reveal metadata and change content height while it fades.
		// Settle those real transitions outside the transcript before choosing a target.
		const external=page.getByRole("button",{name:"Toggle sidebar",exact:true});
		assert.equal(await external.count(),1);
		await external.hover();await external.focus();
		const externalBounds=await external.boundingBox();assert(externalBounds);
		const pointer={x:externalBounds.x+externalBounds.width/2,y:externalBounds.y+externalBounds.height/2};
		receipt.scrollGeometry=[];
		const settleTranscript=async(label)=>{
			assertPid();
			const settled=await page.evaluate(async({groupId,pointer})=>{
				const pane=[...document.querySelectorAll("[data-workspace-group]")].find(item=>item.dataset.workspaceGroup===groupId);
				const node=pane.querySelector(".transcript"),normal=pane.querySelector(".normal-transcript");
				const geometry=()=>({top:node.scrollTop,range:node.scrollHeight-node.clientHeight,scrollHeight:node.scrollHeight,clientHeight:node.clientHeight});
				const started=performance.now(),before=geometry();
				await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
				const animations=normal.getAnimations({subtree:true}).filter(item=>Number.isFinite(item.effect?.getComputedTiming().endTime));
				const durations=animations.map(item=>({type:item.constructor.name,property:item.transitionProperty,id:item.id,duration:item.effect.getComputedTiming().duration,currentTime:item.currentTime}));
				await Promise.all(animations.map(item=>item.finished.catch(()=>{})));
				await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
				const remaining=normal.getAnimations({subtree:true}).filter(item=>Number.isFinite(item.effect?.getComputedTiming().endTime)&&(item.playState==="running"||item.pending));
				return {before,after:geometry(),waitedActualMs:performance.now()-started,durations,remaining:remaining.map(item=>({type:item.constructor.name,property:item.transitionProperty,duration:item.effect.getComputedTiming().duration})),pointerTarget:document.elementFromPoint(pointer.x,pointer.y)?.closest("button")?.getAttribute("aria-label"),focusedTarget:document.activeElement?.getAttribute("aria-label"),focusInsideTranscript:node.contains(document.activeElement)};
			},{groupId,pointer});
			receipt.scrollGeometry.push({label,...settled});
			assert.equal(settled.remaining.length,0,"New transcript motion remains; refuse a transient scroll sample");
			assert.equal(settled.pointerTarget,"Toggle sidebar");assert.equal(settled.focusedTarget,"Toggle sidebar");
			assert.equal(settled.focusInsideTranscript,false);
			assert(settled.after.range>=oldTail,"Settled work is too short for the original reading distance");
			return settled.after;
		};
		await settleTranscript("after-wheel-and-external-focus");
		let restored;
		for(let attempt=0;attempt<2;attempt++){
			assertPid();
			const assignment=await page.evaluate(async({groupId,oldTail})=>{
				const pane=[...document.querySelectorAll("[data-workspace-group]")].find(item=>item.dataset.workspaceGroup===groupId),node=pane.querySelector(".transcript");
				const before={top:node.scrollTop,range:node.scrollHeight-node.clientHeight};const target=before.range-oldTail;
				if(target<0)throw new Error("Original tail exceeds the current range");
				const assigned=before.top!==target;
				if(assigned)await new Promise(resolve=>{node.addEventListener("scroll",resolve,{once:true});node.scrollTop=target});
				await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
				return {before,target,assigned,after:{top:node.scrollTop,range:node.scrollHeight-node.clientHeight}};
			},{groupId,oldTail});
			if(assignment.assigned)receipt.actions.scrollAssignments++;
			receipt.scrollGeometry.push({label:`scroll-assignment-${attempt+1}`,...assignment});
			await settleTranscript(`after-scroll-assignment-${attempt+1}`);
			restored=await readUi();
			if(restored.scroll.range-restored.scroll.top===oldTail)break;
		}
		assert(receipt.actions.scrollAssignments<=2);
		assert.equal(restored.scroll.range-restored.scroll.top,oldTail,"Exact original reading distance was not restored");
		assert.equal(restored.authoredHash,original.authoredHash);assert.equal(restored.draftHash,original.draftHash);
		assert(restored.panels.every(panel=>panel.expanded==="true"&&panel.height>0&&panel.opacity==="1"));
		receipt.after={panels:restored.panels.map(({label,...rest})=>rest),scroll:restored.scroll};
		receipt.authoredDomAfterSha256=restored.authoredHash;receipt.draftsAfterSha256=restored.draftHash;
		receipt.journalsAfter=journalHashes();
		assertPid();assert.equal(hash(fs.readFileSync(configInput.file)),configHash);assert.equal(hash(fs.readFileSync(activationInput.file)),activationHash);assert.equal(hash(fs.readFileSync(snapshotInput.file)),snapshotHash);
		receipt.phase="complete";receipt.passed=true;
		console.log(JSON.stringify({passed:true,receipt:path.basename(receiptPath),pid:expectedPid,disclosureClicks:receipt.actions.disclosureClicks,scrollBefore:receipt.before.scroll,scrollAfter:receipt.after.scroll,tailDistance:oldTail,directStorageWrites:0,modelRequests:0}));
	} catch(error){receipt.error={name:error.name,message:error.message};process.exitCode=1;throw error}
	finally{fs.writeFileSync(receiptPath,`${JSON.stringify(receipt,null,2)}\n`,{flag:"wx"});await browser?.close()}
}
