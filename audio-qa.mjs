import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const QA_VERSION = 'pcm-integrity-1.1.0';
const fail = message => { throw new Error('AUDIO_QA: ' + message); };
const sha = () => crypto.createHash('sha256');

// Read only PCM audio bytes: WAV headers and metadata are deliberately excluded.
export function wavLayout(file) {
  const fd=fs.openSync(file,'r');
  try {
    const size=fs.fstatSync(fd).size, h=Buffer.alloc(12);
    if(fs.readSync(fd,h,0,12,0)!==12 || h.toString('ascii',0,4)!=='RIFF' || h.toString('ascii',8,12)!=='WAVE') fail('Expected RIFF/WAV: '+path.basename(file));
    if(h.readUInt32LE(4)+8!==size) fail('Truncated or inconsistent RIFF length: '+path.basename(file));
    let fmt, data;
    for(let p=12;p+8<=size;) {
      const ch=Buffer.alloc(8);fs.readSync(fd,ch,0,8,p);
      const n=ch.readUInt32LE(4),tag=ch.toString('ascii',0,4);p+=8;
      if(p+n>size)fail('Truncated WAV chunk: '+path.basename(file));
      if(tag==='fmt '){
        if(n<16)fail('Invalid WAV format');
        const b=Buffer.alloc(16);fs.readSync(fd,b,0,16,p);
        fmt={format:b.readUInt16LE(0),channels:b.readUInt16LE(2),rate:b.readUInt32LE(4),byteRate:b.readUInt32LE(8),block:b.readUInt16LE(12),bits:b.readUInt16LE(14)};
      }
      if(tag==='data'){if(data)fail('Multiple WAV data chunks');data={offset:p,bytes:n};}
      p+=n+(n%2);
    }
    if(!fmt||!data||!data.bytes||fmt.format!==1||fmt.bits!==16||![1,2].includes(fmt.channels)||fmt.rate<8000||fmt.rate>192000||fmt.block!==fmt.channels*2||fmt.byteRate!==fmt.rate*fmt.block||data.bytes%fmt.block) fail('Expected complete PCM16 mono/stereo WAV: '+path.basename(file));
    return {file,...fmt,...data,frames:data.bytes/fmt.block,duration:data.bytes/fmt.byteRate};
  } finally {fs.closeSync(fd);}
}

function* bytes(layout, from=0, to=layout.bytes) {
  const fd=fs.openSync(layout.file,'r');
  try {
    const buffer=Buffer.alloc(256*1024);
    for(let p=from;p<to;) {
      const n=fs.readSync(fd,buffer,0,Math.min(buffer.length,to-p),layout.offset+p);
      if(!n)fail('Unexpected EOF: '+path.basename(layout.file));
      yield buffer.subarray(0,n);p+=n;
    }
  } finally {fs.closeSync(fd);}
}

export function pcmHash(file) {
  const l=typeof file==='string'?wavLayout(file):file,h=sha();
  for(const b of bytes(l))h.update(b);
  return h.digest('hex');
}

