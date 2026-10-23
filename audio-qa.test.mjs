import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {wavLayout,writePcmSlice,verifyAssembly,validatePartSequence,verifyEncodedOutput} from './audio-qa.mjs';

function wav(file,{rate=24000,seconds=1,gain=1,quiet=false}={}) {
  const n=Math.round(rate*seconds),b=Buffer.alloc(44+2*n);
  b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*2,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*2,40);
  for(let i=0;i<n;i++){const quietWindow=(i/rate)%2>=1,amplitude=quiet?0:quietWindow?60:6000;b.writeInt16LE(Math.round(gain*amplitude*Math.sin(2*Math.PI*320*i/rate)),44+2*i);}
  fs.writeFileSync(file,b);return b;
}
function concat(output,files,gap=0){
  const l=wavLayout(files[0]),data=[];
  files.forEach((f,i)=>{const p=wavLayout(f),b=fs.readFileSync(f);data.push(b.subarray(p.offset,p.offset+p.bytes));if(i<files.length-1&&gap)data.push(Buffer.alloc(gap*l.block));});
  const pcm=Buffer.concat(data),h=fs.readFileSync(files[0]).subarray(0,44);h.writeUInt32LE(pcm.length+36,4);h.writeUInt32LE(pcm.length,40);fs.writeFileSync(output,Buffer.concat([h,pcm]));
}
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'audio-qa-test-'));test.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
test('sample-exact assembly accepts correct order and inserted digital gaps',()=>{
 const a=path.join(tmp,'a.wav'),b=path.join(tmp,'b.wav'),out=path.join(tmp,'joined.wav');wav(a);wav(b,{gain:.5});concat(out,[a,b],7200);
 const r=verifyAssembly({inputs:[a,b],output:out,gapFrames:7200});assert.equal(r.assembly_integrity,'pass');assert.equal(r.output_frames,55200);
 concat(out,[b,a],7200);assert.throws(()=>verifyAssembly({inputs:[a,b],output:out,gapFrames:7200}),/PCM_MISMATCH/);
});
test('raising gain, losing a part, and damaged WAV headers are rejected',()=>{
 const a=path.join(tmp,'source.wav'),out=path.join(tmp,'changed.wav');wav(a);wav(out,{gain:1.2});assert.throws(()=>verifyAssembly({inputs:[a],output:out}),/PCM_MISMATCH/);
 assert.throws(()=>verifyAssembly({inputs:[a,a],output:a}),/sample-count mismatch/);
 fs.writeFileSync(out,'ID3-this-is-not-WAV');assert.throws(()=>wavLayout(out),/Expected RIFF/);
});
test('trim copies all retained samples without fades or loudness changes',()=>{
 const a=path.join(tmp,'trim-source.wav'),out=path.join(tmp,'trimmed.wav'),b=wav(a,{seconds:2});
 writePcmSlice(a,out,12345);const l=wavLayout(out);assert.equal(l.frames,48000-12345);assert.deepEqual(fs.readFileSync(out).subarray(l.offset),b.subarray(44+12345*2));
});
test('declared silence edits cannot remove speech',()=>{
 const a=path.join(tmp,'silent.wav'),b=path.join(tmp,'speech.wav'),out=path.join(tmp,'edited.wav');wav(a,{quiet:true});wav(b);concat(out,[b]);
 const r=verifyAssembly({inputs:[a,b],output:out,cuts:[{start:0,end:1}]});assert.equal(r.output_frames,24000);
 assert.throws(()=>verifyAssembly({inputs:[b,b],output:out,cuts:[{start:0,end:1}]}),/removed non-silent/);
});
test('part sequence refuses holes, duplicates, wrong chapters, and an incomplete expected manifest',()=>{
 const f=n=>({name:`DE_00006_Chapter_18_Part_${n}.wav`});
 assert.equal(validatePartSequence('DE_00006_18',[f(1),f(2)]).count,2);
 assert.throws(()=>validatePartSequence('DE_00006_18',[f(1),f(3)]),/Missing/);
 assert.throws(()=>validatePartSequence('DE_00006_18',[f(1),f(1)]),/Duplicate/);
 assert.throws(()=>validatePartSequence('DE_00006_19',[f(1)]),/another chapter/);
 assert.throws(()=>validatePartSequence('DE_00006_18',[f(1)],[f(1).name,f(2).name]),/count mismatch/);
});
test('normal MP3 passes but relative background amplification fails',()=>{
 const ref=path.join(tmp,'reference.wav'),mp3=path.join(tmp,'normal.mp3'),decoded=path.join(tmp,'decoded.wav'),bad=path.join(tmp,'raised-background.wav');wav(ref,{rate:44100,seconds:8});
 execFileSync('ffmpeg',['-v','error','-y','-i',ref,'-c:a','libmp3lame','-b:a','192k',mp3]);
 execFileSync('ffmpeg',['-v','error','-y','-i',mp3,'-c:a','pcm_s16le',decoded]);
 assert.equal(verifyEncodedOutput(ref,decoded).codec_check,'pass');
 const b=fs.readFileSync(ref);for(let i=0;i<44100*8;i++)if((i/44100)%2>=1)b.writeInt16LE(b.readInt16LE(44+i*2)*3,44+i*2);fs.writeFileSync(bad,b);
 assert.throws(()=>verifyEncodedOutput(ref,bad),/BACKGROUND_RAISED/);
});

test('a short raised-background burst is flagged even when the median is normal',()=>{
 const ref=path.join(tmp,'brief-reference.wav'),out=path.join(tmp,'brief-noise.wav');
 const b=wav(ref,{rate:44100,seconds:12});
 for(let i=Math.round(3.2*44100);i<Math.round(3.7*44100);i++)b.writeInt16LE(b.readInt16LE(44+i*2)*3,44+i*2);
 fs.writeFileSync(out,b);
 assert.throws(()=>verifyEncodedOutput(ref,out),e=>{
   assert.ok(Math.abs(e.comparison.relative_quiet_gain_db)<.1);
   assert.ok(e.issues.some(x=>x.start_seconds<=3.2&&x.end_seconds>=3.7));
   return /BACKGROUND_RAISED/.test(e.message);
 });
});

