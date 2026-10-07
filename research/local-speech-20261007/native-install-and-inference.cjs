'use strict';
// Explicitly approved CPU-only speech installation. No model-provider or computer calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
assert.equal(process.platform, 'win32');
const repo = String.raw`\\wsl.localhost\archlinux\home\arda\workspaces\@cogitave\cogitave\namzu`;
const privateRoot = path.join(process.env.LOCALAPPDATA, 'Namzu', 'Development');
const output = path.join(privateRoot, 'ema-native-cpu-proof-private-20261007-v1.json');
assert(!fs.existsSync(output));
const directory = path.join(process.env.APPDATA, 'Namzu', 'local-speech');
const modulePath = name => pathToFileURL(path.join(repo, 'packages/desktop/dist/main', name)).href;
(async () => {
 const { installLocalSpeech, runLocalSpeechCommand } = await import(modulePath('local-speech-install.js'));
 const { LocalSpeechService } = await import(modulePath('local-speech.js'));
 const { LOCAL_SPEECH_PREVIEW_TEXT } = await import(pathToFileURL(path.join(repo, 'packages/desktop/dist/shared/local-speech-protocol.js')));
 const installStarted = performance.now();
 let operations = 0;
 const installation = await installLocalSpeech({ directory,
  python: {program: path.join(process.env.LOCALAPPDATA, 'Python', 'bin', 'python.exe')},
  run: async (program, args, options) => {
   console.log(JSON.stringify({phase:'install',operation:++operations}));
   return runLocalSpeechCommand(program,args,options);
  }
 });
 const installMs = performance.now() - installStarted;
 console.log(JSON.stringify({phase:'installed',runtimeDownloadBytes:installation.runtimeDownloadBytes,diskBytes:installation.diskBytes,installMs}));
 const service = new LocalSpeechService({ directory });
 const frames = [];
 let maxPcmBytes = 0;
 let sequence = 0;
 const speechStarted = performance.now();
 let firstAudioMs;
 const ended = new Promise((resolve,reject) => {
  service.subscribe(event => {
   try {
    if(event.type==='audio') {
     assert.equal(event.requestId,'native-cpu-proof');
     assert.equal(event.sequence,sequence++);
     assert.equal(event.sampleRate,24000);
     const frame=Buffer.from(event.pcmBase64,'base64');
     assert(frame.length<=9600 && frame.length>0 && frame.length%2===0);
     maxPcmBytes=Math.max(maxPcmBytes,frame.length);
     if(firstAudioMs===undefined) firstAudioMs=performance.now()-speechStarted;
     frames.push(frame);
     // Native inference proof drains to a WAV file. Actual playback ACKs are tested separately in UI.
     service.acknowledge(event.requestId,event.sequence);
    } else if(event.type==='error') reject(new Error(event.message));
    else if(event.type==='end' && event.requestId==='native-cpu-proof') resolve(event.reason);
   } catch(error) {reject(error);}
  });
 });
 try {
  await service.speak({requestId:'native-cpu-proof',text:LOCAL_SPEECH_PREVIEW_TEXT,preview:true});
  const reason=await ended;
  assert.equal(reason,'completed');
  const pcm=Buffer.concat(frames);
  assert(pcm.length>0);
  const state=await service.state();
  const wav=Buffer.alloc(44);
  wav.write('RIFF',0); wav.writeUInt32LE(36+pcm.length,4); wav.write('WAVEfmt ',8);
  wav.writeUInt32LE(16,16); wav.writeUInt16LE(1,20); wav.writeUInt16LE(1,22);
  wav.writeUInt32LE(24000,24); wav.writeUInt32LE(48000,28); wav.writeUInt16LE(2,32);
  wav.writeUInt16LE(16,34); wav.write('data',36); wav.writeUInt32LE(pcm.length,40);
  const wavFile=path.join(privateRoot,'ema-native-turkish-preview-20261007.wav');
  fs.writeFileSync(wavFile,Buffer.concat([wav,pcm]),{flag:'wx'});
  const proof={passed:true,platform:process.platform,at:new Date().toISOString(),device:'cpu',
   text:LOCAL_SPEECH_PREVIEW_TEXT,modelRevision:installation.modelRevision,sourceRevision:installation.sourceRevision,
   installation:{installMs,operations,runtimeDownloadBytes:installation.runtimeDownloadBytes,diskBytes:installation.diskBytes},
   inference:{reason,frames:frames.length,maxPcmBytes,audioSeconds:pcm.length/48000,firstAudioMs,totalMs:performance.now()-speechStarted},
   resources:state.resources,
   limitations:['PCM drained to a file, not real speaker playback.','No subjective Turkish pronunciation rating.','First-audio timing includes a cold worker.']};
  fs.writeFileSync(output,JSON.stringify(proof,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify(proof));
 } finally { await service.dispose(); }
})().catch(error => { console.error(error.message);process.exitCode=1; });
