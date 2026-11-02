/**
 * FlessingLabs Stundenplan - Kachel fuer die Uebersicht
 *
 * Wer selbst einen Plan hat (das Kind), sieht nur seinen eigenen Tag: alle
 * Stunden mit Raum, Pausen, Nachmittag und Heimkehr. Wer keinen eigenen Plan
 * hat (Eltern), sieht je Kind eine Zeile: wo laut Plan, was als Naechstes, wann
 * zu Hause. Abgeleitet wird das nur aus "hat einen eigenen Plan", nie aus Rolle,
 * Name oder Alter - und was jemand sehen darf, entscheidet weiter der Server.
 *
 * Ist der Tag vorbei (oder Wochenende), zeigt die Kachel den naechsten Tag mit
 * Eintraegen.
 */
import { api } from '/api.js';
import { t, getFormatLocale } from '/i18n.js';
import { esc } from '/utils/html.js';
import { createStore } from './lib/store.js';
import { loadHolidays } from './lib/holidays.js';
import { computeDay, positionAt, STATUS, SCHOOL } from './lib/day.js';
import { fromMinutes, nowInZone, addDays } from './lib/time.js';

const ID = 'flessinglabs-school';
const ROUTE = `/m/${ID}`;
const tr = (key, params) => t(`extensions.${ID}.${key}`, params);

// Modul-CSS laedt Yuvomi nur auf der Modulseite; die Kachel bringt ihr
// Weniges selbst mit (nur Yuvomi-Tokens).
const CSS = `
.spw-list { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-2, 8px); }
.spw-row { display: grid; gap: 2px; }
.spw-name { display: flex; gap: 6px; align-items: baseline; flex-wrap: wrap; font-weight: 600; color: var(--color-text-primary); }
.spw-line { color: var(--color-text-secondary); font-size: var(--text-sm); }
.spw-home { color: var(--color-text-primary); font-size: var(--text-sm); font-weight: 600; }
.spw-badge { font-size: var(--text-xs); font-weight: 600; padding: 0 6px; border-radius: 999px; background: var(--color-warning, var(--color-accent)); color: var(--color-text-on-accent); }
.spw-day { margin: 0 0 var(--space-1, 4px); font-size: var(--text-sm); color: var(--color-text-secondary); }
.spw-seg { display: grid; grid-template-columns: 6.2em 1fr; gap: 6px; font-size: var(--text-sm); font-variant-numeric: tabular-nums; color: var(--color-text-primary); }
.spw-seg--break, .spw-seg--gap { color: var(--color-text-tertiary, var(--color-text-secondary)); font-size: var(--text-xs); }
.spw-seg--now { font-weight: 700; }
`;

function ensureStyle() {
  if (document.getElementById('spw-style')) return;
  const el = document.createElement('style');
  el.id = 'spw-style';
  el.textContent = CSS;
  document.head.append(el);
}

const time = (m) => fromMinutes(m);

function what(s) {
  if (s.type === 'lesson') return s.title || tr('type.lesson');
  if (s.type === 'project') return s.title || tr('type.project');
  if (s.type === 'care') return tr('type.care');
  if (s.type === 'break') return tr('type.break');
  if (s.type === 'travel') return s.mode === 'pickup' ? tr('type.pickup') : tr('type.travel');
  return tr('type.gap');
}

function homeText(r) {
  if (r.status === STATUS.OK && r.home) return tr('home.at', { time: time(r.home.minutes) });
  if (r.status === STATUS.OPEN || r.status === STATUS.CONFLICT) return tr('home.open');
  return '';
}

function statusText(r) {
  if (r.status === STATUS.ABSENT) return tr('status.absent');
  if (r.status === STATUS.OFF) return r.holiday?.name ?? tr('status.off');
  if (r.status === STATUS.EMPTY) return tr('status.empty');
  if (r.status === STATUS.NO_PLAN) return tr('status.no_plan');
  return '';
}

/** Hat das Kind an diesem Tag ab `minutes` noch etwas vor? */
function stillAhead(r, minutes) {
  if (!r.segments.length) return false;
  const end = r.home?.minutes ?? r.segments.at(-1).end;
  return minutes < end;
}

