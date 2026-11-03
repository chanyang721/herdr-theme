import { div } from 'gpui-kit';
import { h_flex, v_flex } from 'gpui-base';
import { run, readTextFile, writeTextFile, appHome, setShared, openOverlay } from 'herdr';

const SHOWN = new Set(['needs-you']);  // Only what a person must decide; the rest stays in the project.
const MARKS = { 'needs-you': '!', info: '✓', processing: '●' };
const WORKFLOW_RESULTS = new Set(['ready', 'needs_decision', 'blocked']);

function popupEvents(mentions, read, workflows) {
  const events = [];
  for (const item of mentions ?? []) {
    if (typeof item?.id === 'string' && item.id) {
      events.push({key: `mention:${item.id}`, popup: read[item.id] !== item.id});
    }
  }
  for (const job of Object.values(workflows ?? {})) {
    if (!job?.id || !WORKFLOW_RESULTS.has(job.state)) continue;
    const artifacts = Array.isArray(job.artifacts) ? [...job.artifacts].sort() : [];
    // finished_at is an audit timestamp, not a new source or review result.
    // Summaries are editable presentation. Prefer the stable workflow version;
    // legacy records fall back to their source identities and result artifacts.
    const sources = Array.isArray(job.sources) ? job.sources.map(source => source?.id).filter(Boolean).sort() : [];
    const revision = typeof job.version === 'string' && job.version ? ['version', job.version] : ['legacy', sources];
    const result = [job.id, revision, job.state, artifacts];
    events.push({key: `workflow:${JSON.stringify(result)}`, popup: true, review: true});
  }
  return events;
}

async function notifyNewPopupEvents(events) {
  const path = `${appHome()}/data/sixfold/slack-popup-events.json`;
  const text = await readTextFile(path).catch(() => null);
  const firstRun = text === null;
  const ledger = firstRun ? {schema: 1, seen: []} : JSON.parse(text);
  if (ledger?.schema !== 1 || !Array.isArray(ledger.seen) || !ledger.seen.every(key => typeof key === 'string')) {
    throw new Error('Invalid Slack popup event ledger');
  }
  const seen = new Set(ledger.seen);
  const fresh = events.filter(event => !seen.has(event.key));
  if (!fresh.length && !firstRun) return null;

  // Seed existing history silently on first run. Later writes use the exact
  // previous contents as a compare-and-swap guard across multiple views.
  const next = {schema: 1, seen: [...ledger.seen, ...fresh.map(event => event.key)]};
  await writeTextFile(path, JSON.stringify(next), text);
  return firstRun ? null : fresh.find(event => event.popup) ?? null;
}

// Tracked Slack, GitHub and pane requests, ordered by the watcher: needs-you first.
export function visibleAlerts(items, limit = 6) {
  return (items ?? []).filter(item => SHOWN.has(item.status)).slice(0, limit);
}

export function watchAlerts(view, cx) {
  let loading = false;
  let previous;
  const refresh = cx => {
    if (loading) return;
    loading = true;
    cx.spawn(async cx => {
      try {
        const legacy = await readTextFile(`${appHome()}/data/sixfold/alerts.json`).catch(()=>'{"items":[]}');
        const tracked = await readTextFile(`${appHome()}/data/sixfold/project-alerts.json`).catch(()=>'{"items":[]}');
        const readText = await readTextFile(`${appHome()}/data/sixfold/slack-alerts-read.json`).catch(()=>'{}');
        const mentions=await readTextFile(`${appHome()}/data/sixfold/slack-mentions.json`).catch(()=>'{"items":[]}');
        const health=await readTextFile(`${appHome()}/data/sixfold/slack-live-health.json`).catch(()=>'{}');
        const workflows=await readTextFile(`${appHome()}/data/sixfold/slack-workflows.json`).catch(()=>'{"jobs":{}}');
        const text=JSON.stringify([legacy,tracked,readText,mentions,health,workflows]);
        if (text === previous) return;
        const feed=JSON.parse(tracked || '{}');
        const items = feed.items ?? [];
        const read=JSON.parse(readText || '{}');
        const tagged=JSON.parse(mentions || '{}').items ?? [];
        const states=JSON.parse(workflows || '{}').jobs ?? {};
        const event=await notifyNewPopupEvents(popupEvents(tagged,read,states));
        setShared('sixfold.slackHealth',JSON.parse(health || '{}'));
        setShared('sixfold.slackWorkflows',states);
        if(event)openOverlay({mod:'sixfold-slack-inbox',kind:'window',key:'slack-mentions',keep:true,width:1040,height:800,props:{window:true,review:Boolean(event.review)}});
        setShared('sixfold.alertItems',items);
        setShared('sixfold.alertRead',read);
        setShared('sixfold.alertProjects',feed.projects ?? []);
        view.alerts = JSON.parse(legacy || '{}').items ?? [];
        previous = text;
        cx.notify();
      } catch { /* Missing folders and partial writes are retried on the next tick. */ }
      finally { loading = false; }
    });
  };
  refresh(cx);
  cx.timer.every(2000, refresh);
}

async function dismiss(id) {
  const path = `${appHome()}/data/sixfold/alerts-dismissed.json`;
  const old = await readTextFile(path);
  const ids = old ? JSON.parse(old) : [];
  await writeTextFile(path, JSON.stringify([...ids, id]), old);
}

export function alertSection(view, t) {
  const alerts = visibleAlerts(view.alerts);
  const waiting = alerts.filter(item => item.status === 'needs-you').length;
  return v_flex().id('sf-alerts').flex_none().px(10).py(9).gap(4).bg(t.surface).border_t(1).border_color(t.border)
    .child(h_flex().gap(5).items_center()
      .child(div().flex_1().text_size(10).font_bold().text_color(t.muted).child('Share 알림'))
      .child(div().text_size(10).text_color(t.accent).child(`확인 ${waiting}건`)))
    .children(alerts.map(item => h_flex().id(`sf-alert-${item.id}`).gap(5).items_center().px(6).py(4).rounded(4).bg(t.chrome)
      .tooltip(item.summary || item.text || item.title)
      .on_click(() => { if (item.terminal) run('agent.focus', { terminal: item.terminal }); })
      .child(div().text_size(10).text_color(t.accent).child(MARKS[item.status]))
      .child(div().flex_1().min_w(0).truncate().text_size(10).text_color(t.foreground)
        .child(`${item.project} · ${item.summary || item.title}`))
      .child(div().id(`sf-alert-close-${item.id}`).px(3).text_size(11).text_color(t.muted)
        .on_mouse_down('left', (_event, cx) => cx.stop_propagation())
        .on_mouse_up('left', (_event, cx) => cx.stop_propagation())
        .on_click((_event, cx) => {
          cx.stop_propagation();
          view.alerts = view.alerts.filter(other => other.id !== item.id);
          cx.spawn(async () => { await dismiss(item.id); });
          cx.notify();
        }).child('×'))));
}
