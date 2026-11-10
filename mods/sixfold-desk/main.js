import { View, div, svg, image } from 'gpui-kit';
import { h_flex, v_flex } from 'gpui-base';
import * as herdrNative from 'herdr';
import { agents, panes, spaces, terminals, focused, props, theme, run, shared, setShared, setAgentOrder, nextCommand, exec, window, layout, readTextFile, writeTextFile, appHome, openOverlay, settings } from 'herdr';
import { WORDS, counts, title, cycle, priority, readThrough, unreadCount } from './model.js';

import { computerActive, computerHub, computerKind, computerSlots, computerStatus, computerAlert, tailscaleStatus, workspaceIdentity, workspaceLocal, workspacePinned } from './sidebar-identity.js';

import { freshMessages, recentRoutes, simultaneousRoutes, crossMachine, followComputer, terminalMachine, machineHops, machineTraffic, trafficWake } from './flow.js';
import { pipeline } from './pipeline.js';
import { machineCounts, projectGroups, liveLinks, linkPalette, projectName, trackLinks, collabColor, onCollab, spacePartners } from './collab.js';
import { groupColors, groupKey, paletteMode, breathPeriod, lastGroupSend, cometPlan } from './collab-flow.js';
import { breathingBorder, borderComet } from './collab-flow-view.js';
import { workflowNodes, delegationEvents, workflowStatus, sessionChildren, activeWorkflow } from './workflow.js';
import { watchDocs, currentDocs } from './docs.js';
import { docsFinder, docsFinderSignature, setDocsFinderOpen, docsGroup } from './docs-finder.js';
import { watchAlerts, alertSection, visibleAlerts } from './alerts.js';
import { workspaceAlertsRow, hasWorkspaceAlerts, openInbox, cardAlertCounts, slackAlertsChip, alertsOnMetaLine } from './alert-inbox.js';
import { startAlertArrivals, alertArrivalLayer, alertCardSignature } from './alert-arrivals.js';
import { panePet } from './pets.js';
import { paneUsage } from './session-usage.js';
import { paneMeta, paneMetaChip, showPaneIndex, showTitle } from './pane-meta.js';
import { watchBadges, workspaceBadges } from './badges.js';
import { watchAsks, askSection, hasAsks, paneAskButton, askPopup } from './asks.js';
import { askFor } from './ask-model.js';
import { watchReports, reportsSection } from './session-reports.js';
import {reconcilePanelFeed,panelSpacePartners} from './panel-model.js';
import {panelCounts,panelHeaderMetrics} from './panel-view.js';
import {TASK_FEED_FILE,createTaskFeedSource} from './task-feed-source.js';
import {issueRequest,saveIssueRequest} from './task-issue-state.js';
import {createRetainedPanel} from './panel-retained.js';
import {taskComputerAnchors,taskComputerRecord} from './panel-host.js';
import {subscribeJsonFile,readJsonSnapshot,fileDelivery,FILE_CHANGED_COMMAND} from './panel-io.js';
import {watchSidebarFiles} from './sidebar-files.js';
import {orderSpaceCards,spaceBadges,lineBadges,metaBadges} from './sidebar-meta.js';
import {subscribeLiveEvents} from './live-events.js';
import {createRetainedCards} from './retained-cards.js';
import {createHash} from 'crypto';

const hasPanel=node=>node?.id==='panel'||(node?.children||[]).some(hasPanel);
const native = () => `${appHome()}/scripts/sixfold/herdr-theme${(typeof window==='function' && window()?.platform==='windows') || /^(?:[A-Za-z]:[\\/]|\\\\)/.test(appHome())?'.exe':''}`;
const helperPath = path => {
  const normalized=path.replace(/\\/g,'/').replace(/\/+$/,'');
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//')?normalized.toLowerCase():normalized;
};
// Only the installed theme's own script paths migrate implicitly. Explicit
// external adapters retain their interpreter and argument contract.
export const helperInvocation = (configured, command, args=[]) => {
  if (Array.isArray(configured) && configured.length) return [configured[0],[...configured.slice(1),...args]];
  if (typeof configured === 'string' && /\.py$/i.test(configured)) {
    const bundled=helperPath(configured)===helperPath(`${appHome()}/scripts/sixfold/${command}.py`);
    if (!bundled) return ['python3',[configured,...args]];
  } else if (configured) return [configured,[command,...args]];
  return [native(),[command,...args]];
};
const invokeHelper = (configured, command, args=[]) => {
  const [program,argv]=helperInvocation(configured,command,args);
  return exec(program,argv);
};

// cx.spawn can throw before its callback runs; that callback's finally then never
// releases the busy flag and every later tick of the job is skipped. Release it here.
export function spawnOrRelease(cx, release, task) {
  try { cx.spawn(task); return true; }
  catch { release(); return false; }
}
const marks = { blocked: '!', done: '✓', working: '●', idle: '○' };
// One slow pass of the dot along a link pipe while computers work together.
const LINK_FLOW_MS = 4000;
// Flow marks on the 1px computer pipes are as wide as the line (panel-view LINK_PULSE too).
const LINK_PULSE = 5;   // the slow "working together" pulse
const SEND_PULSE = 8;   // one send between computers: longer than the idle pulse
// Bound the three finite host timers per packet, preserving the installed limit.
const MAX_ACTIVE_FLOWS = 64;
// Sends leave one at a time in the order they were made (2026-11-10: a refresh
// that found several sends started them all at once). The next one waits for the
// real gap between their timestamps, at least FLOW_GAP_MS and at most
// FLOW_REAL_GAP_MS. A queue longer than FLOW_CATCH_UP shortens the gap to catch up,
// and only the newest FLOW_BACKLOG wait; older ones are skipped and counted.
const FLOW_GAP_MS = 320, FLOW_REAL_GAP_MS = 1200, FLOW_MIN_GAP_MS = 90;
const FLOW_CATCH_UP = 4, FLOW_BACKLOG = 12, FLOW_TRAVEL_MS = 1600;
// Sends made while the sidebar was hidden: on return, at most this many, this recent.
const FLOW_RESUME = 3, FLOW_RESUME_MS = 60000;
const flowOrder = (a, b) => (Number.isSafeInteger(a.seq) && Number.isSafeInteger(b.seq) && a.seq !== b.seq ? a.seq - b.seq : 0) || (a.at ?? 0) - (b.at ?? 0);
function departureGap(event, next, waiting) {
  if (waiting > FLOW_CATCH_UP) return Math.max(FLOW_MIN_GAP_MS, Math.round(FLOW_GAP_MS * FLOW_CATCH_UP / waiting));
  const real = Number.isFinite(next?.at) && Number.isFinite(event?.at) ? next.at - event.at : 0;
  return Math.min(FLOW_REAL_GAP_MS, Math.max(FLOW_GAP_MS, real));
}
// Right margin kept beside the computer and workspace lists alike: message curves
// and computer links draw in it, so both lists end on the same line. It stays the
// same at every sidebar width and equals the task panel's PANEL_FLOW.gutter.
const LINK_MARGIN = 48;
// Computer rows match the workspace header rows now that they hold one status line.
const COMPUTER_ROW = 36;

// Pane frames expose only a shared border and focus override. Keep status
// decoration inside the header so it never competes with the keyboard frame.
export function paneHeaderStyle(p, t) {
  const color = p.status === 'working' ? t.working : p.status === 'blocked' ? t.blocked : null;
  return {
    background: color ? `${color.slice(0, 7)}24` : p.focused ? t.selected : t.chrome,
    base: color ? t.chrome : p.focused ? t.selected : t.chrome,
    // Always reserve the 1px border; toggling it on focus shifts the header text.
    border: !p.focused && color ? color : '#00000000',
  };
}

