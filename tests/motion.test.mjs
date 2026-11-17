import test from 'node:test';
import assert from 'node:assert/strict';
import {MOTION_KEY,BRIEF_MS,motionEnabled,arrivalMotionEnabled,motionToggled,motionLabel,briefWindow,wakeAtBriefEnd} from '../mods/sixfold-desk/motion.js';

const read=value=>key=>key===MOTION_KEY?value:undefined;

test('motion is off unless switched on; arrivals stop only when switched off',()=>{
  assert.equal(motionEnabled(read(undefined)),false,'an unset value is off');
  assert.equal(motionEnabled(read(null)),false);
  assert.equal(motionEnabled(read(false)),false);
  assert.equal(motionEnabled(read(true)),true);
  assert.equal(arrivalMotionEnabled(read(undefined)),true);
  assert.equal(arrivalMotionEnabled(read(false)),false);
  assert.equal(motionToggled(read(undefined)),true,'the first press turns it on');
  assert.equal(motionToggled(read(true)),false);
  assert.equal(motionLabel(false),'Motion off');assert.equal(motionLabel(true),'Motion on');
});

test('a brief effect plays for BRIEF_MS after a change, never on first sight while settling',()=>{
  let now=1000;const clock=()=>now;
  const brief=briefWindow({clock});
  assert.equal(brief.active('p1','working'),false,'reload: still');
  assert.equal(brief.nextAt(),null);
  now+=5000;
  assert.equal(brief.active('p1','working'),false,'same state stays still');
  assert.equal(brief.active('p1','idle'),true,'a change plays');
  assert.equal(brief.nextAt(),now+BRIEF_MS);
  assert.equal(brief.active('p2','working'),true,'a key that appears later counts as a change');
  now+=BRIEF_MS;
  assert.equal(brief.active('p1','idle'),false,'then still');
  assert.equal(brief.nextAt(),null);
});

test('one wake per holder redraws when the brief ends',()=>{
  const timers=[];let notified=0;
  const cx={notify(){notified++;},timer:{after(ms,fn){const timer={ms,fn,cancelled:false,cancel(){this.cancelled=true;}};timers.push(timer);return timer;}}};
  const holder={},at=Date.now()+500;
  wakeAtBriefEnd(holder,at,cx);wakeAtBriefEnd(holder,at,cx);
  assert.equal(timers.length,1,'same end, same timer');
  wakeAtBriefEnd(holder,null,cx);
  assert(timers[0].cancelled);
  wakeAtBriefEnd(holder,at,cx);timers[1].fn(cx);
  assert.equal(notified,1);assert.equal(holder.briefWake,null);
});

// Any forever motion drawn anywhere makes GPUI redraw the whole window every frame. Each one left
// must be bounded: a brief window (motion.js) or an event phase the panel wakes out of.
test('every remaining loop, spin and frame cycle is bounded',async()=>{
  const {readFile,readdir}=await import('node:fs/promises');
  const allowed={
    'sixfold-desk/panel-view.js':/ROW_BLINK_MS/,               // the arrival blink, only during the ping phase
    'sixfold-desk/pets.js':/runGate|options\.motion/,           // options.motion carries the caller's brief window
    'session-pets/main.js':/walking\.has/,                      // petWalks: brief window
  };
  // Every mod, nested folders included, so a new mod cannot add a spinner unseen.
  const found=[],root=new URL('../mods/',import.meta.url);
  for(const name of (await readdir(root,{recursive:true})).filter(n=>/\.m?js$/.test(n)).sort()){
    const file=name.split('\\').join('/');
    const lines=(await readFile(new URL(file,root),'utf8')).split('\n').filter(line=>/\.(spin|loop|frames)\(/.test(line));
    for(const line of lines)found.push([file,line]);
  }
  assert.ok(found.length>0,'the scan reads the mods');
  const used=new Set();
  for(const [file,line] of found){
    assert.ok(allowed[file]?.test(line),
      `mods/${file}: unbounded motion: ${line.trim().slice(0,120)}\n    -> bound it with briefWindow/wakeAtBriefEnd (mods/sixfold-desk/motion.js) or an event phase the view wakes out of`);
    used.add(file);
  }
  for(const file of Object.keys(allowed))assert.ok(used.has(file),`mods/${file}: this motion allowlist entry no longer matches anything, remove it`);
});
