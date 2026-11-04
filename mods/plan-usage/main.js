import { View, div, svg } from 'gpui-kit';
import { Button, h_flex, v_flex } from 'gpui-base';
import { appHome, exec, theme, props, openOverlay, closeOverlay, shared, setShared } from 'herdr';

const SNAPSHOT = 'plan-usage.snapshot';
const RESETS = 'plan-usage.resets';
const REFRESH_MS = 2 * 60 * 1000;
const RESETS_MS = 5 * 60 * 1000;
const BACKOFF_MS = 10 * 60 * 1000;
const BACKOFF = 'plan-usage.backoff';
// Per-terminal share of the current weekly window, for each pane's header to read.
export const SHARES = 'agent-usage.shares';
const SCAN_KEY = 'agent-usage.lastInsightsScan';
const SCAN_MS = 5 * 60 * 1000;

// Local date the provider's current 7d window began (its reset time minus 7 days); null if unknown.
export function windowStart(windows) {
  const week = (windows || []).find(w => w.label === '7d');
  if (!week || !Number.isFinite(week.reset) || week.reset <= 0) return null;
  const start = new Date((week.reset - 7 * 86400) * 1000);
  const pad = n => String(n).padStart(2, '0');
  return `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`;
}

// What a pane header needs per terminal: share of the window, a rough part of the weekly limit, the model.
export function sharesFrom(collected, plan) {
  const terminals = {};
  for (const row of collected?.agents || []) {
    const week = (plan?.[row.agent]?.windows || []).find(w => w.label === '7d');
    terminals[row.terminal] = row.known
      ? { agent: row.agent, known: true, share: row.weekShare ?? null, model: row.models?.[row.models.length - 1] || null,
          limitPart: row.weekShare != null && week ? Math.round(row.weekShare * week.used) / 100 : null,
          limitWeek: week ? week.used : null, since: windowStart(plan?.[row.agent]?.windows) }
      : { agent: row.agent, known: false, reason: row.reason || null };
  }
  return { updated: Date.now(), terminals };
}

// A failed reading keeps the last good windows and credits, explicitly marked stale.
export function merge(previous, next) {
  if (!next?.error || next.windows?.length || next.credits || (!previous?.windows?.length && !previous?.credits)) return next;
  return { ...previous, error: next.error, code: next.code, stale: true };
}
export const PROVIDERS = [
  { id: 'codex', name: 'Codex', color: '#10A37F' },
  { id: 'claude', name: 'Claude', color: '#D97757' },
];
const WINDOW_NAMES = { '5h': '5시간', '7d': '7일' };

export function levelColor(used, t) {
  return used >= 90 ? t.blocked : used >= 70 ? t.working : t.accent;
}

export function countdown(reset, now = Date.now()) {
  if (!reset) return null;
  const minutes = Math.ceil((reset * 1000 - now) / 60000);
  if (minutes <= 0) return '곧 초기화';
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes / 60) % 24;
  return days ? `${days}일 ${hours}시간` : minutes >= 60 ? `${Math.floor(minutes / 60)}시간 ${minutes % 60}분` : `${minutes}분`;
}

