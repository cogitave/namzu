# Real subprocess/PTY I/O; timeouts only bound a failed native experiment.
import os,pty,fcntl,termios,struct,select,time,pathlib,subprocess,json,signal,tempfile
repo=str(pathlib.Path(__file__).resolve().parents[2])
root=pathlib.Path(tempfile.mkdtemp(prefix='namzu-readiness-native-'))
(root/'home').mkdir(); (root/'project').mkdir()
(root/'home'/'preferences.json').write_text(json.dumps({'version':3,'providers':[{'id':'openai','model':'gpt-5.6-luna'}],'subagents':{'active':[]}}))
(root/'home'/'trust.json').write_text(json.dumps({'version':1,'trusted':[str(root/'project')]}))
(root/'project'/'namzu.config.json').write_text(json.dumps({'sandbox':{'enabled':False},'web':{'search':'off'},'memory':{'recall':False}}))
(root/'server.mjs').write_text("import {createServer} from 'node:http';import {watch,existsSync,writeFileSync} from 'node:fs';import{join}from'node:path';const root=process.env.NAMZU_CHILD_FIXTURE_ROOT;const server=createServer((req,res)=>res.end('NATIVE_HTTP_OK_719'));await new Promise(done=>server.listen(0,'127.0.0.1',done));writeFileSync(join(root,'server-info.json'),JSON.stringify({port:server.address().port,pid:process.pid}));process.stdout.write('READY_');writeFileSync(join(root,'prefix-written'),'yes');const watcher=watch(root,()=>{if(existsSync(join(root,'release-ready'))){watcher.close();process.stdout.write('719\\n');}});process.on('SIGTERM',()=>{server.close(()=>process.exit(0));watcher.close();});")
(root/'check-server.mjs').write_text("import{readFileSync}from'node:fs';import{join}from'node:path';const {port}=JSON.parse(readFileSync(join(process.env.NAMZU_CHILD_FIXTURE_ROOT,'server-info.json'),'utf8'));const r=await fetch(`http://127.0.0.1:${port}`,{signal:AbortSignal.timeout(10000)});const text=await r.text();if(!r.ok||text!=='NATIVE_HTTP_OK_719')throw new Error('Owned server unavailable');console.log(text);")
(root/'screen.mjs').write_text("import{createRequire}from'node:module';import{readFileSync}from'node:fs';const require=createRequire(process.env.NAMZU_CHILD_FIXTURE_REPO+'/packages/cli/package.json');const{Terminal}=require('@xterm/headless');const terminal=new Terminal({cols:120,rows:38,allowProposedApi:true,scrollback:2000});await new Promise(done=>terminal.write(readFileSync(process.argv[2],'utf8'),done));console.log(Array.from({length:38},(_,i)=>terminal.buffer.active.getLine(terminal.buffer.active.baseY+i)?.translateToString(true)??'').join('\\n'));terminal.dispose();")
print('Owned native scratch:', root, flush=True)
env=os.environ.copy();env.update(NAMZU_CHILD_FIXTURE_ROOT=str(root),NAMZU_CHILD_FIXTURE_REPO=repo,NAMZU_HOME=str(root/'home'),OPENAI_API_KEY='fixture',XDG_RUNTIME_DIR=str(root),TERM='xterm-256color',FORCE_COLOR='1');env.pop('CI',None)
pid,fd=pty.fork()
if pid==0:
 os.chdir(root/'project');os.execvpe('node',['node','--import',repo+'/research/agent-messaging-20261001/namzu-readiness-tui-preload.mjs',repo+'/packages/cli/dist/bin.js','--dangerously-skip-permissions'],env)
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
 submit('START_READINESS_NATIVE_719')
 wait_until(lambda:(root/'prefix-written').exists(),'No output prefix')
 wait_until(lambda:(root/'wait-requested').exists(),'No condition wait requested')
 wait_screen('Wait for job output')
 capture('waiting-for-output')
 (root/'release-ready').write_text('release')
 wait_screen('NATIVE_READY_AND_HTTP_SEEN_719')
 capture('readiness-completed-server-running')
 server_pid=json.loads((root/'server-info.json').read_text())['pid']
 os.kill(server_pid,0)
 submit('/jobs')
 wait_screen('running')
 capture('persistent-server-visible')
 send('\x1b');pump(.2)
 submit('/exit')
 wait_until(lambda:os.waitpid(pid,os.WNOHANG)[0]==pid,'CLI failed to exit')
 def gone():
  try:os.kill(server_pid,0);return False
  except ProcessLookupError:return True
 wait_until(gone,'Owned server still alive after CLI close')
 (root/'driver-receipt.json').write_text(json.dumps({'exit':'clean','root':str(root),'splitMarker':'READY_719','continuedWhileServerAlive':True,'serverStoppedOnHostClose':True,'frames':sorted(p.name for p in root.glob('*.txt'))},indent=2))
 print('Native readiness driver complete:',root,flush=True)
except BaseException as e:
 capture('driver-failure');print(str(e),flush=True);raise
finally:
 (root/'release-ready').write_text('cleanup')
 try:os.kill(pid,signal.SIGTERM)
 except ProcessLookupError:pass
 os.close(fd)