export default class SixfoldDesk extends View {
  init(_props, cx) {
    this.dragSpace = null;
    this.overSpace = null;
    this.messageEvents = [];
    this.workspaceIcons = {};
    this.workspacePins = {spaces:[]};
    this.computers = {};
    this.site = {};
    this.tailscalePeers = [];
    this.tailscaleError = null;
    this.workflowNodes = [];
    this.workflowEvents = [];
    this.previousDelegations = null;
    this.expandedAgents = new Set();
    this.activeFlows = [];
    this.pendingFlows = [];
    this.queuedRoutes = [];
    this.routeScript = null;
    this.routeBusy = false;
    this.collaborationScript = null;
    this.collaborationBusy = false;
    this.readMessages = {};
    // The header cat animates natively (pets.js): a pane header keeps no timer of its own.
    if (props()?.role === 'pane') return;
    if (props()?.role !== 'sidebar') return;
    const fileReceiver=fileDelivery(cx);
    this.sidebarVisible=typeof window!=='function'||window()?.visible!==false;
    this.invalidateSidebar=()=>fileReceiver.enqueue(()=>cx.notify());
    this.refreshPanelPreferences=()=>fileReceiver.enqueue(()=>this.panelRetained?.preferences());
    this.refreshPanelNavigation=()=>fileReceiver.enqueue(()=>this.panelRetained?.navigation());
    this.classicCards=createRetainedCards(cx);
    this.panelState={feed:null,status:'missing'};
    this.panelEvents=null;
    this.panelReducedMotion=null;
    this.panelTrackingActive=false;
    this.panelRetained=typeof cx.new==='function'?createRetainedPanel(cx,{macTitlebar:window()?.platform==='macos',embedded:true,
      onHostChange:()=>this.invalidateSidebar(),
      schedule:fn=>fileReceiver.enqueue(fn),
      // Counts on the meta line only when it carries the alerts; otherwise the alerts row has them (never both).
      cardAlerts:(space,motion)=>alertsOnMetaLine(space,space.name)?cardAlertCounts(space.name,motion):null,slackAlerts:slackAlertsChip,
      cardBadges:metaBadges(this),
      onIssueRequest:(space,key,desired)=>{
        const serial=globalThis.__sixfoldIssueRequestSerial=(globalThis.__sixfoldIssueRequestSerial||0)+1;
        const id=`request-${Date.now().toString(36)}-${serial.toString(36)}-${Math.random().toString(36).slice(2,14)}`;
        return saveIssueRequest(issueRequest(this.panelFeedPath,space,key,desired,id),writeTextFile);
      },
      onClassic:()=>{this.panelTrackingActive=false;this.panelRetained?.setEnabled(false);this.syncCardActivity?.();this.startLiveMessages?.();this.refreshLegacy?.(cx);this.refreshAlerts?.(cx);this.refreshLinear?.(cx);this.refreshAsks?.(cx);},onDispose:()=>{for(const stop of this.fileSubscriptions||[])stop();this.stopAsks?.();this.stopReports?.();this.classicCards?.dispose();}}):null;
    this.fileSubscriptions=[];
    const receiveTaskFeed=createTaskFeedSource(snapshot=>{
      this.panelFeedPath=`${appHome()}/${TASK_FEED_FILE}`;
      const raw=snapshot.status==='ready'?snapshot.value:snapshot.status==='invalid'?{v:0}:null;
      const next=reconcilePanelFeed(raw,this.panelState);
      const first=Boolean(next.feed)&&!this.panelState.feed;
      const changed=next.changed||next.status!==this.panelState.status;
      this.panelState=next;
      this.panelTrackingActive=Boolean(next.feed)&&shared('sixfold.panel.enabled')!==false;
      this.syncCardActivity?.();
      if(next.feed&&this.panelRetained){
        this.panelRetained.setEnabled(this.panelTrackingActive);
        if(changed)this.panelRetained.apply(next.feed,next.status);
      }
      if(changed&&(!this.panelRetained||first))cx.notify();
    });
    this.fileSubscriptions.push(subscribeJsonFile(cx,`${appHome()}/${TASK_FEED_FILE}`,snapshot=>receiveTaskFeed('task',snapshot)));
    this.fileSubscriptions.push(subscribeJsonFile(cx,`${appHome()}/shared.json`,snapshot=>{
      if(snapshot.status!=='ready')return;
      this.panelTrackingActive=Boolean(this.panelState.feed)&&shared('sixfold.panel.enabled')!==false;
      this.syncCardActivity?.();
      this.startLiveMessages?.();
      this.panelRetained?.setEnabled(this.panelTrackingActive);
      this.panelRetained?.preferences();
      this.panelRetained?.alertsChanged?.();   // shared workspace badges sit on task meta lines
    }));
    this.fileSubscriptions.push(subscribeJsonFile(cx,`${appHome()}/settings.json`,snapshot=>{
      if(snapshot.status==='ready')this.panelRetained?.preferences();
    }));
    this.projectDocs=null;
    watchDocs(this,cx);
    this.alerts = [];
    watchAlerts(this, cx);
    startAlertArrivals(this, cx);   // Linear feed + new alerts folding into their card
    watchBadges(this, cx);
    watchAsks(this, cx);
    watchReports(this, cx);
    this.syncCardActivity=()=>{const active=this.sidebarVisible;this.setAsksActive?.(active);this.setReportsActive?.(active);};
    this.syncCardActivity();
    // File notifications start a small number of finite native transitions.
    // No frame-by-frame JavaScript animation or old-message replay on reload.
    this.previousEvents = null;
    this.messageSnapshot = null;
    this.refreshBusy = false;
    const refresh = cx => {
      if (this.refreshBusy) return;
      this.refreshBusy = true;
      spawnOrRelease(cx, () => { this.refreshBusy = false; }, async cx => {
        try {
          const file=this.sidebarFiles||{};
          const events=typeof herdrNative.messageEvents==='function'?(this.nativeMessages||[]):file.messages?.events||[];
          const snapshot=JSON.stringify([events,file,terminals().map(item=>item.address)]);
          if(snapshot===this.messageSnapshot)return;
          const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
          if(object(file.icons))this.workspaceIcons=file.icons;
          if(object(file.site))this.site=file.site;
          if(Array.isArray(file.pins?.spaces))this.workspacePins=file.pins;
          if(object(file.computers))this.computers=file.computers;
          const config=file.routing||{script:this.routeScript};
          const collaboration=file.collaboration;
          this.collaborationScript=collaboration?.enabled===true?collaboration.command||collaboration.script||null:null;
          const requests=file.queue?.requests??this.queuedRoutes;
          const addresses = new Set(terminals().map(item => item.address));
          const workflow=file.workflow||{nodes:this.workflowNodes,events:this.workflowEvents};
          this.workflowNodes = workflowNodes(workflow.nodes,[...addresses]);
          this.workflowEvents = delegationEvents(workflow.events,this.workflowNodes);
          this.workflowNodes.forEach(node=>addresses.add(node.id));
          // After the sidebar was hidden, compare with the watermark it left
          // and replay only the few most recent sends, in order.
          const resuming=this.previousEvents===null&&Boolean(this.resumeEvents);
          const delegations = freshMessages(this.previousDelegations??this.resumeDelegations??null,this.workflowEvents);
          const sends = freshMessages(this.previousEvents??this.resumeEvents??null, events).filter(event => addresses.has(event.source) && addresses.has(event.target));
          // Active rows already show by default; new events must not open history.
          const fresh=[...delegations,...sends];
          this.pendingFlows.push(...(resuming?fresh.filter(event=>event.at>=Date.now()-FLOW_RESUME_MS).sort(flowOrder).slice(-FLOW_RESUME):fresh));
          this.resumeEvents=null;this.resumeDelegations=null;
          this.previousDelegations = this.workflowEvents;
          this.previousEvents = events;
          this.messageEvents = events;
          this.routeScript = config?.command || config?.script;
          this.queuedRoutes = requests.map(({id,source,project,hold,error})=>({id,source,project,hold,error}));
          this.messageSnapshot = snapshot;
          this.startFlows(cx);
          cx.notify();
        } catch { /* Retry a partial write on the next tick, without clearing badges. */ }
        finally { this.refreshBusy = false; }
      });
    };
    this.refreshLegacy=refresh;
    watchSidebarFiles(this,cx,`${appHome()}/data/sixfold`,refresh,{nativeMessages:typeof herdrNative.messageEvents==='function'});
    this.startLiveMessages=()=>{
      if(this.stopLiveMessages||typeof herdrNative.messageEvents!=='function'||!this.sidebarVisible)return;
      this.deliverLiveMessages??=events=>{this.nativeMessages=events;refresh(cx);};
      this.stopLiveMessages=subscribeLiveEvents({key:`${appHome()}:messages`,cx,read:()=>herdrNative.messageEvents(),onChange:events=>fileReceiver.enqueue(this.deliverLiveMessages,events),intervalMs:500});
    };
    this.startLiveMessages();refresh(cx);
    // The slow dot on a computer link turns at the ends of its pipe. A native loop
    // overshot the ends, so the dot moves by transition and turns here, only while
    // some link is being worked on.
    this.linkFlowEnd = false;
    this.scheduleLinkFlow=()=>{
      if(!this.linkFlowing||this.sidebarVisible===false){this.linkFlowTimer?.cancel();this.linkFlowTimer=null;return;}
      if(this.linkFlowTimer)return;
      this.linkFlowTimer=cx.timer.after(LINK_FLOW_MS,()=>{
        this.linkFlowTimer=null;
        if(!this.linkFlowing||this.sidebarVisible===false)return;
        this.linkFlowEnd=!this.linkFlowEnd;cx.notify();
      });
    };
    // Reserve only the next corner/start/end. Each message has its own arrival time;
    // a global interval would miss those boundaries and notify on unchanged steps.
    this.wakeComet = (at, cx) => {
      if (at === this.cometWake) return;
      this.cometTimer?.cancel();
      this.cometWake = at;
      if (at === null) return;
      this.cometTimer = cx.timer.after(Math.max(1, Math.ceil(at - Date.now())), cx => {
        if (this.cometWake !== at) return;
        this.cometWake = null;
        if (this.collabFlowing && shared('sixfold.motion') !== false) cx.notify();
      });
    };
    // Links also change with time alone: a send link ends five minutes after its last
    // send and an ended link leaves after its fade. Redraw when the next one is due.
    this.linkWake = null;
    this.scheduleLinkWake=at=>{
      if(at===this.linkWakeAt)return;
      this.linkWakeTimer?.cancel();this.linkWakeTimer=null;this.linkWakeAt=at;
      if(at===null||this.sidebarVisible===false)return;
      this.linkWakeTimer=cx.timer.after(Math.max(1,at-Date.now()),()=>{
        this.linkWakeTimer=null;this.linkWakeAt=null;this.linkWake=null;
        if(this.sidebarVisible!==false)cx.notify();
      });
    };
    // Opt-in local status read only. These peers are not hc connections.
    let computersBusy=false, computersAt=0;
    cx.timer.every(1000,cx=>{
      if(!this.computers?.tailscale || computersBusy || Date.now()-computersAt<15000)return;
      const lastComputers=computersAt;
      computersBusy=true;computersAt=Date.now();
      // A rejected spawn is not a poll: the next tick may try again.
      spawnOrRelease(cx,()=>{computersBusy=false;computersAt=lastComputers;},async cx=>{
        try {
          const result=await exec(native(),['collect_computers']);
          if(result.code!==0)throw Error('status unavailable');
          const status=JSON.parse(result.stdout);
          if(status.error || !Array.isArray(status.peers))throw Error('status unavailable');
          this.tailscalePeers=status.peers;
          this.tailscaleError=null;
        } catch {
          this.tailscalePeers=this.tailscalePeers.map(peer=>({...peer,online:null}));
          this.tailscaleError=true;
        } finally {computersBusy=false;cx.notify();}
      });
    });
    // Kept on disk so a restart does not count the whole message log as unread.
    let readBusy=false;
    cx.timer.every(1000,cx=>{
      if(this.sidebarVisible===false||!this.messageEvents?.length||readBusy)return;
      readBusy=true;
      spawnOrRelease(cx,()=>{readBusy=false;},async cx=>{
        try{
          const path=`${appHome()}/data/sixfold/messages-read.json`;
          const old=await readTextFile(path).catch(()=>null);
          const ledger=await readJsonSnapshot(path);
          if(old!==null&&ledger.hash!==createHash('sha256').update(old).digest('hex'))return;
          const saved=ledger.status==='ready'?ledger.value||{}:{};
          const next=readThrough(this.messageEvents??[],agents(),focused()?.terminal,{...this.readMessages,...saved},Date.now());
          const text=JSON.stringify(next);
          if(text!==old)await writeTextFile(path,text,old);
          if(text!==JSON.stringify(this.readMessages)){this.readMessages=next;cx.notify();}
        }catch{ /* Retry a partial or conflicting write on the next tick. */ }
        finally{readBusy=false;}
      });
    });
    cx.timer.every(2000, cx => {
      if (this.routeBusy || !this.routeScript || !this.queuedRoutes.some(item=>!item.hold)) return;
      this.routeBusy = true;
      spawnOrRelease(cx, () => { this.routeBusy = false; }, async cx => {
        try { await invokeHelper(this.routeScript,'route',['--drain']); }
        finally { this.routeBusy = false; }
      });
    });
    // Registered work uses its own lease ledger; never infer tasks from speech or UI activity.
    cx.timer.every(2000, cx => {
      if (this.collaborationBusy || !this.collaborationScript) return;
      this.collaborationBusy = true;
      spawnOrRelease(cx, () => { this.collaborationBusy = false; }, async cx => {
        try { await invokeHelper(this.collaborationScript,'collaborate',['drain']); }
        catch { /* The durable lease prevents blind retry after ambiguous delivery. */ }
        finally { this.collaborationBusy = false; }
      });
    });
    // Optional voice integration is opt-in and runs only from this one sidebar.
    // Focus is sampled by a timer, never changed by rendering background rows.
    let voiceBusy=false, voiceActionBusy=false, voiceKey=null;
    cx.timer.every(500,cx=>{
      const config=this.sidebarFiles?.voice;
      if(!config?.script&&!config?.command)return;
      if(voiceBusy)return;
      voiceBusy=true;
      spawnOrRelease(cx,()=>{voiceBusy=false;},async cx=>{
        try {
          if(!config?.script && !config?.command)return;
          const f=focused(), facts=terminals(), current=facts.find(x=>x.address===f?.terminal);
          const state={at:Date.now(),active:window().active,terminal:f?.terminal,
            source:current?.labels?.['sixfold.source-pane'],
            panes:agents().filter(a=>!facts.find(x=>x.address===a.address)?.labels?.['sixfold.source-pane'])
              .filter(a=>['claude','codex'].includes(a.program?.key))
              .map(a=>({pane_id:`app:${a.address}`,agent:a.program.key,agent_status:a.status}))};
          const path=`${appHome()}/data/sixfold/voice-focus.json`;
          const old=await readTextFile(path);
          await writeTextFile(path,JSON.stringify(state),old);
          const key=JSON.stringify([state.active,state.terminal,state.source]);
          if(key!==voiceKey && !voiceActionBusy){
            const lastKey=voiceKey;
            voiceKey=key;voiceActionBusy=true;
            // Keep publishing focus while a voice connection starts. The helper
            // rechecks that heartbeat before sending any microphone controls.
            // A spawn rejected before the action starts must not consume the focus
            // change; once the helper has been tried, the key stays consumed.
            spawnOrRelease(cx,()=>{voiceActionBusy=false;voiceKey=lastKey;},async cx=>{
              try {
                if (Array.isArray(config.command)) await invokeHelper(config.command,'focus_queue',['--app-focus']);
                else if(config.command) await exec(config.command,[...(config.args || ['focus_queue']),'--app-focus']);
                else await invokeHelper(config.script,'focus_queue',['--app-focus']);
              } finally {voiceActionBusy=false;}
            });
          }
        } catch { /* Optional integration failure must not disrupt terminals. */ }
        finally {voiceBusy=false;}
      });
    });
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if(command==='window.visibility'){
          const visible=window()?.visible!==false;
          if(!visible){
            this.sidebarVisible=false;this.syncCardActivity?.();this.panelRetained?.setVisible(false);
            const resumeEvents=this.previousEvents,resumeDelegations=this.previousDelegations;
            this.stopLegacyMotion();this.resumeEvents=resumeEvents;this.resumeDelegations=resumeDelegations;this.stopLiveMessages?.();this.stopLiveMessages=null;
            fileReceiver.flush();
          }else{
            // Drain the latest queued data while the retained panel is still
            // suspended, then resume from that watermark in this copy's scope.
            fileReceiver.flush();this.sidebarVisible=true;this.syncCardActivity?.();
            this.panelRetained?.setVisible(true);this.panelRetained?.preferences();
            this.startLiveMessages?.();this.refreshLegacy?.(cx);this.refreshAlerts?.(cx);this.refreshLinear?.(cx);this.refreshAsks?.(cx);
            cx.notify();
          }
          continue;
        }
        if(command===FILE_CHANGED_COMMAND){fileReceiver.flush();continue;}
        const f = focused();
        const current = panes().filter(p => p.tab === f?.tab);
        if (command === 'new-workspace') {
          const machine = spaces().find(space => space.id === f?.space)?.machine ?? null;
          this.newWorkspace(machine);
        } else if (command === 'next-pane' || command === 'prev-pane') {
          const p = cycle(current, f?.pane, command === 'next-pane' ? 1 : -1);
          if (p) run('pane.focus', { pane: p.pane });
        } else if (command.startsWith('pane-')) {
          const p = current[Number(command.slice(5)) - 1];
          if (p) run('pane.focus', { pane: p.pane });
        } else if (/^computer-[1-9]$/.test(command)) {
          // Same as clicking the sidebar card: list plus that computer's Share space and pane.
          const machines = typeof herdrNative.machines === 'function' ? herdrNative.machines() : [{ name: null, layout: 'ready' }];
          const key = computerSlots(machines)[Number(command.slice(9)) - 1];
          if (key) this.selectComputer(key);
        } else if (command === 'next-blocked' || command === 'next-done') {
          const state = command === 'next-blocked' ? 'blocked' : 'done';
          const machine = spaces().find(space => space.id === f?.space)?.machine ?? null;
          const scope = new Set(spaces().filter(space => (space.machine ?? null) === machine).map(space => space.id));
          const list = agents().filter(a => a.status === state && scope.has(a.space));
          const index = list.findIndex(a => a.address === f?.terminal);
          const a = list[(index + 1) % list.length];
          if (a) run('agent.focus', { terminal: a.address });
        } else if (command === 'find-docs') {
          const space=spaces().find(s=>s.active);
          // Opens that space's document finder (the popover on its header's docs button); again closes it.
          if(space)setDocsFinderOpen(this,space,!this.docsFinders?.get(space.id)?.open,cx);
        } else if (command === 'language') {
          setShared('sixfold.language', this.lang() === 'ko' ? 'en' : 'ko');
        } else if (command.startsWith('inbox-')) {
          openInbox({project:command.slice(6)});
        }
        cx.notify();
      }
    });
  }

  lang() { return shared('sixfold.language') === 'en' ? 'en' : 'ko'; }

  close(){
    this.stopLegacyMotion();
    this.stopAsks?.();this.stopReports?.();
    this.classicCards?.dispose();
    this.stopArrivals?.();
    this.linkFlowTimer?.cancel();this.linkWakeTimer?.cancel();this.cometTimer?.cancel();
    for(const stop of this.fileSubscriptions||[])stop();
    this.fileSubscriptions=[];this.stopLiveMessages?.();this.stopLiveMessages=null;this.panelRetained?.dispose();
  }

  stopLegacyMotion(){
    for(const timer of this.flowTimers||[])try{timer.cancel();}catch{}
    this.flowTimers?.clear();this.activeFlows=[];this.pendingFlows=[];this.departTimer=null;this.skippedFlows=0;
    this.previousEvents=null;this.previousDelegations=null;this.resumeEvents=null;this.resumeDelegations=null;
    this.linkFlowTimer?.cancel();this.linkFlowTimer=null;
    this.linkWakeTimer?.cancel();this.linkWakeTimer=null;this.linkWakeAt=null;
    this.cometTimer?.cancel();this.cometTimer=null;this.cometWake=null;
    this.linkFlowing=false;this.collabFlowing=false;
  }

  computerLabel(machine) {
    const config = machine === null ? this.computers?.local : this.computers?.machines?.[machine];
    return config?.label || (machine === null ? (this.lang() === 'ko' ? '이 컴퓨터' : 'This computer') : machine);
  }

  selectedComputer() {
    const space = focused()?.space;
    const machine = spaces().find(s => s.id === space)?.machine;
    // Moving focus to another computer's session switches the list with it.
    return followComputer(this.computerFollow ??= {}, !space ? null : machine ? `remote:${machine}` : 'local', shared('sixfold.computing.selected'));
  }

  selectComputer(key) {
    (this.computerFollow ??= {}).follow = false;
    setShared('sixfold.computing.selected', key);
    this.enterComputerHub(key);
  }

  // Cards and shortcuts also bring the shown space and focused pane to that computer's Share.
  // Without one unambiguous Share (or for a Tailscale-only device) only the list changes.
  enterComputerHub(key) {
    const hub = computerHub(spaces(), key, this.site, this.computers);
    if (!hub || focused()?.space === hub.id) return;
    run('space.select', { id: hub.id });
    const tab = hub.tabs.find(t => t.active) ?? hub.tabs[0];
    const list = tab ? panes().filter(p => p.tab === tab.id) : [];
    const pane = list.find(p => p.focused) ?? list.find(p => p.terminal);
    if (pane) run('pane.focus', { pane: pane.pane });
  }

  newWorkspace(machine) {
    const config = machine === null ? this.computers?.local : this.computers?.machines?.[machine];
    openOverlay({mod:'sixfold-new-space',props:{machine, machineLabel:this.computerLabel(machine), folder:config?.folder},kind:'dialog',width:440,modal:true});
  }

  button(id, text, action, t) {
    return div().id(id).px(8).py(4).rounded(5).text_size(11).text_color(t.muted)
      .hover(s => s.bg(t.hover).text_color(t.foreground)).on_click(action).child(text);
  }

  badge(status, text, t, size = 11, labelColor = null) {
    // Working uses the stock Herdr spinner (same asset, color and speed as the default agents list).
    const mark = status === 'working'
      ? svg('mods/workspace-chrome/spinner.svg').size(size+1).flex_none().text_color(t.working).when(shared('sixfold.motion')!==false,e=>e.spin(900))
      // Idle: the same ring at rest, breathing slowly instead of turning.
      : status === 'idle'
      ? svg('mods/sixfold-desk/icons/idle.svg').size(size+1).flex_none().text_color(t.idle ?? t.dim)
          .when(shared('sixfold.motion')!==false,e=>e.loop('opacity', { from: 0.35, to: 1, period: 2400 }))
      : div().font_bold().child(marks[status] ?? '·');
    return h_flex().gap(5).items_center().text_size(size).text_color(t[status] ?? t.muted)
      .child(mark).child(labelColor ? div().text_color(labelColor).child(text) : text);
  }

  startFlows(cx) {
    if(this.sidebarVisible===false){this.pendingFlows=[];return;}
    this.flowTimers??=new Set();
    const after=(ms,callback)=>{
      let timer;timer=cx.timer.after(ms,cx=>{this.flowTimers.delete(timer);callback(cx);});
      this.flowTimers.add(timer);return timer;
    };
    this.pendingFlows.sort(flowOrder);
    if(this.pendingFlows.length>FLOW_BACKLOG){
      this.skippedFlows=(this.skippedFlows||0)+this.pendingFlows.length-FLOW_BACKLOG;
      this.pendingFlows=this.pendingFlows.slice(-FLOW_BACKLOG);
    }
    // One departure per slot: a single pending timer opens the next slot.
    if(this.departTimer||!this.pendingFlows.length||this.activeFlows.length>=MAX_ACTIVE_FLOWS)return;
    const event = this.pendingFlows.shift();
    const same=this.activeFlows.filter(flow=>flow.source===event.source&&flow.target===event.target);
    const occupied = new Set(this.activeFlows.map(flow => flow.lane));
    const lane = same[0]?.lane ?? [0,1,2,3,4,5].find(value=>!occupied.has(value)) ?? this.activeFlows.length%6;
    const travelMs=FLOW_TRAVEL_MS;
    const flow = { ...event, lane, travelMs, phase: 'start' };
    this.activeFlows.push(flow);
    after(60, cx => {
      flow.phase = 'travel';
      cx.notify();
    });
    after(travelMs+60, cx => {
      flow.phase = 'arrived';
      cx.notify();
    });
    after(travelMs+2200, cx => {
      this.activeFlows = this.activeFlows.filter(item => item.id !== flow.id);
      if(!this.activeFlows.length&&!this.pendingFlows.length)this.skippedFlows=0;
      this.startFlows(cx);
      cx.notify();
    });
    this.departTimer=after(departureGap(event,this.pendingFlows[0],this.pendingFlows.length),cx=>{
      this.departTimer=null;
      this.startFlows(cx);
      cx.notify();
    });
  }


  paneHeader(all, t, w) {
    const p = all.find(p => p.pane === props()?.pane);
    if (!p) return div();
    const index = all.filter(x => x.tab === p.tab).findIndex(x => x.pane === p.pane) + 1;
    const style = paneHeaderStyle(p, t);
    // Agent icon, model, speed, effort and permission of the pane's confirmed session, after the title.
    const meta = paneMeta(p.terminal, shared), name = title(p), ask = paneAskButton(p, t, this.lang(), name);
    return div().size_full().bg(style.base).child(h_flex().id(`sixfold-head-${p.pane}`).size_full().items_center().gap(7).px(9)
      .bg(style.background).text_size(11.5)
      .border(1).border_color(style.border)
      .on_size_change((size, cx) => { const width = size.width / (settings().zoom || 1); if (Math.abs((this.headWidth || 0) - width) > 8) { this.headWidth = width; cx.notify(); } })
      .on_click(() => run('pane.focus', { pane: p.pane }))
      .when(showPaneIndex(this.site), el => el.child(div().flex_none().font_bold().text_color(p.focused ? t.accent : t.dim).child(String(index).padStart(2, '0'))))
      .child(h_flex().flex_1().min_w(0).items_center().gap(7)
        .when(showTitle(name, meta), el => el.child(div().min_w(0).truncate().text_color(t.foreground).child(name)))
        .when(Boolean(meta), el => el.child(paneMetaChip(p, t, meta, this.headWidth))))
      // Session usage sits in the middle: title and an equal spacer share the room around it.
      .child(paneUsage(p, t, shared))
      .child(div().flex_1().min_w(0))
      // A waiting question/permission opens here, over its own pane, on click only.
      .when(Boolean(ask), el => el.child(ask))
      // The cat is the status, so it stands beside the status badge.
      .child(panePet(p,t,shared,style))
      .child(this.badge(p.status, p.status ? w[p.status] : '', t, 11, ['working', 'blocked'].includes(p.status) ? t.foreground : null)));
  }

  render(cx) {
    const t = theme();
    const w = WORDS[this.lang()];
    const role = props()?.role;
    // One pane's cards in a popup (asks.js). It needs none of the layout work below.
    if (role === 'ask') return askPopup(this, t, this.lang(), cx);
    if(role==='sidebar'){
      const environment=JSON.stringify([t,shared('sixfold.motion'),window()?.visible??null]);
      if(environment!==this.panelEnvironment){this.panelEnvironment=environment;this.refreshPanelPreferences?.();}
      const navigation=JSON.stringify(spaces().map(space=>[space.id,space.machine??null,space.active]));
      if(navigation!==this.panelNavigation){this.panelNavigation=navigation;this.refreshPanelNavigation?.();}
    }
    const f = focused();
    const facts = terminals();
    const onlySpace = props()?.onlySpace;
    const selectedComputer = this.selectedComputer();
    if (role === 'sidebar') {
      // Publish the computer this sidebar shows, so the strip's CPU/RAM follow it.
      const machine = selectedComputer.startsWith('remote:') ? selectedComputer.slice(7) : null;
      const label = selectedComputer.startsWith('tailscale:') ? selectedComputer.slice(10) : this.computerLabel(machine);
      const shown = shared('sixfold.computing.shown');
      if (shown?.key !== selectedComputer || shown?.label !== label) setShared('sixfold.computing.shown', { key: selectedComputer, label });
    }
    const discoveryOnly = selectedComputer.startsWith('tailscale:');
    const selectedMachine = role === 'sidebar'
      ? (selectedComputer.startsWith('remote:') ? selectedComputer.slice(7) : null)
      : spaces().find(space => space.id === f?.space)?.machine ?? null;
    const workspaceList = spaces().filter(s => onlySpace ? s.id === onlySpace
      : (role !== 'sidebar' || !discoveryOnly) && (s.machine ?? null) === selectedMachine);
    const workspaceIds = new Set(workspaceList.map(space => space.id));
    const tabIds = new Set(workspaceList.flatMap(s=>s.tabs.map(tab=>tab.id)));
    const all = panes().filter(p=>tabIds.has(p.tab)).map(p => ({...p, title: facts.find(x=>x.address===p.terminal)?.labels?.['sixfold.title'] || p.title}));
    // A pane header needs none of the sidebar's routing work, and redraws often while its cat runs.
    if (role === 'pane') return this.paneHeader(all, t, w);
    // Task rows extend the native computer navigator. They never replace its
    // computer selection, workspace actions, documents or local card sections.
    const taskPanel=role==='sidebar'&&this.panelTrackingActive?this.panelRetained:null;
    const list = agents().filter(a => workspaceIds.has(a.space));
    const local = all.filter(p => p.tab === f?.tab);
    const taskComputer=taskComputerRecord(taskPanel?.feed,selectedMachine);
    const total = taskComputer?panelCounts({spaces:taskPanel.feed.spaces.filter(space=>space.computer===taskComputer.id)}):counts(list);
    const nodeIds = new Set([...facts.map(x=>x.address),...this.workflowNodes.map(x=>x.id)]);
    const events = [...(this.messageEvents ?? []),...this.workflowEvents].filter(e=>nodeIds.has(e.source)&&nodeIds.has(e.target));
    const unseen = address => unreadCount(this.messageEvents,address,this.readMessages);
    const palette = [t.accent, t.ansi6, t.ansi5, t.ansi3, t.ansi2, t.ansi4];
    const flows = this.activeFlows;
    const routes = simultaneousRoutes(flows);
    const motion = shared('sixfold.motion') !== false&&window()?.visible!==false&&this.panelState?.feed?.reduced_motion!==true;
    const endpoint = address => flows.some(flow => flow.source === address || flow.target === address);
    const known = new Set(facts.map(x => x.address));
    const machineOf = address => terminalMachine(address, known);
    // Sends that cross to another connected computer get their own marks.
    const remoteRoutes = routes.map(route => ({ route, hop: crossMachine(route, machineOf) })).filter(item => item.hop);
    const routeColor = address => palette[flows.find(flow => flow.target === address || flow.source === address)?.lane ?? 0];
    const label = address => {
      const child=this.workflowNodes.find(node=>node.id===address);
      if(child)return child.label || child.id;
      const p = panes().find(p => p.terminal === address);
      const s = spaces().find(s => s.tabs.some(tab => tab.id === p?.tab));
      return p ? `${s?.machine ? `${this.computerLabel(s.machine)} / ` : ''}${s?.name ?? ''} · ${title(p)}` : address === 'external' ? (this.lang() === 'ko' ? '외부' : 'External') : address;
    };
    const history = recentRoutes(events);
    const paths = flows.length ? routes : history.map((event, lane) => ({ ...event, lane, phase: 'history' }));
    if (role === 'footer') {
      const p = all.find(p => p.pane === f?.pane);
      const linked = terminals().find(x => x.address === f?.terminal)?.labels?.['sixfold.source-pane'];
      return h_flex().size_full().items_center().gap(10).px(12).bg(t.chrome).border_t(1).border_color(t.border)
        .text_size(11).text_color(t.muted)
        .child(div().font_bold().text_color(t.accent).child(w.input))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(p ? title(p) : w.noFocus))
        .when(Boolean(linked), e=>e.child(div().text_color(t.accent).child(w.bridge)))
        .child(div().child(`${local.length} panes · ⌘[ / ⌘] · ⌘⇧↵`));
    }
    if (role === 'toolbar') {
      return h_flex().size_full().items_center().gap(3).px(10).bg(t.chrome).text_color(t.foreground)
        .child(div().flex_1().text_size(12).font_bold().child('HERDR THEME / WORKSPACE'))
        .child(this.button('sf-blocked', `! ${w.blocked}`, () => run('sixfold-desk.next-blocked'), t))
        .child(this.button('sf-done', `✓ ${w.done}`, () => run('sixfold-desk.next-done'), t))
        .child(this.button('sf-zoom', w.zoom, () => run('pane.zoom'), t))
        .child(this.button('sf-motion', shared('sixfold.motion')===false?'Motion off':'Motion on',()=>setShared('sixfold.motion',shared('sixfold.motion')===false),t))
        .when(hasPanel(layout()),e=>e.child(this.button('sf-review', w.review, () => { run('layout.select', {stack:'panel-body',child:'changes'}); run('layout.toggle',{id:'panel'}); }, t)))
        .when(hasPanel(layout()),e=>e.child(this.button('sf-files', w.files, () => { run('layout.select', {stack:'panel-body',child:'files'}); run('layout.toggle',{id:'panel'}); }, t)));
    }
    // Reading a background workspace must never change another client's focus.
    setAgentOrder(list.map(a => a.address));
    const icon = (p, program) => {
      const key=program?.key;
      const active=p.status==='working' || endpoint(p.terminal);
      const custom=['claude','codex'].includes(key);
      const color=active ? (key==='claude'?'#f5b56c':t.accent) : t.dim;
      const glyph=custom ? svg(`mods/sixfold-desk/icons/${key}.svg`).size(14).text_color(color)
        : program?.icon ? (program.tint ? svg(program.icon).size(14).text_color(color) : image(program.icon).w(14).h(14)) : div().size(14);
      return div().relative().size(16).flex_none()
        .child(glyph.absolute().left(1).top(0)
          );
    };
    const section = text => div().px(12).pt(13).pb(6).text_size(10).font_bold().text_color(t.dim).child(text);
    const agentList = agents(), spaceList = spaces();
    const groupingKey=JSON.stringify([agentList,spaceList,this.site,this.computers,shared('sixfold.language')]);
    if(this.classicGrouping?.key!==groupingKey)this.classicGrouping={key:groupingKey,machineAgents:machineCounts(agentList,spaceList),groups:projectGroups(agentList,spaceList,machine=>machine===null?null:this.computerLabel(machine))};
    const machineAgents = this.classicGrouping.machineAgents;
    // Same-named projects on two or more computers (linked groups), and those
    // being worked on from at least two now. Names only: not a message route.
    const labelOf = machine => machine === null ? null : this.computerLabel(machine);
    const allGroups = this.classicGrouping.groups;
    const linkGroups = allGroups.slice(0, 4);
    // Partner workspaces (same project on another computer) always show, in the collaboration
    // colour; hovering one side highlights the other (this.hoverSpace / this.hoverComputer).
    const collab = collabColor(t);
    const partnersOf = space => spacePartners(allGroups, space, labelOf);
    // ⑩ With two or more groups working together now, each group has its own colour on both
    // sides (this computer's workspace and the partner's computer row); one group keeps ⑨'s.
    const groupPaletteKey=JSON.stringify([allGroups.filter(group=>group.active).map(group=>group.name),t]);
    if(this.classicGrouping.paletteKey!==groupPaletteKey){this.classicGrouping.paletteKey=groupPaletteKey;this.classicGrouping.palette=groupColors(allGroups.filter(group=>group.active).map(group=>group.name),paletteMode(t),t);}
    const colorOfGroup = this.classicGrouping.palette;
    const groupColor = name => colorOfGroup.get(groupKey(name))?.color ?? collab;
    const groupIndex = name => colorOfGroup.get(groupKey(name))?.index ?? 0;
    // A cross-computer message enters the receiving workspace in its group colour.
    // Local routes and sends outside that workspace's active partners keep their palette.
    const workspaceFlowColor = flow => {
      const fallback = palette[flow.lane % palette.length];
      const hop = crossMachine(flow, machineOf);
      if (!hop) return fallback;
      const agent = agentList.find(item => item.address === flow.target);
      const pane = panes().find(item => item.terminal === flow.target);
      const recipient = spaceList.find(space => space.id === agent?.space)
        ?? spaceList.find(space => space.tabs.some(tab => tab.id === pane?.tab));
      if (!recipient || (recipient.machine ?? null) !== hop.to) return fallback;
      const partner = partnersOf(recipient);
      return partner?.active && partner.activePartners.includes(hop.from) ? groupColor(partner.group.name) : fallback;
    };
    const hoverSpace = this.hoverSpace ? spaceList.find(space => space.id === this.hoverSpace) : null;
    const hoverPartners = new Set(hoverSpace ? (partnersOf(hoverSpace)?.partners ?? []) : []);
    const hoverColor = hoverSpace && partnersOf(hoverSpace) ? groupColor(partnersOf(hoverSpace).group.name) : collab;
    const collabs = linkGroups.filter(group => group.active);
    const collabNote = this.lang()==='ko' ? '같은 프로젝트 동시 작업 표시 · 메시지 전달 증거 아님' : 'Same project worked on at once · not evidence of messages';
    const collabText = project => `${project.name}: ${project.machines.map((m, i) => `${this.computerLabel(m)}${project.working[i] ? ` ●${project.working[i]}` : ''}`).join(' · ')}`;
    // Sends between computers: counts per row for the last ten minutes, and the latest few below.
    const sendEvents = (this.messageEvents ?? []).filter(event => !event.external);
    const traffic = machineTraffic(sendEvents, machineOf, Date.now());
    const hops = machineHops(sendEvents, machineOf, 32);
    // ⑪ F: a group's newest send between its computers starts a comet on its
    // border when the packet arrives (cometPlan); without motion nothing runs.
    const comets = motion
      ? cometPlan(new Map(allGroups.filter(group => group.active).map(group => [groupKey(group.name), lastGroupSend(group, hops)])), Date.now())
      : { comets: new Map(), waking: null, flowing: false };
    // Redraw at each corner only while a comet runs or is about to start (no frame timer).
    this.collabFlowing = comets.flowing || comets.waking !== null;
    this.wakeComet?.(comets.waking, cx);
    // Computers joined now (collab.js liveLinks). Each link keeps its slot (lane and
    // colour) while it lasts; a link that ends fades out, then leaves.
    const linkColors = linkPalette(t);
    const now = Date.now();
    const links = liveLinks(linkGroups, hops, now);
    this.linkSeen ??= new Map();
    const tracked = trackLinks(this.linkSeen, links, now, motion);
    // Redraw when a link ends or fades, or when a counted send leaves the ten-minute ↑↓ window.
    const wakes = [tracked.wake, trafficWake(sendEvents, machineOf, now)].filter(value => value !== null);
    this.linkWake = wakes.length ? Math.min(...wakes) : null;
    this.scheduleLinkWake?.(this.linkWake);
    const lanes = tracked.lanes.map(entry => ({ ...entry, colors: linkColors[entry.slot % linkColors.length] }));
    this.linkFlowing = motion && lanes.some(lane => lane.link.working && !lane.gone);
    this.scheduleLinkFlow?.();
    // A workspace inside a project link, with the other computers in it. `gone` while
    // the link fades: the border is back to normal and the ⇄ mark fades with the pipe.
    const spaceLink = space => {
      const name = projectName(space, machine => machine === null ? null : this.computerLabel(machine)).normalize('NFC').toLowerCase();
      const machine = space.machine ?? null;
      const found = item => item.link.name && item.link.name.normalize('NFC').toLowerCase() === name && item.link.machines.includes(machine);
      const lane = lanes.find(item => !item.gone && found(item)) ?? lanes.find(found);
      return lane ? { lane, gone: Boolean(lane.gone), partners: lane.link.machines.filter(other => other !== machine) } : null;
    };
    const laneOf = (from, to) => lanes.find(lane => !lane.gone && lane.link.machines.includes(from) && lane.link.machines.includes(to));
    // Link lanes sit in a fixed right margin of the computer list (LINK_MARGIN), drawn
    // over it: rows keep their width whether or not a link shows. Offsets are from the right.
    const laneRight = slot => Math.max(8,LINK_MARGIN-28-slot*4);
    const coveredComputerPair=(a,b)=>{
      const first=taskComputerRecord(taskPanel?.feed,a),second=taskComputerRecord(taskPanel?.feed,b);
      return Boolean(first&&second&&taskPanel.feed.spaces.some(space=>space.share&&
        (space.computer===first.id&&space.share.computer===second.id||space.computer===second.id&&space.share.computer===first.id)));
    };
    const sendNote = this.lang()==='ko' ? '전송 이벤트 · 읽음 확인 아님' : 'Send event, not a read receipt';
    const computerItems = (typeof herdrNative.machines === 'function' ? herdrNative.machines() : [{name:null,layout:'ready'}]).map(machine => {
      const name = machine.name;
      const agentCount = machineAgents.get(name) ?? { blocked: 0, done: 0, working: 0, idle: 0 };
      const sharedProjects = collabs.filter(project => project.machines.includes(name));
      const displayName = this.computerLabel(name);
      const machineSpaces = spaces().filter(space => (space.machine ?? null) === name);
      const selected = selectedComputer === (name === null ? 'local' : `remote:${name}`);
      const ready = machine.layout === 'ready';
      const state = computerStatus(machine, this.lang(), window()?.platform);
      const config = name === null ? this.computers?.local : this.computers?.machines?.[name];
      const kind = name === null ? 'laptop' : computerKind(config?.os);
      const key = name === null ? 'local' : `remote:${name}`;
      const partnerLit = hoverPartners.has(name);
      let row = h_flex().id(`sf-computer-${key}`).relative().h(COMPUTER_ROW).flex_none().px(7).gap(6).items_center().rounded(4)
        .bg(partnerLit ? hoverColor + '1A' : selected ? t.selected : t.surface).hover(style => style.bg(t.hover))
        .on_hover((hovered, cx) => { const next = hovered ? name : (this.hoverComputer === name ? undefined : this.hoverComputer); if (next !== this.hoverComputer) { this.hoverComputer = next; cx.notify(); } })
        .tooltip(`${displayName}${name === null ? '' : ` · ${name}`}\n${state}${name === null ? '' : (this.lang()==='ko'?' · Herdr 원격 등록됨':' · Registered in Herdr')}\n${['working','done','blocked','idle'].map(status => `${w[status]} ${agentCount[status]}`).join(' · ')}${sharedProjects.length ? `\n${sharedProjects.map(collabText).join('\n')}\n${collabNote}` : ''}`)
        .on_mouse_down('left', (_event, cx) => cx.stop_propagation())
        .on_click(() => this.selectComputer(key))
        .child(svg(`mods/sixfold-desk/icons/device-${kind}.svg`).size(14).flex_none().text_color(name===null||ready||machine.layout==='loading'?t.accent:t.dim).when(machine.layout==='loading',icon=>icon.opacity(0.5)))
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().text_size(11).font_bold().child(displayName))
          .child(h_flex().min_w(0).gap(6).items_center()
            .children(['working','done','blocked'].filter(status => agentCount[status] > 0).map(status => this.badge(status, String(agentCount[status]), t, 9)))
            // The icon's colour says connected; words only for an exception. The tooltip keeps the detail.
            .child(div().flex_1().min_w(0).truncate().text_size(9).text_color(machine.layout === 'loading' ? t.muted : t.blocked).child(computerAlert(machine, this.lang()) ?? ''))))
        .child(div().flex_none().text_size(9).text_color(t.dim).child(String(machineSpaces.length)))
        // Drawn over the row (absolute), so the 2px outline moves nothing.
        .when(partnerLit, el => el.child(div().absolute().top(0).left(0).right(0).bottom(0).rounded(4).border(2).border_color(hoverColor)));
      const hop = remoteRoutes.find(item => item.hop.from === name || item.hop.to === name);
      const confirmed=taskComputerRecord(taskPanel?.feed,name)?.traffic;
      const deliveries=confirmed?.unit==='deliveries';
      const sent = deliveries?confirmed.up??0:traffic.get(name)?.sent ?? 0, received = deliveries?confirmed.down??0:traffic.get(name)?.received ?? 0;
      if(deliveries&&(confirmed.up!==null||confirmed.down!==null))row=row.child(v_flex().flex_none().text_size(9).text_color(t.muted)
        .tooltip('Confirmed deliveries (counts, not bytes or a network rate)')
        .child(`↑${confirmed.up??'—'}`).child(`↓${confirmed.down??'—'}`));
      if (!deliveries&&(hop || sent || received)) {
        // No outline or blink: only the counter takes the link's packet tone while a send moves.
        const color = hop ? (laneOf(hop.hop.from, hop.hop.to)?.colors.packet ?? t.muted) : t.muted;
        const incoming = hop?.hop.to === name;
        row = row.child(h_flex().flex_none().gap(3).text_size(9).text_color(color)
          .tooltip(`${hop ? (this.lang()==='ko' ? (incoming ? '지금 다른 컴퓨터에서 받는 중' : '지금 다른 컴퓨터로 보내는 중') : (incoming ? 'Receiving from another computer now' : 'Sending to another computer now')) + '\n' : ''}${this.lang()==='ko' ? `최근 10분 다른 컴퓨터와: 보냄 ${sent} · 받음 ${received}` : `Last 10 min with other computers: sent ${sent} · received ${received}`}\n${sendNote}`)
          .when(sent > 0 || (hop && !incoming), el => el.child(`↑${sent || ''}`))
          .when(received > 0 || incoming, el => el.child(`↓${received || ''}`)));
      }
      return {row, name, active:computerActive(machine)};
    });
    if(this.computers?.tailscale){
      for(const peer of this.tailscalePeers??[]){
        const state=tailscaleStatus(peer,this.lang());
        const row = h_flex().id(`sf-tailscale-${peer.name}`).h(COMPUTER_ROW).flex_none().px(7).gap(6).items_center().rounded(4)
          .bg(selectedComputer===`tailscale:${peer.name}`?t.selected:t.surface).hover(style=>style.bg(t.hover))
          .on_mouse_down('left',(_event,cx)=>cx.stop_propagation())
          .on_click(()=>this.selectComputer(`tailscale:${peer.name}`))
          .tooltip(`${peer.host} · ${(peer.ips??[]).join(', ')} · ${peer.os}\n${state}\n${this.lang()==='ko'?'목록 표시 전용 · Herdr 원격 미등록 · SSH 연결 확인 안 됨':'Discovery only · not registered in Herdr · SSH not verified'}`)
          .child(svg(`mods/sixfold-desk/icons/device-${computerKind(peer.os, peer.name || peer.host)}.svg`).size(14).flex_none().text_color(peer.online===true?t.foreground:t.dim))
          .child(v_flex().flex_1().min_w(0)
            .child(div().truncate().text_size(11).font_bold().child(peer.name))
            .child(div().truncate().text_size(9).text_color(t.muted).child(state)));
        // Online Tailscale peers stay listed while collapsed; offline ones fold away.
        computerItems.push({row,active:peer.online===true});
      }
    }
    const activeComputers=computerItems.filter(item=>item.active);
    // Visible computer rows are COMPUTER_ROW tall with 3 px gaps: the centre of row i.
    const rowY = index => index * (COMPUTER_ROW + 3) + COMPUTER_ROW / 2;
    const rowIndex = machine => activeComputers.findIndex(item => item.name === machine);
    const otherComputers=computerItems.filter(item=>!item.active);
    const computersExpanded=shared('sixfold.computing.expanded')===true;
    const computerRows=activeComputers.map(item=>item.row);
    if(computersExpanded && otherComputers.length)computerRows.push(v_flex().id('sf-computers-other').max_h(180).flex_none().overflow_y_scroll().gap(3).children(otherComputers.map(item=>item.row)));
    if(computersExpanded && this.computers?.tailscale && this.tailscaleError)computerRows.push(div().id('sf-computers-error').px(7).text_size(10).text_color(t.blocked)
      .child(this.lang()==='ko'?'Tailscale 상태 확인 불가':'Tailscale status unavailable'));
    // Keep hidden devices out of the list entirely until explicitly expanded.
    // The title's small disclosure is the only collapsed entry point.
    const computerSection=h_flex().px(12).pt(13).pb(6).gap(3).items_center()
      .child(div().text_size(10).font_bold().text_color(t.dim).child(this.lang()==='ko'?'컴퓨팅':'COMPUTERS'))
      .when(otherComputers.length>0 || Boolean(this.computers?.tailscale && this.tailscaleError),e=>e.child(div().id('sf-computers-toggle').w(20).h(18).text_size(11).text_color(t.muted)
        .hover(style=>style.text_color(t.foreground))
        .tooltip(this.lang()==='ko'?'미연결·미등록 컴퓨터 펼치기/접기':'Show/hide disconnected or unregistered computers')
        .on_mouse_down('left',(_event,cx)=>cx.stop_propagation())
        .on_click(()=>setShared('sixfold.computing.expanded',!computersExpanded))
        .child(computersExpanded?'▾':'▸')));
    // A workspace's rows are its terminals; a mod pane (document tabs, a usage panel) has no
    // terminal and is not a session, so it gets no row and no count.
    this.classicMembers??=new Map();
    const groups=orderSpaceCards(workspaceList.map(s=>{
      const raw=s.tabs.flatMap(tab=>all.filter(p=>p.tab===tab.id&&p.terminal)),key=JSON.stringify(raw);
      let cached=this.classicMembers.get(s.id);
      if(cached?.key!==key){cached={key,members:priority(raw)};this.classicMembers.set(s.id,cached);}
      return {s,members:cached.members};
    }),s=>workspacePinned(s,this.workspacePins),s=>taskPanel?.taskFor(s));
    for(const id of this.classicMembers.keys())if(!workspaceIds.has(id))this.classicMembers.delete(id);
    // A task card's meta line (Slack · Linear) also carries badges with a state; a card without
    // one keeps them on a badge row. Launcher-only badges ('기억') sit in the header: no row.
    const metaLine=s=>{const task=taskPanel?.taskFor(s);return Boolean(task&&taskPanel?.bodyFor(s)&&(task.slack||task.work));};
    const badgeRow=s=>!metaLine(s)&&lineBadges(spaceBadges(this,s));
    const extraHeight=s=>badgeRow(s)?20:0;
    // A task card with a meta line carries Slack and Linear alerts there; the separate alerts row is for other cards.
    const mergedAlerts=s=>Boolean(taskPanel?.bodyFor(s)&&alertsOnMetaLine(taskPanel.taskFor(s),s.name));
    const alertRowHeight=s=>hasWorkspaceAlerts(s.name)&&!mergedAlerts(s)?26:0;
    const positions={};let offset=0;
    for(const {s,members} of groups){
      const task=taskPanel?.taskFor(s),card=taskPanel?.layout?.cards.find(card=>card.space.id===task?.id);
      if(card){
        for(const p of members){
          const agent=task.agents.find(agent=>agent.nav?.pane_id===String(p.pane).split('/').pop()&&agent.nav.machine===(s.machine??null));
          const row=card.rows.find(row=>row.kind==='agent'&&row.agent.id===agent?.id);
          if(row)positions[p.terminal]=offset+row.y-card.top+6+extraHeight(s)+alertRowHeight(s)+row.height/2;
        }
        offset+=(this.boxSizes?.[s.id]?.h||card.height+9+extraHeight(s)+alertRowHeight(s))+12;
        continue;
      }
      let row=offset+51+extraHeight(s)+alertRowHeight(s);
      for (const p of members) {
        positions[p.terminal]=row;row+=30;
        {
          for(const node of sessionChildren(this.workflowNodes,p.terminal,this.expandedAgents.has(p.terminal))) {
            positions[node.id]=row;row+=44;
          }
        }
      }
      offset=row-3;
    }
    const workspaceColor = s => { const saved=shared('space.colors')?.[s.id]; if(saved)return saved.startsWith('#')?saved:(t[saved]||t.accent); const local=workspaceLocal(s,this.site)?.color; return workspaceIdentity(s,this.site)==='hub' ? t.accent : local ? (local.startsWith('#')?local:(t[local]||t.accent))
      : [t.accent,t.ansi5,t.ansi6,t.ansi3,t.ansi2,t.ansi4][[...s.id].reduce((hash,c)=>(hash*31+c.charCodeAt(0))>>>0,0)%6]; };
    const workspaceMark = s => {
      const configured=this.workspaceIcons[s.id] || this.workspaceIcons[s.name];
      const icon=typeof configured==='string'?{path:configured}:configured;
      const box=h_flex().size(16).flex_none().rounded(4).items_center().justify_center();
      if(icon?.path)return box.bg(icon.background||t.surface).child(
        icon.path.toLowerCase().endsWith('.svg') && icon.tint
          ? svg(icon.path).size(14).text_color(workspaceColor(s)) : image(icon.path).w(14).h(14));
      return box.bg(workspaceColor(s)).child(svg(`mods/sixfold-desk/icons/ws-${workspaceIdentity(s,this.site)||'workspace'}.svg`).size(12).flex_none().text_color(t.background));
    };
    // The header's docs button: the space's document finder (search, sort, filters) in a popover.
    const docsButton=s=>{
      const count=docsGroup(this,s)?.files?.length;
      const trigger=h_flex().id(`sf-docs-open-${s.id}`).h(18).flex_none().px(3).gap(2).items_center().rounded(4).cursor_pointer()
        .text_color(t.dim).hover(e=>e.bg(t.hover).text_color(t.foreground))
        .tooltip(`문서 찾기${Number.isInteger(count)?` · ${count}건`:''}`)
        .child(svg('mods/sixfold-desk/icons/doc.svg').size(12).flex_none())
        .when(Number.isInteger(count)&&count>0,e=>e.child(div().text_size(9).font_normal().child(String(count))));
      // The header's own press starts a drag; a press on the button belongs to the finder.
      return div().flex_none().on_mouse_down('left',(_e,cx)=>cx.stop_propagation()).on_mouse_up('left',(_e,cx)=>cx.stop_propagation())
        .child(docsFinder(this,s,trigger,t,{leadingGap:LINK_MARGIN+14,notify:cx=>this.invalidateSidebar?this.invalidateSidebar():cx?.notify?.()}));
    };
    this.classicCards?.begin();
    const spaceRows=groups.map(({s,members})=>{
      const task=taskPanel?.taskFor(s),taskBody=taskPanel?.bodyFor(s);
      const partner=partnersOf(s),mark=spaceLink(s);
      const badgeKey=`${s.machine??''}|${String(s.id).split('/').pop()}`;
      const key=JSON.stringify([s,members,task?.id,Boolean(taskBody),Boolean(task?.slack||task?.work),task?.memory,task?.share,task?.agents.map(agent=>[agent.id,agent.status,agent.closing]),taskPanel?.names&&[...taskPanel.names],taskPanel?.feed?.links,t,w,motion,partner,mark,comets.comets.get(groupKey(partner?.group.name??mark?.lane.link.name)),
        this.boxSizes?.[s.id],partner?.partners.includes(this.hoverComputer)||false,this.dragSpace,this.overSpace,
        this.workspaceIcons[s.id]||this.workspaceIcons[s.name],workspaceColor(s),workspacePinned(s,this.workspacePins),
        this.fileBadges?.[badgeKey],alertCardSignature(s.name,motion),shared('sixfold.workspace.badges')?.[badgeKey],this.projectDocs?.spaces?.[s.id]||this.projectDocs?.spaces?.[s.name],
        docsFinderSignature(this,s.id),
        members.map(p=>[unseen(p.terminal),endpoint(p.terminal),routeColor(p.terminal),askFor(this.asks,p.terminal),
          sessionChildren(this.workflowNodes,p.terminal,true),this.expandedAgents.has(p.terminal),list.find(a=>a.address===p.terminal)?.program])]);
      const build=()=>{ const mark=spaceLink(s);
      // A partner on another computer always shows in the header (icon + its name, in the
      // collaboration colour). While worked on together now the box gets a 2px outline and
      // a 10% tint, and a filled ⇄ badge sits on its top edge; all drawn over the box, so
      // nothing moves. Hovering the partner's computer row lights the box the same way.
      const partner=partnersOf(s);
      const partnerNames=partner ? partner.partners.map(m => this.computerLabel(m)) : [];
      const partnerText=partner ? `${partnerNames.map((label, i) => `${label} · ${partner.group.name}${partner.working[i] ? ` · ${w.working} ${partner.working[i]}` : ''}`).join('\n')}\n${collabNote}` : '';
      // Worked on together now comes from the project itself (spacePartners), not from the
      // pipe lanes, which hold at most four links; a lane only lets an ended badge fade out.
      const sharing=partner?.active ? partner.activePartners : null;
      const collab=groupColor(partner?.group.name ?? mark?.lane.link.name);
      const size=this.boxSizes?.[s.id];
      const groupName=partner?.group.name ?? mark?.lane.link.name;
      const comet=sharing ? comets.comets.get(groupKey(groupName)) : null;
      const flowView=comet&&size ? borderComet({id:s.id,start:comet.start,w:size.w,h:size.h,color:collab,step:comet.step,motion}) : null;
      const badgePartners=sharing ?? (mark?.gone ? mark.partners : null);
      const lit=Boolean(sharing) || (this.hoverComputer !== undefined && Boolean(partner?.partners.includes(this.hoverComputer)));
      const markView = badgePartners ? h_flex().id(`sf-space-mark-${s.id}`).absolute().top(-8).right(10).h(15).px(5).items_center().rounded(4).bg(collab)
        .text_size(10).font_bold().text_color(onCollab(collab)).opacity(sharing ? 1 : 0).when(motion,el=>el.transition('opacity',600))
        .tooltip(`${badgePartners.map(m => this.computerLabel(m)).join(', ')}${this.lang()==='ko' ? '과 협업 중' : ': worked on together now'}\n${collabNote}`)
        .child(`⇄${badgePartners.length > 1 ? badgePartners.length : ''}`) : null;
      const outline = sharing ? breathingBorder({id:s.id,color:collab,period:breathPeriod(groupIndex(groupName)),motion,dim:Boolean(comet&&size&&comet.step>0)})
        : lit ? div().absolute().top(-1).left(-1).right(-1).bottom(-1).rounded(7).border(2).border_color(collab) : null;
      // The name is text on the header, so its colour is chosen for that header's background.
      const tailColor = collabColor(t, s.active ? t.selected : t.surface);
      // The Share (hub) space is the shared room itself, so its header carries no computer tag.
      const partnerTail = partner && workspaceIdentity(s,this.site)!=='hub' ? h_flex().id(`sf-partner-${s.id}`).flex_none().max_w(110).min_w(0).gap(3).items_center().text_size(12).font_normal().text_color(tailColor)
        .tooltip(partnerText)
        .child(svg(`mods/sixfold-desk/icons/device-${computerKind(this.computers?.machines?.[partner.partners[0]]?.os)}.svg`).size(14).flex_none().text_color(tailColor))
        .child(div().min_w(0).truncate().child(`${partnerNames[0]}${partnerNames.length > 1 ? ` +${partnerNames.length - 1}` : ''}`)) : null;
      const metrics=task?panelHeaderMetrics(task,taskPanel.panelWidth):null;
      const feedPartner=task?.share?taskPanel.feed.computers.find(computer=>computer.id===task.share.computer):null;
      const feedTone=feedPartner?taskPanel.color(`computer:${feedPartner.id}`):null;
      const localPartners=task?panelSpacePartners(taskPanel.feed,task.id):[];
      const localPartner=localPartners[0];
      const chip=(id,label,tone,icon)=>h_flex().id(id).h(18).max_w(94).min_w(0).flex_none().px(5).gap(3).items_center().rounded(9)
        .bg(tone+'1F').border(1).border_color(tone+'5C').text_color(tone).text_size(10).font_normal().tooltip(label)
        .child(svg(`mods/sixfold-desk/icons/${icon}.svg`).size(11).flex_none())
        .child(div().min_w(0).truncate().child(label));
      return v_flex().id(`sf-space-${s.id}`).relative().ml(7).mr(LINK_MARGIN).mb(12).gap(2).flex_none().rounded(6).border(1).border_color(feedTone|| (workspacePinned(s,this.workspacePins)?t.accent:t.border))
      .when(lit,e=>e.bg(collab+'1A')).when(Boolean(feedTone),e=>e.bg(feedTone+'1A'))
      // ⑩ The box's size, for the flow drawn along its border.
      .on_size_change((size,cx)=>{const zoom=settings().zoom||1,w=size.width/zoom,h=size.height/zoom,prev=this.boxSizes?.[s.id];if(!prev||Math.abs(prev.w-w)>0.5||Math.abs(prev.h-h)>0.5){this.boxSizes={...this.boxSizes,[s.id]:{w,h}};this.invalidateSidebar?this.invalidateSidebar():cx.notify();}})
      .on_hover((hovered,cx)=>{const next=hovered?s.id:(this.hoverSpace===s.id?null:this.hoverSpace);if(next!==this.hoverSpace){this.hoverSpace=next;this.invalidateSidebar?this.invalidateSidebar():cx.notify();}})
      .when(this.dragSpace && this.overSpace===s.id && this.dragSpace!==s.id,e=>e.border_t(2).border_color(t.accent))
      .on_mouse_move((_event,cx)=>{
        const source=spaces().find(x=>x.id===this.dragSpace);
        if(source && (source.machine??null)===(s.machine??null) && this.overSpace!==s.id){this.overSpace=s.id;this.invalidateSidebar?this.invalidateSidebar():cx.notify();}
      })
      .on_mouse_up('left',(_event,cx)=>{
        const source=spaces().find(x=>x.id===this.dragSpace);
        if(!source)return;
        this.dragSpace=null;this.overSpace=null;
        if(source.id!==s.id && (source.machine??null)===(s.machine??null)){
          this.suppressClickUntil=Date.now()+250;
          run('space.move',{id:source.id,index:spaces().findIndex(x=>x.id===s.id)+1});
        } else if(source.id===s.id)run('space.select',{id:s.id});
        cx.stop_propagation();this.invalidateSidebar?this.invalidateSidebar():cx.notify();
      })
      .child(h_flex().h(36).flex_none().pl(6).pr(8).items_center().gap(4).rounded(5).border_l(3).border_color(workspaceColor(s)).bg(s.active?t.selected:t.surface).text_size(12).font_bold()
        .when(this.dragSpace===s.id && this.overSpace!==s.id,e=>e.opacity(0.5))
        .when(this.dragSpace && this.overSpace===s.id && this.dragSpace!==s.id,e=>e.border(1).border_color(t.accent))
        .tooltip(`${sharing ? `${sharing.map(m => this.computerLabel(m)).join(', ')}${this.lang()==='ko' ? '과 협업 중' : ': worked on together now'} · ${collabNote}\n` : partner ? `${partnerText}\n` : ''}${this.lang()==='ko'?'드래그하여 순서 변경':'Drag to reorder'}`)
        .on_mouse_down('left',(_event,cx)=>{
          // The sidebar is a window_drag region; this press belongs to the space.
          cx.stop_propagation();
          this.dragSpace=s.id;this.overSpace=s.id;
          this.invalidateSidebar?this.invalidateSidebar():cx.notify();
        })
        .child(workspaceMark(s))
        .when(workspacePinned(s,this.workspacePins),e=>e.child(div().id(`sf-pinned-${s.id}`).w(14).flex_none()
          .tooltip(this.lang()==='ko'?'고정 워크스페이스 · workspace-pins.local.json':'Pinned workspace · workspace-pins.local.json')
          .child(svg('mods/sixfold-desk/icons/pin.svg').size(12).text_color(t.accent))))
        .child(div().flex_1().min_w(0).truncate().text_color(s.active?t.foreground:t.muted).tooltip(s.name).child(s.name))
        .when(Boolean(feedPartner),e=>e.child(chip(`sf-task-partner-${s.id}`,feedPartner.name,feedTone,'device-computer')))
        .when(!feedPartner&&Boolean(partnerTail),e=>e.child(partnerTail))
        .when(Boolean(localPartner),e=>e.child(chip(`sf-local-partner-${s.id}`,localPartner.name+(localPartners.length>1?` +${localPartners.length-1}`:''),paletteMode(t)==='light'?'#56307D':'#c3a6ff','link')))
        .when(Boolean(metrics?.hasMemory),e=>e.child(div().id(`sf-task-memory-${s.id}`).w(metrics.memoryWidth).flex_none().h(16).rounded(3).bg(t.selected)
          .text_size(9).text_color(t.ansi6||t.accent).truncate().tooltip(`기억 제안${task.memory.proposals?` ${task.memory.proposals}`:''}`)
          .child(metrics.compact?`◈${task.memory.proposals?` ${task.memory.proposals}`:''}`:`기억 제안${task.memory.proposals?` ${task.memory.proposals}`:''}`)))
        .when(Boolean(metrics?.count),e=>e.child(div().w(metrics.countWidth).flex_none().text_size(10).text_color(t.muted).child(`◌ ${metrics.count}`)))
        .when(!lineBadges(spaceBadges(this,s)),e=>e.child(workspaceBadges(this,s,t)))
        .when(!metrics,e=>e.child(div().text_size(10).text_color(t.muted).child(String(members.length))))
        .child(docsButton(s)))
      .when(extraHeight(s)>0,e=>e.child(h_flex().id(`sf-space-extras-${s.id}`).h(18).flex_none().px(7).gap(4).items_center().min_w(0)
        .child(workspaceBadges(this,s,t))
      ))
      .when(alertRowHeight(s)>0,e=>e.child(workspaceAlertsRow(s,t,{motion})))
      .children(taskBody?[taskBody]:members.map(p=>{
        const tab=s.tabs.find(tab=>tab.id===p.tab);
        const records=sessionChildren(this.workflowNodes,p.terminal,true);
        const children=sessionChildren(this.workflowNodes,p.terminal,this.expandedAgents.has(p.terminal));
        const activeCount=records.filter(activeWorkflow).length;
        return v_flex().gap(2).flex_none().child(h_flex().id(`sf-member-${p.pane}`).h(28).flex_none().px(7).gap(6).items_center().rounded(4).bg(p.focused?t.selected:t.chrome)
          .when(endpoint(p.terminal),e=>e.border(1).border_color(routeColor(p.terminal)))
          .tooltip(`${s.name} / ${tab.name} / ${title(p)}`)
          .hover(h=>h.bg(t.hover)).on_click(()=>{
            if((this.suppressClickUntil??0)>Date.now() || (this.dragSpace && this.overSpace!==this.dragSpace))return;
            run('tab.select',{id:tab.id});run('pane.focus',{pane:p.pane});
          })
          .child(icon(p,list.find(a=>a.address===p.terminal)?.program ?? p.program))
          .child(div().flex_1().min_w(0).truncate().text_size(11).child(title(p)))
          .when(unseen(p.terminal)>0,e=>e.child(div().px(4).rounded(3).bg(t.accent).text_color(t.background).text_size(10).tooltip(this.lang()==='ko'?`읽지 않은 메시지 ${unseen(p.terminal)}개`:`${unseen(p.terminal)} unread messages`).child(String(unseen(p.terminal)))))
          .when(records.length>0,el=>el.child(div().id(`sf-children-${p.terminal}`).px(3).rounded(3).text_size(10).text_color(t.accent)
            .tooltip(this.lang()==='ko'?'완료·상태 미확인 기록 펼치기/접기':'Show/hide completed and unknown records')
            .on_mouse_down('left',(_event,cx)=>cx.stop_propagation())
            .on_mouse_up('left',(_event,cx)=>cx.stop_propagation())
            .on_click((_event,cx)=>{cx.stop_propagation();
              if(this.expandedAgents.has(p.terminal))this.expandedAgents.delete(p.terminal);else this.expandedAgents.add(p.terminal);
              this.invalidateSidebar?this.invalidateSidebar():cx.notify();
            }).child(`${this.expandedAgents.has(p.terminal)?'▾':'▸'} ${activeCount} · 기록 ${records.length-activeCount}`)))
          .when(Boolean(askFor(this.asks,p.terminal)),e=>e.child(div().id(`sf-ask-chip-${p.terminal}`).px(4).rounded(3).bg(t.blocked).text_color(t.background).text_size(10)
            .tooltip(askFor(this.asks,p.terminal)?.title||'').child('?')))
          .child(this.badge(p.status,'',t)))
          .when(children.length>0,el=>el.children(children.map(node=>h_flex().id(`sf-node-${node.id}`).h(42).flex_none().pl(12+Math.min(node.depth,4)*5).pr(5).gap(4).items_center().rounded(3)
            .when(endpoint(node.id),el=>el.border(1).border_color(routeColor(node.id)))
            .tooltip(`${s.name} / ${title(p)} · ${node.label||node.id} · ${node.task||''} · ${workflowStatus(node,this.lang())} · ${node.statusSource||'상태 출처 미확인'}`)
            .on_click(()=>run('agent.focus',{terminal:p.terminal}))
            .child(div().text_size(10).text_color(t.dim).child('↳'))
            .child(v_flex().flex_1().min_w(0).gap(2)
              .child(div().truncate().text_size(10).text_color(t.muted).child(node.task||node.label||''))
              .child(div().truncate().text_size(9).text_color(t.dim).child(`${s.name} / ${title(p)} · ${node.label||''}`)))
            .child(div().text_size(9).text_color(t.dim).child(workflowStatus(node,this.lang()))))));

      })).when(Boolean(outline),e=>e.child(outline))
      // ⑩ While worked on together now (and motion is on), a flow runs around the border.
      .when(Boolean(flowView),e=>e.child(flowView)).when(Boolean(markView),e=>e.child(markView));};
      return this.classicCards?this.classicCards.card(s.id,key,build):build();
    });
    this.classicCards?.end();
    const taskEntries=groups.map(({s,members})=>{
      const task=taskPanel?.taskFor(s),card=taskPanel?.layout?.cards.find(card=>card.space.id===task?.id);
      return {task,alertHeight:extraHeight(s)+alertRowHeight(s),height:this.boxSizes?.[s.id]?.h||
        (card?card.height+9:(members.length*30+40))+extraHeight(s)+alertRowHeight(s)};
    });
    // New-alert arrivals: a popup on the card's spot, then a pixel block steps into its badge.
    const arrivalCards=[];{let top=0;groups.forEach(({s},i)=>{arrivalCards.push({s,top,extra:extraHeight(s),merged:mergedAlerts(s),width:this.boxSizes?.[s.id]?.w||0});top+=taskEntries[i].height+12;});}
    const arrivalViews=alertArrivalLayer(this,cx,{cards:arrivalCards,motion,t,right:LINK_MARGIN+4});
    const workspaceTree=v_flex().relative().flex_none().children(spaceRows)
      .when(Boolean(taskPanel?.feed),e=>e.child(taskPanel.hostFlows(taskEntries,
        taskComputerAnchors(taskPanel.feed,activeComputers,this.computerBlockHeight??(activeComputers.length*39+3),this.spaceSectionHeight??31),LINK_MARGIN)))
      .children(paths.filter(flow => positions[flow.source] !== undefined && positions[flow.target] !== undefined).map(flow => {
        const from=positions[flow.source], to=positions[flow.target];
        return pipeline({id:flow.id,width:8+(flow.lane%2)*6,inset:6,from,to,color:workspaceFlowColor(flow),phase:flow.phase,packets:flow.packets,motion,unit:1/(Number(settings()?.zoom)||1)})
          .right(LINK_MARGIN-18-(flow.lane%2)*6);
      }))
      // The far end is on another computer: run the pipe up to the top of this list,
      // just under the computer rows (the far computer's row is marked there).
      .children(remoteRoutes.filter(({route}) => (positions[route.source] === undefined) !== (positions[route.target] === undefined)).map(({route}) => {
        const outgoing = positions[route.source] !== undefined;
        const row = outgoing ? positions[route.source] : positions[route.target];
        return pipeline({id:`${route.id}-hop`,width:8+(route.lane%2)*6,inset:6,from:outgoing?row:0,to:outgoing?0:row,color:workspaceFlowColor(route),phase:route.phase,packets:route.packets,motion,unit:1/(Number(settings()?.zoom)||1)})
          .right(LINK_MARGIN-18-(route.lane%2)*6);
      }))
      .children(arrivalViews);
    return v_flex().id('sixfold-sidebar').size_full().bg(t.chrome).text_color(t.foreground)
      // Width only matters to the task panel's breakpoints; between them the
      // flex layout resizes the cards without a redraw.
      .on_size_change((size,cx)=>{if(this.panelRetained?.resize(size.width/(settings().zoom||1))){this.invalidateSidebar?this.invalidateSidebar():cx.notify();}})
      .on_mouse_up('left',(_e,cx)=>{
        if(this.dragSpace){this.dragSpace=null;this.overSpace=null;cx.notify();}
      })
      .child(v_flex().h(58).flex_none()
        .child(h_flex().h(30).flex_none().pl(window()?.platform==='macos'?76:12).pr(8).items_center().gap(4)
          .child(div().flex_1().min_w(0).truncate().font_bold().text_size(14).child('Herdr Theme'))
          .child(this.button('sf-language',w.language,()=>run('sixfold-desk.language'),t)))
        .child(h_flex().h(24).flex_none().px(8).items_center().gap(4)
          .when(Boolean(this.panelState?.feed),e=>e.child(this.button('sf-tracking',taskPanel?'작업 켜짐':'작업',()=>setShared('sixfold.panel.enabled',!this.panelTrackingActive),t)))
          .child(this.button('sf-motion',motion?'Motion on':'Motion off',()=>setShared('sixfold.motion',shared('sixfold.motion')===false),t))))
      .child(h_flex().px(12).py(11).gap(16).flex_none().justify_center().font_bold().children(['blocked','done','working'].map(s => this.badge(s,String(total[s]),t,14))))
      .child(v_flex().id('sf-scroll').flex_1().min_h(0).overflow_y_scroll()
        .child(computerSection)
        .child(v_flex().relative().flex_none().pl(7).pr(LINK_MARGIN).pb(6).gap(3).children(computerRows)
          .on_size_change((size,cx)=>{const h=size.height/(settings().zoom||1);if(Math.abs((this.computerBlockHeight??0)-h)>0.5){this.computerBlockHeight=h;this.invalidateSidebar?this.invalidateSidebar():cx.notify();}})
          // Computers joined now: right-angle 1px dashed pipes in the right margin, one lane
          // each, ending on the rows. A slow dim dot runs while they work together; a send
          // passes from its sender's row to its receiver's as a brighter packet.
          .children(lanes.filter(lane=>!lane.link.machines.every((a,i,all)=>all.slice(i+1).every(b=>coveredComputerPair(a,b)))).flatMap(lane => {
            const rows = lane.link.machines.map(rowIndex).filter(index => index >= 0).sort((a, b) => a - b);
            if (rows.length < 2) return [];
            const right = laneRight(lane.slot), top = rowY(rows[0]), bottom = rowY(rows[rows.length - 1]);
            // A project's pipe and packet take its border colour, so both ends match.
            const color = lane.link.name ? groupColor(lane.link.name) : lane.colors.link;
            const group = linkGroups.find(item => item.name === lane.link.name);
            const tip = group
              ? `${collabText(group)}\n${collabNote}`
              : `${lane.link.machines.map(m => this.computerLabel(m)).join(' ↔ ')}\n${this.lang()==='ko' ? '최근 5분 안 송수신' : 'Sent within the last 5 minutes'} · ${sendNote}`;
            const fade = el => el.opacity(lane.gone ? 0 : 1).when(motion, e => e.transition('opacity', 600));
            const parts = [fade(div().id(`sf-link-${lane.link.key}`).absolute().right(right).top(top).w(2).h(bottom - top).border_r(1).border_dashed().border_color(color).tooltip(tip))];
            for (const row of rows) parts.push(fade(div().id(`sf-link-${lane.link.key}-${row}`).absolute().right(right).top(rowY(row)).w(LINK_MARGIN - right).h(2).border_t(1).border_dashed().border_color(color)));
            // A pulse as wide as the 1px pipe, kept between its two ends, so it never sticks out.
            if (lane.link.working && motion && !lane.gone && bottom - top > LINK_PULSE) parts.push(div().id(`sf-link-flow-${lane.link.key}`).absolute().right(right).w(1).h(LINK_PULSE).bg(color)
              .top(this.linkFlowEnd ? bottom - LINK_PULSE + 1 : top).transition('top', { duration: LINK_FLOW_MS - 200, easing: 'linear' }));
            return parts;
          }))
          // One packet per send: a route merges same-way sends, each still moves on its own.
          .children(remoteRoutes.flatMap(({ route, hop }) => {
            if(coveredComputerPair(hop.from,hop.to))return [];
            const lane = laneOf(hop.from, hop.to), from = rowIndex(hop.from), to = rowIndex(hop.to);
            if (!lane || from < 0 || to < 0) return [];
            return (route.packets?.length ? route.packets : [{ id: route.id, phase: route.phase }]).map(packet => {
              const y = packet.phase === 'start' && motion ? rowY(from) : rowY(to);
              const other = y === rowY(from) ? rowY(to) : rowY(from);
              // On the pipe itself: as wide as the line, and inside it at the lower end.
              return div().id(`sf-link-send-${packet.id}`).absolute().right(laneRight(lane.slot)).top(y > other ? y - SEND_PULSE + 1 : y).w(1).h(SEND_PULSE).bg(lane.link.name ? groupColor(lane.link.name) : lane.colors.packet)
                .opacity(packet.phase === 'arrived' ? 0.4 : 1)
                .when(motion, el => el.transition('top', { duration: packet.travelMs ?? 1600, easing: 'linear' }));
            });
          })))
        .child(section(`${discoveryOnly?selectedComputer.slice(10):this.computerLabel(selectedMachine)} · ${w.spaces}`)
          .on_size_change((size,cx)=>{const h=size.height/(settings().zoom||1);if(Math.abs((this.spaceSectionHeight??0)-h)>0.5){this.spaceSectionHeight=h;this.invalidateSidebar?this.invalidateSidebar():cx.notify();}})).child(workspaceTree)
        .when(workspaceList.length===0,e=>e.child(v_flex().id('sf-empty-workspaces').px(12).pb(12).gap(5)
          .child(div().text_size(11).text_color(t.muted).child(this.lang()==='ko'?(discoveryOnly?'등록 안 됨, 워크스페이스 없음':'워크스페이스 없음'):(discoveryOnly?'Unregistered, no workspaces':'No workspaces')))
          .when(discoveryOnly,row=>row.child(div().text_size(10).text_color(t.dim).child(this.lang()==='ko'?'설정 → Machines에서 SSH 컴퓨터를 등록하세요.':'Register an SSH computer in Settings → Machines.')))))
        )
      .when(hasAsks(this), e=>e.child(askSection(this,t,this.lang(),terminal=>{const p=panes().find(x=>x.terminal===terminal);return p?title(p):(terminal||'');})))
      .when((this.sessionReports ?? []).length>0, e=>e.child(reportsSection(this,t)))
      .when(visibleAlerts(this.alerts).length>0, e=>e.child(alertSection(this,t)))
      .when(routes.length>0,e=>e.child(v_flex().id('sf-transient-flows').flex_none().px(10).py(6).gap(3).bg(t.surface).border_t(1).border_color(t.border)
        .children(routes.slice(0,2).map(flow=>h_flex().id(`sf-transfer-${flow.id}`).gap(5).items_center().text_size(10)
          .tooltip(`${label(flow.source)} → ${label(flow.target)} · ${this.lang()==='ko'?'전송 이벤트 · 읽음 확인 아님':'Send event, not a read receipt'}`)
          .child(div().flex_none().text_color(palette[flow.lane%palette.length]).font_bold().child(flow.phase==='arrived'?'✓':'→'))
          .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(`${label(flow.source)} → ${label(flow.target)}`))
          .when(Boolean(crossMachine(flow,machineOf)),row=>row.child(div().flex_none().px(4).rounded(3).border(1).border_color(palette[flow.lane%palette.length]).text_size(9).text_color(palette[flow.lane%palette.length])
            .child(`⇄ ${this.computerLabel(crossMachine(flow,machineOf).far)}`)))
          .when(flow.count>1,row=>row.child(div().text_color(palette[flow.lane%palette.length]).child(`×${flow.count}`)))))
        .when(routes.length>2,row=>row.child(div().text_size(9).text_color(t.muted).child(this.lang()==='ko'?`+${routes.length-2}개 경로 전송 중`:`+${routes.length-2} active routes`)))
        .when((this.skippedFlows||0)>0,row=>row.child(div().id('sf-transfer-skipped').text_size(9).text_color(t.muted)
          .child(this.lang()==='ko'?`밀린 전송 ${this.skippedFlows}건은 효과 없이 건너뜀`:`${this.skippedFlows} queued sends skipped`)))))
      .when(this.queuedRoutes.length>0,e=>e.child(h_flex().id('sf-delivery-status').flex_none().px(10).py(6).gap(5).items_center().border_t(1).border_color(t.border)
        .tooltip(this.queuedRoutes.map(item=>`${item.project} · ${item.error || (item.hold?'전달 보류':'수신 pane 대기')}`).join('\n'))
        .child(div().text_size(10).text_color(this.queuedRoutes.some(item=>item.hold||item.error)?t.blocked:t.muted)
          .child(this.lang()==='ko'?`전달 대기 ${this.queuedRoutes.length} · 오류/보류 ${this.queuedRoutes.filter(item=>item.hold||item.error).length}`:`Queued ${this.queuedRoutes.length} · Error/held ${this.queuedRoutes.filter(item=>item.hold||item.error).length}`))))
      .child(h_flex().h(38).flex_none().px(7).items_center()
        .child(this.button('sf-settings',w.settings,()=>run('app.settings'),t))
        .child(div().flex_1())
        .when(!discoveryOnly,e=>e.child(this.button('sf-new-space','+ Space',()=>this.newWorkspace(selectedMachine),t))));
  }
}