export function expiryText(value, now = Date.now()) {
  if (!value) return '만료일 미확인';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '만료일 미확인';
  const days = Math.floor((date.getTime() - now) / 86400000);
  const left = days < 0 ? '만료됨' : days === 0 ? '오늘 만료' : `${days}일 남음`;
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${left}`;
}

function control(id, text, action, t, primary) {
  return Button.new(id).px(10).py(6).rounded(5).cursor_pointer()
    .text_color(primary ? t.background : t.foreground).bg(primary ? t.accent : t.surface)
    .hover(s => s.bg(primary ? t.accent : t.raised)).accessibility_label(text).child(text).on_click(action);
}

function icon(provider, size) {
  return svg(`mods/plan-usage/${provider.id}.svg`).size(size).flex_none().text_color(provider.color);
}

function bar(used, width, height, t) {
  return div().w(width).h(height).flex_none().rounded(height / 2).bg(t.border)
    .child(div().h(height).w(Math.max(used > 0 ? 2 : 0, width * Math.min(100, used) / 100)).rounded(height / 2).bg(levelColor(used, t)));
}

export default class PlanUsage extends View {
  init(_props, cx) {
    this.busy = false;
    this.resetBusy = false;
    this.confirm = false;
    this.message = null;
    this.popup = Boolean(props()?.popup || props()?.overlay);
    if (!this.popup) {
      this.refresh(cx);
      this.refreshResets(cx);
      this.refreshShares(cx);
      cx.timer.every(REFRESH_MS, cx => this.refresh(cx));
      cx.timer.every(REFRESH_MS, cx => this.refreshShares(cx));
      cx.timer.every(RESETS_MS, cx => this.refreshResets(cx));
    }
    // Countdowns move by the minute; this does not fetch.
    cx.timer.every(60000, cx => cx.notify());
  }

  refresh(cx) {
    if (this.busy) return;
    // Skip a provider read in the last refresh period (a mod reload must not re-ask), or one that
    // said "too many requests" recently. Both live in shared state, so they survive reloads.
    const now = Date.now();
    const backoff = shared(BACKOFF) || {};
    const last = shared(SNAPSHOT) || {};
    const due = PROVIDERS.filter(p => !(backoff[p.id] > now)
      && !(last[p.id]?.updated && !last[p.id].error && now - last[p.id].updated * 1000 < REFRESH_MS - 10000)).map(p => p.id);
    if (!due.length) return;
    this.busy = true;
    cx.notify();
    cx.spawn(async cx => {
      try {
        const result = await exec('python3', [`${appHome()}/mods/plan-usage/usage.py`, ...due]);
        if (result.code !== 0) throw new Error('helper');
        const data = JSON.parse(result.stdout);
        if (!due.every(id => Array.isArray(data?.[id]?.windows))) throw new Error('data');
        const previous = shared(SNAPSHOT) || {};
        const next = { ...previous };
        for (const id of due) {
          next[id] = merge(previous[id], data[id]);
          if (data[id].code === 'rate_limited') setShared(BACKOFF, { ...(shared(BACKOFF) || {}), [id]: Date.now() + BACKOFF_MS });
        }
        setShared(SNAPSHOT, next);
      } catch (_) {
        const previous = shared(SNAPSHOT) || {};
        setShared(SNAPSHOT, Object.fromEntries(PROVIDERS.map(p => [p.id,
          { ...(previous[p.id] || { windows: [] }), error: '사용량 도우미가 끝나지 않았습니다.' }])));
      } finally {
        this.busy = false;
        cx.notify();
      }
    });
  }

  // Session shares for pane headers, via Agent Usage's collector (skipped when it is not installed).
  refreshShares(cx) {
    if (this.sharesBusy) return;
    this.sharesBusy = true;
    cx.spawn(async cx => {
      try {
        const store = `${appHome()}/data/insights/insights.json`;
        if (Date.now() - (shared(SCAN_KEY) || 0) > SCAN_MS) {
          setShared(SCAN_KEY, Date.now());
          try { await exec('node', [`${appHome()}/mods/insights/collector.mjs`, 'snapshot', '--store', store]); } catch (_) {}
        }
        const plan = shared(SNAPSHOT) || {};
        const args = [`${appHome()}/mods/agent-usage/collect.py`, '--store', store];
        for (const kind of ['claude', 'codex']) {
          const start = windowStart(plan[kind]?.windows);
          if (start) args.push(`--since-${kind}`, start);
        }
        const result = await exec('python3', args);
        if (result.code !== 0) throw new Error('collector');
        setShared(SHARES, sharesFrom(JSON.parse(result.stdout), plan));
      } catch (_) {
        // Headers keep the last shares; nothing here is worth an error in the strip.
      } finally {
        this.sharesBusy = false;
      }
    });
  }

  // Codex limit resets. Reading never spends one; useOne only from the popup's confirm button.
  refreshResets(cx, useOne = false) {
    if (this.resetBusy) return;
    this.resetBusy = true;
    cx.notify();
    cx.spawn(async cx => {
      try {
        const args = [`${appHome()}/mods/plan-usage/resets.py`];
        if (useOne) args.push('--use');
        const result = await exec('python3', args);
        if (result.code !== 0) throw new Error('helper');
        const data = JSON.parse(result.stdout);
        if (!data || !Array.isArray(data.expiries)) throw new Error('data');
        setShared(RESETS, { ...data, updated: Date.now() });
        if (useOne) {
          this.message = data.used ? '초기화권 1개를 사용했습니다.' : `사용하지 못했습니다: ${data.use_error || data.error || '알 수 없는 오류'}`;
          if (data.used) this.refresh(cx);
        }
      } catch (_) {
        if (useOne) this.message = '결과를 확인하지 못했습니다. 새로고침 후 남은 개수를 확인하세요.';
        else setShared(RESETS, { ...(shared(RESETS) || { expiries: [] }), error: '초기화권 정보를 읽지 못했습니다.' });
      } finally {
        this.resetBusy = false;
        cx.notify();
      }
    });
  }

  strip() {
    const t = theme(), data = shared(SNAPSHOT) || {};
    const row = h_flex().id('plan-usage-strip').size_full().items_center().justify_start().gap(12).px(14)
      .bg(t.chrome).text_size(12.5).cursor_pointer()
      .on_click(() => openOverlay({ mod: 'plan-usage', props: { popup: true }, kind: 'popup', width: 400, height: 520 }));
    const tips = [];
    for (const provider of PROVIDERS) {
      const record = data[provider.id];
      // One pill per provider, so Codex and Claude read apart.
      const group = h_flex().h(22).items_center().rounded(11).bg(t.surface).border(1).border_color(t.border).px(10).gap(7).child(icon(provider, 15));
      if (!record) {
        group.child(div().text_color(t.dim).child('…'));
      } else if (record.error && !record.windows.length) {
        group.child(div().text_color(t.blocked).child('오류'));
      } else {
        for (const w of record.windows) {
          const left = w.used >= 90 ? countdown(w.reset) : null;
          group.child(h_flex().items_center().gap(4)
            .child(div().text_size(12).font_semibold().text_color(t.muted).child(w.label))
            .child(bar(w.used, 40, 6, t))
            .child(div().font_semibold().text_color(record.stale ? t.dim : levelColor(w.used, t)).child(`${Math.round(w.used)}%${record.stale ? '*' : ''}`))
            .when(Boolean(left), el => el.child(div().text_size(11.5).text_color(t.muted).child(left))));
        }
      }
      const resets = provider.id === 'codex' ? shared(RESETS) : null;
      if (resets?.available != null) {
        group.child(h_flex().items_center().gap(2).ml(2)
          .child(div().text_color(t.muted).child('↺'))
          .child(div().font_semibold().text_color(resets.available ? (record?.limited ? t.working : t.accent) : t.dim).child(String(resets.available))));
      }
      row.child(group);
      if (resets?.available != null) tips.push(`Codex 초기화권 ${resets.available}개${resets.expiries?.[0] ? ` · 다음 만료 ${expiryText(resets.expiries[0])}` : ''}`);
      if (record?.stale) tips.push(`${provider.name}: 이전 값 표시 중 (*) · ${record.error}`);
      tips.push(`${provider.name}: ${record?.error && !record.windows.length ? record.error
        : (record?.windows || []).map(w => `${WINDOW_NAMES[w.label] || w.label} ${Math.round(w.used)}% · ${countdown(w.reset) || '초기화 시각 미확인'} 후 초기화`).join(' / ') || '확인 중'}`);
    }
    return row.tooltip(`${tips.join('\n')}\n클릭해서 자세히 보기`);
  }

  details() {
    const t = theme(), data = shared(SNAPSHOT) || {};
    const body = v_flex().id('plan-usage-popup').size_full().overflow_y_scrollbar().p(16).gap(14).bg(t.chrome).text_size(12).text_color(t.foreground)
      .child(h_flex().items_center().justify_between()
        .child(div().text_size(15).font_semibold().child('구독 한도'))
        .child(Button.new('plan-usage-close').px(10).py(6).rounded(5).cursor_pointer().bg(t.surface)
          .hover(s => s.bg(t.raised)).child('닫기').on_click(() => closeOverlay(props().overlay))));
    for (const provider of PROVIDERS) {
      const record = data[provider.id];
      const card = v_flex().gap(8).p(12).rounded(6).bg(t.surface)
        .child(h_flex().items_center().gap(8).child(icon(provider, 18))
          .when(record?.limited === true, el => el.child(div().text_size(10.5).text_color(t.blocked).child('한도 도달'))));
      if (!record) card.child(div().text_color(t.dim).child('확인 중…'));
      if (record?.error) card.child(div().text_size(11).text_color(record.stale ? t.muted : t.blocked).child(record.stale ? `이전 값 표시 중 · ${record.error}` : record.error));
      for (const w of record?.windows || []) {
        card.child(v_flex().gap(4)
          .child(h_flex().items_center()
            .child(div().text_color(t.muted).child(WINDOW_NAMES[w.label] || w.label))
            .child(div().flex_1())
            .child(div().font_semibold().text_color(levelColor(w.used, t)).child(`${Math.round(w.used)}%`)))
          .child(bar(w.used, 344, 6, t))
          .child(div().text_size(10.5).text_color(t.dim).child(w.reset
            ? `${countdown(w.reset)} 후 초기화 · ${new Date(w.reset * 1000).toLocaleString()}` : '초기화 시각 미확인')));
      }
      if (provider.id === 'codex') {
        this.creditSection(card, record, t);
        this.resetSection(card, record, t);
      }
      body.child(card);
    }
    if (this.message) body.child(div().text_size(11.5).text_color(t.muted).child(this.message));
    const updated = Math.max(0, ...PROVIDERS.map(p => data[p.id]?.updated || 0));
    return body.child(div().flex_1()).child(div().text_size(10.5).text_color(t.dim)
      .child(`갱신 ${updated ? new Date(updated * 1000).toLocaleTimeString() : '—'} · 2분마다 자동 확인`));
  }

  creditSection(card, record, t) {
    const credits = record?.credits;
    const amount = credits?.balance == null || credits.balance === '' ? null : Number(credits.balance);
    const known = amount !== null && Number.isFinite(amount) && amount >= 0;
    const balance = credits?.unlimited ? '무제한'
      : known ? `${amount.toLocaleString('en-US', { maximumFractionDigits: 2 })} 크레딧`
      : credits?.has_credits === true ? '사용 가능 · 잔액 미제공'
      : credits?.has_credits === false ? '남은 크레딧 없음' : '잔액 미확인';
    card.child(div().h(1).bg(t.border))
      .child(h_flex().items_center()
        .child(div().text_color(t.muted).child('추가 사용 크레딧'))
        .child(div().flex_1())
        .child(div().font_semibold().text_color(record?.stale ? t.dim : t.foreground).child(balance)))
      .child(div().text_size(10.5).text_color(t.dim).child('구독 한도·초기화권과 별도인 추가 사용 잔액입니다.'));
    if (record?.limited && !record.error && !record.stale &&
        (credits?.unlimited || credits?.has_credits === true || (known && amount > 0))) {
      card.child(div().text_size(10.5).text_color(t.working).child('구독 한도 도달 · 추가 크레딧 사용 가능'));
    }
  }

  resetSection(card, record, t) {
    const resets = shared(RESETS) || {};
    const count = resets.available;
    card.child(div().h(1).bg(t.border))
      .child(h_flex().items_center()
        .child(div().text_color(t.muted).child('초기화권'))
        .child(div().flex_1())
        .child(div().font_semibold().text_color(count ? t.accent : t.dim).child(count == null ? '—' : `${count}개`)));
    if (resets.error) card.child(div().text_size(11).text_color(t.blocked).child(resets.error));
    resets.expiries?.forEach((value, i) => card.child(h_flex().gap(8).text_size(10.5)
      .child(div().w(14).text_color(i === 0 ? t.accent : t.dim).child(i === 0 ? '▶' : String(i + 1)))
      .child(div().text_color(i === 0 ? t.foreground : t.dim).child(expiryText(value)))));
    if (!count) return;
    if (this.confirm) {
      card.child(div().text_size(11).text_color(t.working).child(record?.limited === false
        ? '지금은 한도에 걸려 있지 않습니다. 그래도 1개를 쓸까요? 되돌릴 수 없습니다.'
        : '만료가 가장 빠른 초기화권 1개로 Codex 한도를 초기화할까요? 되돌릴 수 없습니다.'))
        .child(h_flex().gap(8)
          .child(control('plan-usage-reset-confirm', this.resetBusy ? '사용 중…' : '1개 사용', (_e, cx) => {
            this.confirm = false;
            this.refreshResets(cx, true);
          }, t, true).disabled(this.resetBusy))
          .child(control('plan-usage-reset-cancel', '취소', (_e, cx) => { this.confirm = false; cx.notify(); }, t)));
    } else {
      card.child(h_flex().child(control('plan-usage-reset', this.resetBusy ? '처리 중…' : '초기화권 사용', (_e, cx) => {
        this.confirm = true;
        this.message = null;
        cx.notify();
      }, t, true).disabled(this.resetBusy)));
    }
  }

  render() {
    return this.popup ? this.details() : this.strip();
  }
}
