import {classicPanelImports} from './classic-panel-imports.mjs';
import { readFile } from 'node:fs/promises';

// Loads the real classic sidebar (main.js) against a fake native runtime, with the
// task panel and unrelated sections stubbed. The runtime's messageEvents (or its
// absence) selects the in-memory message log or the legacy messages.json file.
// `tag` is part of each module URL, so a load with a new tag gets fresh module state.
export async function loadSidebar(runtime,tag){
  globalThis.__sixfoldTest = runtime;
  let ioSource=(await readFile(new URL('../mods/sixfold-desk/panel-io.js',import.meta.url),'utf8'))
    .replace(/import \* as native from 'herdr';/,'const native=globalThis.__sixfoldTest;')
    .replace("'./file-feed.js'",JSON.stringify(new URL('../mods/sixfold-desk/file-feed.js',import.meta.url).href));
  ioSource+=`\n// load=${tag}`;
  const io=await import('data:text/javascript;base64,'+Buffer.from(ioSource).toString('base64'));
  runtime.fileDelivery=io.fileDelivery;runtime.FILE_CHANGED_COMMAND=io.FILE_CHANGED_COMMAND;
  let source = await readFile(new URL('../mods/sixfold-desk/main.js', import.meta.url),'utf8');
  source=source.replace("'./panel-host.js'",JSON.stringify(new URL('../mods/sixfold-desk/panel-host.js',import.meta.url).href));
  source=classicPanelImports(source).replace("'./panel-model.js'",JSON.stringify(new URL('../mods/sixfold-desk/panel-model.js',import.meta.url).href));
  source=source.replace("import {createRetainedPanel} from './panel-retained.js';",'const createRetainedPanel=()=>null;');
  for(const name of ['task-feed-source','task-issue-state','poll'])source=source.replace(`'./${name}.js'`,JSON.stringify(new URL(`../mods/sixfold-desk/${name}.js`,import.meta.url).href));
  source=source.replace("import {createRetainedCards} from './retained-cards.js';",'const createRetainedCards=()=>({begin(){},card(_id,_signature,build){return build();},end(){},dispose(){}});');
  source=source.replace(/import .* from '.\/panel-io.js';/,'const {subscribeJsonFile,readJsonSnapshot,fileDelivery,FILE_CHANGED_COMMAND}=globalThis.__sixfoldTest,subscribeFileChanges=()=>()=>{};');
  let filesSource=(await readFile(new URL('../mods/sixfold-desk/sidebar-files.js',import.meta.url),'utf8')).replace(/import .* from '.\/panel-io.js';/,'const {subscribeJsonFile}=globalThis.__sixfoldTest;');
  filesSource+=`\n// load=${tag}`;
  const filesUrl='data:text/javascript;base64,'+Buffer.from(filesSource).toString('base64');
  source=source.replace(/import .* from '.\/mic.js';/,"const watchMic=()=>{},paneMic=()=>null,paneMicChip=()=>null,MIC_KEY='sixfold.voice.mic';").replace("'./sidebar-files.js'",JSON.stringify(filesUrl)).replace("'./live-events.js'",JSON.stringify(new URL('../mods/sixfold-desk/live-events.js',import.meta.url).href));
  source = source.replace(/import \{ View, div, svg, image \} from 'gpui-kit';/, 'class View {}');
  source = source.replace(/import \{ h_flex, v_flex \} from 'gpui-base';/, '');
  source = source.replace(/import \* as herdrNative from 'herdr';/, 'const herdrNative = globalThis.__sixfoldTest;');
  source = source.replace(/import \{([^}]+)\} from 'herdr';/, 'const {$1} = globalThis.__sixfoldTest;');
  source = source.replace("import { breathingBorder, borderComet } from './collab-flow-view.js';", 'const breathingBorder=o=>{(globalThis.__breathCalls??=[]).push(o);return div().absolute().top(-1).left(-1).right(-1).bottom(-1).rounded(7).border(2).border_color(o.color);},borderComet=o=>{(globalThis.__flowCalls??=[]).push(o);return null;};');
  for (const name of ['model','flow','workflow','sidebar-identity','collab', 'collab-flow', 'motion']) source = source.replace(`'./${name}.js'`,JSON.stringify(new URL(`../mods/sixfold-desk/${name}.js`,import.meta.url).href));
  source = source.replace(/import \{ watchDocs, currentDocs \} from '.\/docs.js';/, 'const watchDocs=()=>{};').replace(/import \{[^}]*\} from '.\/docs-finder.js';/,"const docsFinder=(_view,_space,trigger)=>trigger,docsFinderSignature=()=>null,setDocsFinderOpen=()=>{},docsGroup=()=>null;");
  source = source.replace(/import \{ pipeline \} from '.\/pipeline.js';/, '');
  source = source.replace(/import .* from '.\/alert-inbox.js';/,'const workspaceAlertsRow=()=>null, hasWorkspaceAlerts=()=>false,hasNeeds=()=>false,setNeedsNames=()=>{};').replace(/import .* from '.\/alert-arrivals.js';/,"const startAlertArrivals=()=>()=>{},alertArrivalLayer=()=>[],alertCardSignature=()=>'';");
  source = source.replace(/import \{ watchAlerts, alertSection, visibleAlerts \} from '.\/alerts.js';/,
    'const watchAlerts=()=>{};');
  source = source.replace(/import \{ panePet \} from '.\/pets.js';/,'const panePet=()=>null;')
  source = source.replace(/import \{ paneUsage \} from '.\/session-usage.js';/,'const paneUsage=()=>null;').replace(/import \{ paneWork, paneWorkChip \} from '.\/pane-work.js';/,'const paneWork=()=>null,paneWorkChip=()=>null;').replace(/import \{ paneMeta, paneMetaChip, showPaneIndex, showTitle \} from '.\/pane-meta.js';/,'const paneMeta=()=>null,paneMetaChip=()=>null,showPaneIndex=()=>false,showTitle=()=>true;');
  source = source.replace(/import \{ watchBadges, workspaceBadges \} from '.\/badges.js';/,'const watchBadges=()=>{},workspaceBadges=()=>null;').replace(/import \{ watchAsks[^}]*\} from '.\/asks.js';/,'const watchAsks=()=>{},askSection=()=>null,hasAsks=()=>false;').replace(/import \{ askFor \} from '.\/ask-model.js';/,'const askFor=()=>null;').replace(/import \{ watchReports[^}]*\} from '.\/session-reports.js';/,'const watchReports=()=>{},reportsSection=()=>null;');
  return import('data:text/javascript;base64,'+Buffer.from(source).toString('base64')+`#load=${tag}`);
}
