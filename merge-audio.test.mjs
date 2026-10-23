import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {mergeAudio} from './merge-audio.mjs';
import {wavLayout} from './audio-qa.mjs';

function source(file,phase=0){
 const rate=44100,n=rate*5,b=Buffer.alloc(44+n*2);
 b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*2,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*2,40);
 for(let i=0;i<n;i++)b.writeInt16LE(Math.round(((i/rate)%2<1?31000:80)*Math.sin(2*Math.PI*310*i/rate+phase)),44+i*2);
 fs.writeFileSync(file,b);
}
test('production merge preserves retained PCM, gaps, order and noise balance through MP3 export',()=>{
 const d=fs.mkdtempSync(path.join(os.tmpdir(),'merge-test-'));
 try{
   const a=path.join(d,'a.wav'),b=path.join(d,'b.wav');source(a);source(b,.3);
   const r=mergeAudio([a,b],{workDir:d,cutTimes:[.5,0]});
   assert.equal(r.qa.assembly_integrity,'pass');assert.equal(wavLayout(r.wav).frames,Math.round(9.8*44100));
   assert.ok(r.qa.export.constant_gain_db<0);assert.ok(Math.abs(r.qa.export.relative_quiet_gain_db)<1);
   assert.equal(r.qa.export.metrics.clipped_samples,0);
   assert.equal(r.qa.source_manifest[0].trim_start_frame,22050);
   const l=wavLayout(r.wav),original=wavLayout(a);
   const actual=fs.readFileSync(r.wav).subarray(l.offset,l.offset+original.bytes-44100);
   assert.deepEqual(actual,fs.readFileSync(a).subarray(original.offset+44100,original.offset+original.bytes));
 }finally{fs.rmSync(d,{recursive:true,force:true});}
});
test('corrupt sources and invalid trim boundaries cannot create an export',()=>{
 const d=fs.mkdtempSync(path.join(os.tmpdir(),'bad-merge-test-'));
 try{
   const a=path.join(d,'a.wav');source(a);
   assert.throws(()=>mergeAudio([a],{workDir:d,cutTimes:[100]}),/Invalid trim boundary/);
   fs.writeFileSync(a,'corrupt');assert.throws(()=>mergeAudio([a],{workDir:d}));
   assert.equal(fs.existsSync(path.join(d,'final.mp3')),false);
 }finally{fs.rmSync(d,{recursive:true,force:true});}
});
test('truncated RIFF cannot be salvaged silently by the decoder',()=>{
 const d=fs.mkdtempSync(path.join(os.tmpdir(),'truncated-merge-test-'));
 try{
   const a=path.join(d,'a.wav');source(a);
   const b=fs.readFileSync(a);fs.writeFileSync(a,b.subarray(0,b.length-200));
   assert.throws(()=>mergeAudio([a],{workDir:d}),/Incomplete WAV source/);
   assert.equal(fs.existsSync(path.join(d,'final.mp3')),false);
 }finally{fs.rmSync(d,{recursive:true,force:true});}
});
