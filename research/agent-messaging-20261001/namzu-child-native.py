# Real subprocess/PTY I/O; timeouts only bound a failed native experiment.
import os,pty,fcntl,termios,struct,select,time,pathlib,subprocess,json,signal,tempfile
repo=str(pathlib.Path(__file__).resolve().parents[2])
root=pathlib.Path(tempfile.mkdtemp(prefix='namzu-child-native-'))
(root/'home').mkdir(); (root/'project').mkdir()
(root/'home'/'preferences.json').write_text(json.dumps({'version':3,'providers':[{'id':'openai','model':'gpt-5.6-luna'}],'subagents':{'active':[]}}))
(root/'home'/'trust.json').write_text(json.dumps({'version':1,'trusted':[str(root/'project')]}))
(root/'project'/'namzu.config.json').write_text(json.dumps({'sandbox':{'enabled':False},'web':{'search':'off'},'memory':{'recall':False}}))
(root/'held-tool.mjs').write_text("import{watch,existsSync,writeFileSync}from'node:fs';import{join}from'node:path';const root=process.env.NAMZU_CHILD_FIXTURE_ROOT;const phase=process.argv[2];const release=join(root,`release-${phase}`);await new Promise(resolve=>{const watcher=watch(root,()=>{if(existsSync(release)){watcher.close();resolve()}});writeFileSync(join(root,`${phase}-tool-entered`),new Date().toISOString());console.log(`TOOL_ENTERED_${phase}`);if(existsSync(release)){watcher.close();resolve()}});console.log(`TOOL_RESULT_${phase}`);")
(root/'screen.mjs').write_text("import{createRequire}from'node:module';import{readFileSync}from'node:fs';const require=createRequire(process.env.NAMZU_CHILD_FIXTURE_REPO+'/packages/cli/package.json');const{Terminal}=require('@xterm/headless');const terminal=new Terminal({cols:120,rows:38,allowProposedApi:true,scrollback:2000});await new Promise(done=>terminal.write(readFileSync(process.argv[2],'utf8'),done));console.log(Array.from({length:38},(_,i)=>terminal.buffer.active.getLine(terminal.buffer.active.baseY+i)?.translateToString(true)??'').join('\\n'));terminal.dispose();")
print('Owned native scratch:', root, flush=True)
env=os.environ.copy();env.update(NAMZU_CHILD_FIXTURE_ROOT=str(root),NAMZU_CHILD_FIXTURE_REPO=repo,NAMZU_HOME=str(root/'home'),OPENAI_API_KEY='fixture',XDG_RUNTIME_DIR=str(root),TERM='xterm-256color',FORCE_COLOR='1');env.pop('CI',None)
pid,fd=pty.fork()
if pid==0:
 os.chdir(root/'project');os.execvpe('node',['node','--import',repo+'/research/agent-messaging-20261001/namzu-child-tui-preload.mjs',repo+'/packages/cli/dist/bin.js','--dangerously-skip-permissions'],env)
fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack('HHHH',38,120,0,0));os.set_blocking(fd,False)
raw=root/'native.ansi'; raw.write_bytes(b'')
def pump(wait=.1):
 if select.select([fd],[],[],wait)[0]:
  try: b=os.read(fd,1000000)
  except (BlockingIOError,OSError): return
  if b:
   with raw.open('ab') as out:out.write(b)
def screen():
 pump(.05)
 return subprocess.check_output(['node',str(root/'screen.mjs'),str(raw)],env=env,text=True)
def wait_until(predicate,label):
 end=time.monotonic()+120
 while True:
  pump(.1)
  if predicate():return
  if time.monotonic()>end:raise RuntimeError(label+'\n'+screen())
def wait_screen(value):wait_until(lambda:value.lower() in screen().lower(),'No screen: '+value)
def send(text):os.write(fd,text.encode());pump(.2)
def submit(text):
 send(text);wait_screen(text);send('\r')
def capture(name): (root/(name+'.txt')).write_text(screen())
try:
 wait_screen('gpt-5.6-luna')
 submit('START_NATIVE_719')
 wait_until(lambda:(root/'first-tool-entered').exists(),'First tool not entered')
 send('PARENT_DRAFT_KEEP_719')
 send('\x14')
 wait_screen('Phases')
 send('\r')
 wait_screen('Native child continuity')
 capture('child-working')
 send('m')
 wait_screen('Message')
 submit('DIRECT_BUSY_CORRECTION_719')
 wait_screen('Message queued')
 capture('child-busy-queued')
 (root/'release-first').write_text('release')
 wait_until(lambda:'CHILD_CORRECTED_FINAL_719' in (root/'requests.jsonl').read_text(),'No first corrected result')
 wait_screen('Completed')
 capture('child-first-completed')
 submit('DIRECT_IDLE_FOLLOWUP_719')
 wait_until(lambda:(root/'second-tool-entered').exists(),'Followup tool not entered')
 capture('child-followup-started')
 submit('FOLLOWUP_BUSY_CORRECTION_719')
 wait_screen('Message queued')
 capture('child-followup-queued')
 (root/'release-second').write_text('release')
 wait_until(lambda:'FOLLOWUP_CORRECTED_FINAL_719' in raw.read_text(errors='replace'),'No second corrected result')
 wait_screen('Completed')
 capture('child-followup-completed')
 send('\x1b');pump(.5);send('q')
 wait_screen('PARENT_DRAFT_KEEP_719')
 capture('parent-draft-preserved')
 # Clear only our own original draft, then request parent context reconciliation.
 send('\x15');submit('CHECK_CHILD_REPORT_719')
 wait_screen('PARENT_FOLLOWUP_REPORT_SEEN_719')
 capture('parent-followup-notice')
 submit('/exit')
 wait_until(lambda:os.waitpid(pid,os.WNOHANG)[0]==pid,'CLI failed to exit')
 (root/'driver-receipt.json').write_text(json.dumps({'exit':'clean','root':str(root),'frames':sorted(p.name for p in root.glob('*.txt'))},indent=2))
 print('Native driver complete:',root,flush=True)
except BaseException as e:
 capture('driver-failure');print(str(e),flush=True);raise
finally:
 for phase in ('first','second'):(root/('release-'+phase)).write_text('cleanup')
 try:os.kill(pid,signal.SIGTERM)
 except ProcessLookupError:pass
 os.close(fd)