export function writePcmSlice(input, output, startFrame=0) {
  const l=wavLayout(input);
  if(!Number.isInteger(startFrame)||startFrame<0||startFrame>=l.frames)fail('Invalid trim boundary');
  const count=(l.frames-startFrame)*l.block;
  if(count>0xffffffff-36)fail('WAV exceeds RIFF size limit');
  const h=Buffer.alloc(44);
  h.write('RIFF');h.writeUInt32LE(count+36,4);h.write('WAVEfmt ',8);h.writeUInt32LE(16,16);
  h.writeUInt16LE(1,20);h.writeUInt16LE(l.channels,22);h.writeUInt32LE(l.rate,24);
  h.writeUInt32LE(l.byteRate,28);h.writeUInt16LE(l.block,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(count,40);
  const fd=fs.openSync(output,'w');
  const hash=sha();
  try {fs.writeSync(fd,h);for(const b of bytes(l,startFrame*l.block)){fs.writeSync(fd,b);hash.update(b);}}finally{fs.closeSync(fd);}
  const expected=hash.digest('hex');
  if(pcmHash(output)!==expected)fail('PCM changed during trim');
  return {source_frames:l.frames,trim_start_frame:startFrame,frames:l.frames-startFrame,pcm_sha256:expected};
}

// These are review candidates, not claims about words, pronunciation, or audible defects.
export function scanPcm(file) {
  const l=wavLayout(file), frameSamples=Math.max(1,Math.round(l.rate*.1))*l.channels;
  let peak=0, samples=0, squares=0, windowSquare=0, windowCount=0, clipped=0, maxClipRun=0, clipRun=0;
  let silenceStart=null;const windows=[],silences=[];
  function finishWindow(){
    if(!windowCount)return;
    const end=samples/(l.rate*l.channels),start=(samples-windowCount)/(l.rate*l.channels),rms=Math.sqrt(windowSquare/windowCount)/32768;
    const db=20*Math.log10(Math.max(rms,1e-12));windows.push({start,end,db});
    if(db<-65){if(silenceStart===null)silenceStart=start;}
    else if(silenceStart!==null){if(start-silenceStart>=3)silences.push({start:silenceStart,end:start});silenceStart=null;}
    windowSquare=0;windowCount=0;
  }
  for(const b of bytes(l))for(let i=0;i<b.length;i+=2){
    const v=b.readInt16LE(i),a=Math.abs(v);peak=Math.max(peak,a);squares+=v*v;windowSquare+=v*v;samples++;windowCount++;
    if(a>=32767){clipped++;clipRun++;maxClipRun=Math.max(maxClipRun,clipRun);}else clipRun=0;
    if(windowCount===frameSamples)finishWindow();
  }
  finishWindow();
  if(silenceStart!==null&&l.duration-silenceStart>=3)silences.push({start:silenceStart,end:l.duration});
  const warnings=[];
  for(const s of silences)warnings.push({code:'LONG_QUIET_INTERVAL',severity:'review',start_seconds:+s.start.toFixed(3),end_seconds:+s.end.toFixed(3)});
  if(maxClipRun>=Math.ceil(l.rate*l.channels*.001))warnings.push({code:'SUSTAINED_FULL_SCALE',severity:'review',max_run_ms:1000*maxClipRun/(l.rate*l.channels)});
  return {rate:l.rate,channels:l.channels,frames:l.frames,duration_seconds:l.duration,peak_dbfs:20*Math.log10(Math.max(peak/32768,1e-12)),rms_dbfs:20*Math.log10(Math.max(Math.sqrt(squares/Math.max(samples,1))/32768,1e-12)),clipped_samples:clipped,peak_pcm:peak,warnings,windows};
}

export function verifyAssembly({inputs,output,gapFrames=0,cuts=[],silenceThreshold=8}) {
  if(!inputs.length)fail('No source parts');
  const layouts=inputs.map(wavLayout),first=layouts[0],actual=wavLayout(output);
  if(!Number.isInteger(gapFrames)||gapFrames<0)fail('Invalid gap');
  for(const l of [...layouts,actual])if(l.rate!==first.rate||l.channels!==first.channels)fail('Mixed PCM formats');
  const total=layouts.reduce((n,l)=>n+l.frames,0)+gapFrames*(layouts.length-1);
  const removed=cuts.map(c=>({start:Math.round(c.start*first.rate),end:Math.round(c.end*first.rate)}));
  let last=0;
  for(const c of removed){if(c.start<last||c.end<=c.start||c.end>total)fail('Invalid silence edit map');last=c.end;}
  const expectedFrames=total-removed.reduce((n,c)=>n+c.end-c.start,0);
  if(actual.frames!==expectedFrames)fail('Duration/sample-count mismatch: expected '+expectedFrames+', got '+actual.frames);
  const expectedHash=sha(),manifest=[];let position=0,cutIndex=0;
  function consume(b){
    const block=first.block;let p=0;
    while(p<b.length){
      const c=removed[cutIndex];
      if(c&&position>=c.end){cutIndex++;continue;}
      const dropping=c&&position>=c.start;
      const boundary=c?(dropping?c.end:c.start):Infinity;
      const frames=Math.min((b.length-p)/block,boundary-position),n=frames*block,chunk=b.subarray(p,p+n);
      if(dropping){for(let i=0;i<chunk.length;i+=2)if(Math.abs(chunk.readInt16LE(i))>silenceThreshold)fail('Silence cleanup removed non-silent audio');}
      else expectedHash.update(chunk);
      p+=n;position+=frames;
    }
  }
  for(let i=0;i<layouts.length;i++){
    const l=layouts[i],h=sha();manifest.push({name:path.basename(l.file),start_frame_before_cleanup:position,frames:l.frames});
    for(const b of bytes(l)){h.update(b);consume(b);}
    manifest.at(-1).pcm_sha256=h.digest('hex');
    if(i<layouts.length-1&&gapFrames){let n=gapFrames*first.block;while(n){const chunk=Buffer.alloc(Math.min(n,256*1024));consume(chunk);n-=chunk.length;}}
  }
  const expected=expectedHash.digest('hex'),got=pcmHash(actual);
  if(expected!==got)fail('PCM_MISMATCH: merged samples differ from source sequence');
  const metrics=scanPcm(output);if(metrics.peak_pcm<16)fail('Entire output is effectively silent');
  const seen=new Map(),warnings=[...metrics.warnings];
  for(const p of manifest){if(seen.has(p.pcm_sha256))warnings.push({code:'IDENTICAL_SOURCE_AUDIO',severity:'review',parts:[seen.get(p.pcm_sha256),p.name]});else seen.set(p.pcm_sha256,p.name);}
  delete metrics.windows;
  return {version:QA_VERSION,status:warnings.length?'review':'pass',assembly_integrity:'pass',format:'pcm_s16le',sample_rate:first.rate,channels:first.channels,source_parts:manifest.length,expected_frames:expectedFrames,output_frames:actual.frames,pcm_sha256:got,cuts,gap_frames:gapFrames,parts:manifest,metrics,warnings,checked_at:new Date().toISOString()};
}

export function validatePartSequence(chapterId,files,expectedFiles) {
  const m=String(chapterId).match(/^((?:RU|EN|DE|IT|FR|PT)_\d+)_(\d+)$/);
  if(!m)fail('Invalid chapter identifier');
  const prefix=m[1]+'_Chapter_'+Number(m[2])+'_Part_';
  const names=files.map(f=>String(f.name||''));
  if(new Set(names).size!==names.length)fail('Duplicate part names');
  const expected=expectedFiles||Array.from({length:files.length},(_,i)=>prefix+(i+1)+'.wav');
  if(expectedFiles&&(!Array.isArray(expectedFiles)||expectedFiles.length!==files.length))fail('Source manifest count mismatch');
  const nums=names.map(n=>{const ext=n.match(/\.(wav|mp3)$/i);const stem=ext?n.slice(0,-ext[0].length):'';if(!stem.startsWith(prefix)||!/^\d+$/.test(stem.slice(prefix.length)))fail('Part belongs to another chapter or has an invalid name: '+n);return Number(stem.slice(prefix.length));});
  for(let i=0;i<nums.length;i++)if(nums[i]!==i+1)fail('Missing, unordered, or duplicated part number at '+(i+1));
  if(expectedFiles&&names.some((n,i)=>n!==expected[i]))fail('Part names differ from expected manifest');
  return {count:files.length,expected_count_verified:!!expectedFiles};
}

export function verifyEncodedOutput(reference,decoded) {
  const a=wavLayout(reference),b=wavLayout(decoded);
  if(a.rate!==b.rate||a.channels!==b.channels||Math.abs(a.duration-b.duration)>.08)fail('Encoded output format or duration mismatch');
  const source=scanPcm(reference),target=scanPcm(decoded),n=Math.min(source.windows.length,target.windows.length),speech=[],quiet=[];
  for(let i=0;i<n;i++){
    const x=source.windows[i],y=target.windows[i],gain=y.db-x.db;
    if(x.db>-35)speech.push(gain);
    if(x.db>-80&&x.db<-45)quiet.push(gain);
  }
  const median=a=>a.length?[...a].sort((x,y)=>x-y)[Math.floor(a.length/2)]:null;
  const speechGain=median(speech),quietGain=median(quiet),relative=quietGain!==null&&speechGain!==null?quietGain-speechGain:null;
  // A whole-chapter median can hide short audible bursts. Also flag sustained
  // local quiet-region gain, relative to the chapter's typical speech gain.
  const issues=[];let run=null;
  function finishRun(){
    if(run&&run.end_seconds-run.start_seconds>=.299)issues.push({...run,code:'BACKGROUND_RAISED',severity:'review'});
    run=null;
  }
  if(speechGain!==null)for(let i=0;i<n;i++){
    const x=source.windows[i],y=target.windows[i],extra=y.db-x.db-speechGain;
    if(x.db>-65&&x.db<-45&&extra>3){
      if(!run)run={start_seconds:x.start,end_seconds:x.end,maximum_relative_gain_db:extra};
      else {run.end_seconds=x.end;run.maximum_relative_gain_db=Math.max(run.maximum_relative_gain_db,extra);}
    } else finishRun();
  }
  finishRun();
  const comparison={codec_check:'pass',duration_seconds:b.duration,quiet_frames:quiet.length,speech_gain_db:speechGain,quiet_gain_db:quietGain,relative_quiet_gain_db:relative,localized_background_issues:issues};
  if((quiet.length>=10&&relative!==null&&relative>3)||issues.length){
    const e=new Error('AUDIO_QA: BACKGROUND_RAISED: quiet regions amplified relative to speech'+(relative!==null?' (median '+relative.toFixed(2)+' dB)':''));
    e.issues=issues;e.comparison=comparison;throw e;
  }
  return comparison;
}