export async function renderWidget(container, { size } = {}) {
  ensureStyle();
  const store = createStore(api);
  const locale = getFormatLocale?.() || 'de-DE';
  const prefs = (await api.get('/preferences'))?.data ?? {};
  const tz = prefs.timezone_effective || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = nowInZone(tz);

  let people;
  try {
    people = await store.people();
  } catch (err) {
    if (err?.reason === 'persons_unsupported' || err?.reason === 'storage_unsupported') {
      container.insertAdjacentHTML('beforeend', frame(tr('title'), `<p class="spw-line">${esc(tr('error.load.unsupported.title'))}</p>`));
      return;
    }
    throw err;
  }
  const [rasters, ...data] = await Promise.all([store.loadShared(), ...people.map((p) => store.load(p.user_id))]);
  const byId = new Map(people.map((p, i) => [p.user_id, data[i]]));
  const withPlans = people.filter((p) => byId.get(p.user_id).plans.length);
  const me = withPlans.find((p) => p.self);
  const shown = me ? [me] : withPlans;

  let holidays = null;
  try { holidays = await loadHolidays(api, now.date, addDays(now.date, 8)); } catch { /* bleibt unbekannt */ }
  const dayFor = (p, date) => computeDay({
    ...byId.get(p.user_id), date, rasters, holiday: holidays ? holidays.holidayFor(date) : 'unknown',
  });

  // Heute, solange noch jemand etwas vorhat - sonst der naechste Tag mit Eintraegen.
  let date = now.date;
  if (!shown.some((p) => stillAhead(dayFor(p, date), now.minutes))) {
    for (let i = 1; i <= 7; i++) {
      const d = addDays(now.date, i);
      if (shown.some((p) => dayFor(p, d).segments.length)) { date = d; break; }
    }
  }
  const isToday = date === now.date;
  const dayLabel = isToday ? tr('widget.today')
    : date === addDays(now.date, 1) ? tr('widget.tomorrow')
      : new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));

  if (!shown.length) {
    container.insertAdjacentHTML('beforeend', frame(tr('title'), `<p class="spw-line">${esc(tr('widget.none'))}</p>`));
    return;
  }

  let body;
  if (me) {
    const r = dayFor(me, date);
    // Stundenwechsel unter 10 Minuten machen die kleine Kachel nur unruhig.
    const segs = r.segments.filter((s) => s.type !== 'travel' && !((s.type === 'gap' || s.type === 'break') && s.end - s.start < 10));
    const cur = isToday ? positionAt(r, now.minutes).current : null;
    body = `<p class="spw-day">${esc(dayLabel)}${r.exception ? ` <span class="spw-badge">${esc(tr('badge.exception'))}</span>` : ''}</p>
      ${segs.length ? `<div class="spw-list">${segs.map((s) => `<div class="spw-seg spw-seg--${s.type}${s === cur ? ' spw-seg--now' : ''}">
        <span>${esc(time(s.start))}–${esc(time(s.end))}</span>
        <span>${esc(what(s))}${s.room ? ` · ${esc(s.room)}` : ''}${s.type !== 'lesson' && s.type !== 'break' && s.type !== 'gap' && s.place && s.place !== SCHOOL ? ` · ${esc(s.place)}` : ''}</span></div>`).join('')}</div>`
        : `<p class="spw-line">${esc(statusText(r))}</p>`}
      ${homeText(r) ? `<p class="spw-home">${esc(homeText(r))}</p>` : ''}
      ${r.exception?.note ? `<p class="spw-line">${esc(r.exception.note)}</p>` : ''}`;
  } else {
    body = `<p class="spw-day">${esc(dayLabel)}</p><ul class="spw-list">${shown.map((p) => {
      const r = dayFor(p, date);
      let line = statusText(r);
      if (r.segments.length) {
        const pos = isToday ? positionAt(r, now.minutes) : null;
        const first = r.segments[0];
        if (pos?.current && pos.current.type !== 'travel') line = tr('now.current', { what: what(pos.current), until: time(pos.current.end) });
        else if (pos?.current?.type === 'travel') line = tr('now.travel');
        else line = tr('widget.span', { from: time(first.start), what: what(first) });
        if (r.last) line += ` · ${tr('dayLast', { what: what(r.last), until: time(r.last.end) })}`;
      }
      return `<li class="spw-row"><span class="spw-name">${esc(p.display_name)}${r.exception ? ` <span class="spw-badge">${esc(tr('badge.exception'))}</span>` : ''}</span>
        ${line ? `<span class="spw-line">${esc(line)}</span>` : ''}
        ${homeText(r) ? `<span class="spw-home">${esc(homeText(r))}</span>` : ''}</li>`;
    }).join('')}</ul>`;
  }
  container.insertAdjacentHTML('beforeend', frame(tr('title'), body));
}

/** Kopf wie bei Yuvomis eigenen Kacheln (Siegel, Titel, Link zur Seite). */
function frame(title, body) {
  return `<div class="widget__header">
      <h3 class="widget__title">
        <span class="module-seal module-seal--sm" style="--seal-accent: #3B82F6" aria-hidden="true"><i data-lucide="school"></i></span>
        <span class="widget__title-text">${esc(title)}</span>
      </h3>
      <a href="${ROUTE}" data-route="${ROUTE}" class="widget__link">${esc(tr('widget.open'))}</a>
    </div>
    <div class="widget__body">${body}</div>`;
}
