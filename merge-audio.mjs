import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {wavLayout,writePcmSlice,verifyAssembly,verifyEncodedOutput,scanPcm} from './audio-qa.mjs';

export const MERGE_VERSION='preserve-dynamics-1.0.0';
const RATE=44100;
const run=args=>execFileSync('ffmpeg',['-nostdin','-hide_banner','-v','error','-y',...args],{stdio:['ignore','pipe','pipe'],maxBuffer:1024*1024});
const escape=f=>f.replace(/'/g,"'\\''");

// FFmpeg can decode a truncated WAV successfully. Reject inconsistent RIFF
// envelopes before decoding; do not turn an incomplete source into success.
function checkRiffEnvelope(file) {
  const fd=fs.openSync(file,'r');
  try {
    const size=fs.fstatSync(fd).size,h=Buffer.alloc(12);
    const read=fs.readSync(fd,h,0,12,0);
    if(h.toString('ascii',0,4)!=='RIFF')return;
    if(read!==12||h.toString('ascii',8,12)!=='WAVE'||h.readUInt32LE(4)+8!==size)throw Error('AUDIO_QA: Incomplete WAV source');
    let p=12;
    while(p<size){
      const ch=Buffer.alloc(8);
      if(p+8>size||fs.readSync(fd,ch,0,8,p)!==8)throw Error('AUDIO_QA: Incomplete WAV chunk');
      const n=ch.readUInt32LE(4);p+=8+n+(n%2);
      if(p>size)throw Error('AUDIO_QA: Incomplete WAV chunk');
    }
  } finally {fs.closeSync(fd);}
}

// Keep the Worker's MP3 callback contract. Loudness mastering belongs to the
// downstream mastering stage, not to either side of concatenation.
export function mergeAudio(inputs,{workDir,cutTimes=[],gapSeconds=.3}={}) {
  if(!inputs.length||!workDir)throw Error('No merge inputs or work directory');
  if(!Number.isFinite(gapSeconds)||gapSeconds<0||gapSeconds>5)throw Error('Invalid gap');
  if(cutTimes.length&&cutTimes.length!==inputs.length)throw Error('Invalid trim map');
  const parts=[],sourceManifest=[];
  for(const [i,input] of inputs.entries()) {
    const normalized=path.join(workDir,`decoded_${i}.wav`),output=path.join(workDir,`part_${i}.wav`);
    checkRiffEnvelope(input);
    let pcm;
    try {pcm=wavLayout(input);} catch { /* MP3 and other supported sources are decoded below. */ }
    if(pcm&&pcm.rate===RATE&&pcm.channels===1)fs.copyFileSync(input,normalized);
    else run(['-xerror','-err_detect','explode','-i',input,'-map','0:a:0','-vn','-ar',String(RATE),'-ac','1','-c:a','pcm_s16le',normalized]);
    const cut=cutTimes[i]??0;
    if(!Number.isFinite(cut)||cut<0)throw Error('Invalid trim boundary');
    const trim=writePcmSlice(normalized,output,Math.round(cut*RATE));
    sourceManifest.push({source_index:i,...trim});parts.push(output);
  }
  const gapFrames=Math.round(gapSeconds*RATE),gap=path.join(workDir,'gap.wav');
  if(gapFrames)run(['-f','lavfi','-i',`anullsrc=r=${RATE}:cl=mono`,'-t',String(gapFrames/RATE),'-c:a','pcm_s16le',gap]);
  const list=path.join(workDir,'concat.txt'),lines=[];
  parts.forEach((p,i)=>{lines.push(`file '${escape(p)}'`);if(i<parts.length-1&&gapFrames)lines.push(`file '${escape(gap)}'`);});
  fs.writeFileSync(list,lines.join('\n'));
  const wav=path.join(workDir,'merged.wav'),mp3=path.join(workDir,'final.mp3'),decoded=path.join(workDir,'encoded-check.wav');
  run(['-f','concat','-safe','0','-i',list,'-map','0:a:0','-c:a','copy',wav]);
  const qa=verifyAssembly({inputs:parts,output:wav,gapFrames});
  // A single fixed reduction, only when needed for headroom. It never raises
  // quiet passages relative to speech and never increases source level.
  const gainDb=Math.min(0,-1.5-qa.metrics.peak_dbfs);
  run(['-i',wav,'-map','0:a:0','-af',`volume=${gainDb.toFixed(8)}dB`,'-ar',String(RATE),'-ac','1','-c:a','libmp3lame','-b:a','192k',mp3]);
  run(['-xerror','-err_detect','explode','-i',mp3,'-c:a','pcm_s16le',decoded]);
  const exportQa=verifyEncodedOutput(wav,decoded),encodedMetrics=scanPcm(decoded);
  if(encodedMetrics.clipped_samples)throw Error('AUDIO_QA: MP3 decoder reached full scale');
  delete encodedMetrics.windows;
  return {wav,mp3,qa:{...qa,merge_version:MERGE_VERSION,source_manifest:sourceManifest,
    trim_semantics:'legacy service-prefix trimming; not verified by speech recognition',
    export:{...exportQa,format:'mp3',sample_rate:RATE,constant_gain_db:gainDb,metrics:encodedMetrics},
    coverage:{assembly:'sample_exact_after_declared_trim',background_gain:'compared',words_and_pronunciation:'not_checked'}}};
}
