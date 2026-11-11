import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('workspace badges: a generic, validated slot keyed by computer and space',async()=>{
 let source=(await readFile(new URL('../mods/sixfold-desk/badges.js',import.meta.url),'utf8')).replace(/^import[^\n]*\n/gm,'');
 source=`const renderedLabels=[];
 const element=()=>{
  const el={};
  for(const name of ['flex_none','gap','children','id','h','px','items_center','rounded','text_size','font_bold','bg','text_color','tooltip','accessibility_label','cursor_pointer','on_mouse_down','on_mouse_up','on_click'])el[name]=()=>el;
  el.when=(condition,fn)=>condition?fn(el):el;
  el.child=value=>{if(typeof value==='string')renderedLabels.push(value);return el;};
  return el;
 };
 const div=element,h_flex=element,appHome=()=>"",readTextFile=async()=>null,watchFolder=async()=>{},openOverlay=()=>{},run=()=>{},shared=()=>undefined;\n`+source+'\nexport {renderedLabels};';
 const m=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
 assert.equal(m.badgeKey(null,'sp1'),'|sp1');
 assert.equal(m.badgeKey('sub1','sub1/spc82'),'sub1|spc82');
 const clean=m.cleanBadges({
  '|sp1':[{id:'a',text:' ! 2 ',tone:'blocked',tooltip:'two open',open:{mod:'some-mod',props:{x:1},kind:'window'}},{id:'b',text:'',tone:'accent'},{text:'no id'}],
  'nokey':[{id:'c',text:'x'}],
  'sub1|spc82':[{id:'d',text:'note',tone:'weird',command:{name:'some-mod.show',args:{n:1}}},{id:'e',text:'bad',open:{mod:'../escape'}}],
 });
 assert.deepEqual(Object.keys(clean).sort(),['sub1|spc82','|sp1']);
 assert.equal(clean['|sp1'].length,1);
 assert.equal(clean['|sp1'][0].text,'! 2');
 assert.equal(clean['sub1|spc82'][0].tone,'dim','unknown tones fall back');
 assert.equal(clean['sub1|spc82'][1].open,null,'a mod name with a path is refused');
 assert.deepEqual(m.badgesFor('|sp1',{'|sp1':[{id:'file'}]},{'|sp1':[{id:'live',text:'L'}]}).map(b=>b.id),['live'],'shared state wins over the file');
 assert.deepEqual(m.badgesFor('|sp1',{'|sp1':[{id:'file'}]},undefined).map(b=>b.id),['file']);
 const allowedLabels=['Ready','Review','Notes'];
 const badges=allowedLabels.map((text,i)=>({id:`demo-${i}`,text,tone:['done','working','dim'][i]}));
 m.workspaceBadges({fileBadges:m.cleanBadges({'|sp1':badges})},{id:'sp1',machine:null},{done:'green',working:'blue',dim:'gray',background:'black'});
 assert.deepEqual(m.renderedLabels,allowedLabels,'the public slot renders exactly the supplied general labels');
 m.renderedLabels.length=0;
 m.workspaceBadges({fileBadges:m.cleanBadges({'|sp1':[{id:'harness-memory',text:'! 3',tone:'dim'},{id:'other',text:'! 2',tone:'blocked'}]})},{id:'sp1',machine:null},{done:'green',working:'blue',dim:'gray',background:'black',blocked:'red'});
 assert.deepEqual(m.renderedLabels,['확인 대기 3','! 2'],'the memory badge says what to do; other badges keep their text');
});

test('badge typed subscriptions notify once per changed hash, retain partial writes and stop with their view',async()=>{
 let receive,notifications=0,unsubscribed=0;
 const view={},cx={notify(){notifications++;}};
 globalThis.__badgeSubscription={appHome:()=>'/badge-demo',subscribeJsonFile:(context,path,callback)=>{assert.equal(context,cx);assert.equal(path,'/badge-demo/data/sixfold/workspace-badges.json');receive=callback;return()=>{unsubscribed++;};},div:()=>null,h_flex:()=>null,openOverlay:()=>{},run:()=>{},shared:()=>undefined};
 let source=(await readFile(new URL('../mods/sixfold-desk/badges.js',import.meta.url),'utf8')).replace(/^import[^\n]*\n/gm,'');
 source='const {appHome,subscribeJsonFile,div,h_flex,openOverlay,run,shared}=globalThis.__badgeSubscription;\n'+source;
 try{
  const {watchBadges}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
  const stop=watchBadges(view,cx);assert.deepEqual(view.fileBadges,{});assert.equal(view.fileSubscriptions[0],stop);
  const data={'|demo-space':[{id:'demo-badge',text:'Example',tone:'accent'}]};
  const parse=JSON.parse;JSON.parse=()=>{throw Error('UI file parsing');};
  try{
   receive({status:'missing',hash:null,value:null});assert.equal(notifications,0);
   receive({status:'ready',hash:'first',value:data});
   for(let index=0;index<30;index++)receive({status:'ready',hash:'first',value:{...data}});
   receive({status:'invalid',hash:'partial',value:data});receive({status:'missing',hash:null,value:data});
  }finally{JSON.parse=parse;}
  assert.equal(notifications,1);assert.equal(view.fileBadges['|demo-space'][0].text,'Example');
  receive({status:'ready',hash:'second',value:{'|demo-space':[{id:'demo-badge',text:'Updated',tone:'working'}]}});assert.equal(notifications,2);
  view.panelTrackingActive=true;receive({status:'ready',hash:'third',value:{'|demo-space':[{id:'demo-badge',text:'Latest',tone:'done'}]}});
  assert.equal(notifications,3,'task tracking also displays changed workspace badges');assert.equal(view.fileBadges['|demo-space'][0].text,'Latest','the classic branch retains its latest data');
  stop();stop();assert.equal(unsubscribed,1);
  receive({status:'ready',hash:'after-close',value:{}});assert.equal(view.fileBadges['|demo-space'][0].text,'Latest');
 }finally{delete globalThis.__badgeSubscription;}
});
