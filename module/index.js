/**
 * FlessingLabs Stundenplan - Seite
 *
 * Wo ist mein Kind laut Plan gerade, was kommt danach, wann kommt es
 * voraussichtlich nach Hause? Drei Ansichten: Heute (eine Karte je Kind),
 * Woche (je Kind) und Plaene (pflegen).
 *
 * Datenwege (alle ueber Yuvomis /api.js, mit der Sitzung des Mitglieds):
 *   Personen + Rechte  -> /api/v1/modules/flessinglabs-school/people
 *   Plaene, Ausnahmen  -> /api/v1/modules/flessinglabs-school/records (je Kind, subject_id)
 *   Zeitzone, Ferien   -> /api/v1/preferences, /api/v1/calendar/holidays
 *
 * Wer welche Plaene sieht oder aendert, prueft Yuvomi auf dem Server. Was hier
 * ausgeblendet wird (Bearbeiten-Knoepfe ohne Schreibrecht), ist nur Bequemlichkeit.
 * Katalog-Ids (Plaene, Ausnahmen) sind UUID-Strings, Personen-Ids Zahlen.
 */

import { api } from '/api.js';
import { t, getFormatLocale } from '/i18n.js';
import { esc } from '/utils/html.js';
import { renderPageHeader, renderPageTitle, renderPageActions, renderPageBody, renderPageSection } from '/utils/page-layout.js';
import { showToast } from '/utils/toast-show.js';
import { createStore, dataOf } from './lib/store.js';
import { loadHolidays } from './lib/holidays.js';
import { computeDay, positionAt, STATUS, SCHOOL } from './lib/day.js';
import { fromMinutes, nowInZone, addDays, mondayOf, weekday, abWeek } from './lib/time.js';
import { buildWeekGrid } from './lib/grid.js';
import { emptyPlan, emptyDay, copyPlan, copyPlanFor, cleanTeachers, validatePlan, validateException, isEmptyException, overlappingPlans, WEEKDAYS, emptyRaster, nextPeriod, validateRaster } from './lib/plan.js';

const ID = 'flessinglabs-school';
const tr = (key, params) => t(`extensions.${ID}.${key}`, params);
const VIEW_KEY = `${ID}:view`;

function icons(el) {
  if (window.lucide) window.lucide.createIcons({ el });
}
function readView() {
  try { return localStorage.getItem(VIEW_KEY) || 'today'; } catch { return 'today'; }
}
function storeView(v) {
  try { localStorage.setItem(VIEW_KEY, v); } catch { /* privates Fenster */ }
}

/** Wert unter einem Pfad wie "days.1.lessons.0.start" setzen. */
function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k];
  o[keys.at(-1)] = value;
}
function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export async function render(container, { signal } = {}) {
  const store = createStore(api);
  const locale = getFormatLocale?.() || 'de-DE';

  const state = {
    view: readView(),
    tz: 'Europe/Berlin',
    today: null,
    nowMin: 0,
    date: null,          // gewaehlter Tag (Heute-Ansicht) bzw. Tag in der gewaehlten Woche
    people: [],          // [{ user_id, display_name, access, self }]
    data: new Map(),     // user_id -> { plans, exceptions }
    holidays: null,      // { coverage, holidayFor, from, to }
    focus: null,         // Person in Woche / Plaene
    draft: null,         // Plan in Bearbeitung: { personId, base: record|null, plan }
    showWeekend: false,
    exEdit: null,        // { personId, date }
    rasters: [],         // Stundenraster (haushaltsweit)
    rasterDraft: null,   // { base: record|null, raster }
    sharedWrite: false,  // darf Stundenraster aendern (Modulrecht schreiben)
    weekAll: false,      // Woche: alle Kinder untereinander statt eines
    copyTo: null,        // Plan-Id, deren "Auf anderes Kind kopieren" offen ist
  };

  container.replaceChildren();
  container.insertAdjacentHTML('beforeend',
    renderPageHeader({
      wrap: true,
      title: renderPageTitle(esc(tr('title'))),
      actions: renderPageActions('<div class="sp-tabs" role="tablist" data-sp="tabs"></div>'),
    })
    + renderPageBody({ className: 'sp', content: renderPageSection({ content: '<div data-sp="main" aria-busy="true"></div>' }) }));
  const main = container.querySelector('[data-sp="main"]');
  const tabs = container.querySelector('[data-sp="tabs"]');

  // ------------------------------------------------------------------
  // Laden
  // ------------------------------------------------------------------

  async function ensureHolidays(date) {
    const h = state.holidays;
    if (h && date >= h.from && date <= h.to) return;
    const from = addDays(mondayOf(date), -7);
    const to = addDays(from, 62);
    const loaded = await loadHolidays(api, from, to, { signal });
    state.holidays = { ...loaded, from, to };
  }

  async function loadPerson(personId) {
    state.data.set(personId, await store.load(personId, { signal }));
  }

  async function load() {
    main.setAttribute('aria-busy', 'true');
    try {
      const prefs = (await api.get('/preferences', { signal }))?.data ?? {};
      if (signal?.aborted) return;
      state.tz = prefs.timezone_effective || Intl.DateTimeFormat().resolvedOptions().timeZone;
      const now = nowInZone(state.tz);
      state.today = now.date;
      state.nowMin = now.minutes;
      state.date ??= now.date;
      // Personen zuerst: ohne sie (Yuvomi ohne Migration 275) wird nichts
      // gelesen oder geschrieben - es gaebe keine Trennung zwischen den Kindern.
      state.people = await store.people({ signal });
      const [me, rasters] = await Promise.all([
        api.get('/auth/me', { signal }),
        store.loadShared({ signal }),
        ...state.people.map((p) => loadPerson(p.user_id)),
      ]);
      state.rasters = rasters;
      state.sharedWrite = Boolean(me?.permissions?.admin) || me?.permissions?.modules?.[`ext:${ID}`] === 'write';
      await ensureHolidays(state.date);
      if (signal?.aborted) return;
      if (!state.focus || !state.people.some((p) => p.user_id === state.focus)) state.focus = defaultFocus();
      renderAll();
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError') return;
      renderLoadError(err);
    } finally {
      main.removeAttribute('aria-busy');
    }
  }

  function renderLoadError(err) {
    const kind = { storage_unsupported: 'unsupported', persons_unsupported: 'unsupported', storage_unavailable: 'unavailable', forbidden: 'forbidden' }[err?.reason] ?? 'failed';
    tabs.replaceChildren();
    main.replaceChildren();
    main.insertAdjacentHTML('beforeend', `
      <div class="sp-message" role="alert">
        <p class="sp-message__title">${esc(tr(`error.load.${kind}.title`))}</p>
        <p class="sp-message__text">${esc(tr(`error.load.${kind}.text`))}</p>
        ${kind === 'failed' || kind === 'unavailable' ? `<button type="button" class="btn btn--secondary" data-action="retry">${esc(tr('action.retry'))}</button>` : ''}
      </div>`);
  }

  // ------------------------------------------------------------------
  // Hilfen fuer die Anzeige
  // ------------------------------------------------------------------

  const person = (id) => state.people.find((p) => p.user_id === id);
  const plansOf = (id) => state.data.get(id)?.plans ?? [];
  const exceptionsOf = (id) => state.data.get(id)?.exceptions ?? [];
  const canWrite = (id) => person(id)?.access === 'write';
  const withPlans = () => state.people.filter((p) => plansOf(p.user_id).length > 0);
  const editable = () => state.people.filter((p) => p.access === 'write' || plansOf(p.user_id).length > 0);

  function defaultFocus() {
    return (withPlans()[0] ?? editable()[0] ?? state.people[0])?.user_id ?? null;
  }

  function dayFor(personId, date) {
    return computeDay({
      plans: plansOf(personId),
      exceptions: exceptionsOf(personId),
      date,
      holiday: state.holidays ? state.holidays.holidayFor(date) : 'unknown',
      rasters: state.rasters,
    });
  }

  const time = (min) => fromMinutes(min);
  const placeName = (p) => (p === SCHOOL || p == null ? tr('place.school') : p);
  const fmtDate = (date, opts = { weekday: 'long', day: 'numeric', month: 'long' }) =>
    new Intl.DateTimeFormat(locale, { ...opts, timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));

  function what(s) {
    if (!s) return '';
    if (s.type === 'lesson') return s.title || tr('type.lesson');
    if (s.type === 'project') return s.title || tr('type.project');
    if (s.type === 'care') return tr('type.care');
    if (s.type === 'travel') return s.mode === 'pickup' ? tr('type.pickup') : tr('type.travel');
    if (s.type === 'break') return tr('type.break');
    return tr('type.gap');
  }

  function reasonText(r) {
    const params = { ...r };
    if (r.labels) params.labels = r.labels.map((l) => `„${l}“`).join(', ');
    if (r.what) params.what = tr(`what.${r.what}`);
    if ('place' in r) params.place = placeName(r.place);
    return tr(`reason.${r.code}`, params);
  }

  function homeLine(r) {
    if (r.status === STATUS.OK && r.home) {
      if (r.home.mode === 'pickup') {
        return r.home.pickup !== null && r.home.pickup !== undefined
          ? tr('home.pickup', { pickup: time(r.home.pickup), time: time(r.home.minutes) })
          : tr('home.pickupFixed', { time: time(r.home.minutes) });
      }
      return tr('home.at', { time: time(r.home.minutes) });
    }
    return null;
  }

  function statusLines(r) {
    switch (r.status) {
      case STATUS.NO_PLAN: return [tr('status.no_plan')];
      case STATUS.EMPTY: return [tr('status.empty')];
      case STATUS.OFF: return [tr('status.off')];
      case STATUS.ABSENT: return [tr('status.absent')];
      default: return [];
    }
  }

  function badges(r) {
    const out = [];
    if (r.exception) out.push(`<span class="sp-badge sp-badge--exception">${esc(tr('badge.exception'))}</span>`);
    if (r.holiday) out.push(`<span class="sp-badge">${esc(tr('badge.holiday', { name: r.holiday.name }))}</span>`);
    if (r.week) out.push(`<span class="sp-badge sp-badge--muted">${esc(tr('badge.week', { week: r.week }))}</span>`);
    return out.join('');
  }

  /** "Klasse 4b · Klassenlehrer:in: Frau Berg (0171 …)" - leer ohne Angaben. */
  function schoolInfo(plan) {
    if (!plan) return '';
    const parts = [];
    if (plan.class_name) parts.push(tr('school.class', { name: plan.class_name }));
    for (const x of plan.teachers ?? []) parts.push(tr('school.teacher', { name: x.contact ? `${x.name} (${x.contact})` : x.name }));
    return parts.join(' · ');
  }

  function timelineHtml(r) {
    if (!r.segments.length) return '';
    return `<ol class="sp-timeline">${r.segments.map((s) => `
      <li class="sp-seg sp-seg--${s.type}">
        <span class="sp-seg__time">${esc(time(s.start))}–${esc(time(s.end))}</span>
        <span class="sp-seg__what">${esc(what(s))}${s.type === 'travel' || s.type === 'gap' || s.type === 'break' || s.place === SCHOOL || s.place == null ? '' : ` · ${esc(placeName(s.place))}`}${s.room ? ` · ${esc(s.room)}` : ''}</span>
      </li>`).join('')}</ol>`;
  }

  // ------------------------------------------------------------------
  // Darstellung
  // ------------------------------------------------------------------

  function renderTabs() {
    tabs.replaceChildren();
    tabs.insertAdjacentHTML('beforeend', ['today', 'week', 'plans'].map((v) => `
      <button type="button" class="btn ${state.view === v ? 'btn--primary' : 'btn--secondary'} sp-tab" role="tab"
              aria-selected="${state.view === v}" data-action="view" data-view="${v}">${esc(tr(`tab.${v}`))}</button>`).join(''));
  }

  function renderAll() {
    renderTabs();
    main.replaceChildren();
    if (state.view === 'week') main.insertAdjacentHTML('beforeend', weekHtml());
    else if (state.view === 'plans') main.insertAdjacentHTML('beforeend', plansHtml());
    else main.insertAdjacentHTML('beforeend', todayHtml());
    applyConditional(main);
    icons(main);
  }

  function holidayHint() {
    const c = state.holidays?.coverage;
    if (c === 'full') return '';
    return `<p class="sp-hint">${esc(tr(c === 'public_only' ? 'holidays.publicOnly' : 'holidays.unknown'))}</p>`;
  }

  function dateNav() {
    const isToday = state.date === state.today;
    return `
      <div class="sp-datenav">
        <button type="button" class="btn btn--secondary sp-icon" data-action="day" data-delta="-1" aria-label="${esc(tr('date.prev'))}"><i data-lucide="chevron-left" aria-hidden="true"></i></button>
        <label class="sp-datenav__date">
          <span class="sr-only">${esc(tr('date.pick'))}</span>
          <input type="date" class="form-input" data-action="pick-date" value="${esc(state.date)}">
        </label>
        <button type="button" class="btn btn--secondary sp-icon" data-action="day" data-delta="1" aria-label="${esc(tr('date.next'))}"><i data-lucide="chevron-right" aria-hidden="true"></i></button>
        ${isToday ? '' : `<button type="button" class="btn btn--secondary" data-action="today">${esc(tr('date.today'))}</button>`}
      </div>
      <p class="sp-dayname">${esc(fmtDate(state.date))}</p>`;
  }

  // ---- Heute ---------------------------------------------------------------

  function todayHtml() {
    const people = withPlans();
    let cards;
    if (!people.length) {
      cards = `<p class="sp-message__text">${esc(tr(state.people.some((p) => p.access === 'write') ? 'today.none' : 'today.noPeople'))}</p>`;
    } else {
      cards = people.map((p) => cardHtml(p)).join('');
    }
    return `${dateNav()}${holidayHint()}<div class="sp-cards">${cards}</div><p class="sp-note">${esc(tr('planNote'))}</p>`;
  }

  function cardHtml(p) {
    const r = dayFor(p.user_id, state.date);
    const lines = [];
    const isToday = state.date === state.today;
    if (isToday && r.segments.length) {
      const pos = positionAt(r, state.nowMin);
      if (pos.after && r.home) lines.push(tr('now.after', { home: time(r.home.minutes) }));
      else if (pos.before) lines.push(tr('now.before', { at: time(r.segments[0].start), what: what(r.segments[0]) }));
      else if (pos.current?.type === 'travel') lines.push(tr('now.travel'));
      else if (pos.current?.type === 'break') lines.push(tr('now.break', { until: time(pos.current.end) }));
      else if (pos.current?.type === 'gap') lines.push(tr('now.gap', { until: time(pos.current.end) }));
      else if (pos.current) lines.push(tr('now.current', { what: what(pos.current), until: time(pos.current.end) }));
      if (pos.next && !pos.before && pos.next.type !== 'travel') lines.push(tr('next', { what: what(pos.next), at: time(pos.next.start) }));
    } else if (r.last) {
      lines.push(tr('dayLast', { what: what(r.last), until: time(r.last.end) }));
    }
    lines.push(...statusLines(r));
    const homeText = homeLine(r);
    const open = r.status === STATUS.OPEN || r.status === STATUS.CONFLICT;
    const editing = state.exEdit && state.exEdit.personId === p.user_id && state.exEdit.date === state.date;
    return `
      <article class="sp-card${r.exception ? ' sp-card--exception' : ''}" data-person="${p.user_id}">
        <header class="sp-card__head">
          <h2 class="sp-card__name">${esc(p.display_name)}</h2>
          <div class="sp-card__badges">${badges(r)}</div>
        </header>
        ${lines.map((l) => `<p class="sp-card__line">${esc(l)}</p>`).join('')}
        ${homeText ? `<p class="sp-card__home">${esc(homeText)}</p>` : ''}
        ${open ? `<p class="sp-card__home sp-card__home--open">${esc(tr('home.open'))}</p>
          <ul class="sp-reasons">${r.reasons.map((x) => `<li>${esc(reasonText(x))}</li>`).join('')}</ul>` : ''}
        ${r.exception?.note ? `<p class="sp-card__note">${esc(r.exception.note)}</p>` : ''}
        <details class="sp-card__details"><summary>${esc(fmtDate(state.date, { weekday: 'short', day: 'numeric', month: 'short' }))}</summary>${timelineHtml(r)}
          ${schoolInfo(r.plan) ? `<p class="sp-hint">${esc(schoolInfo(r.plan))}</p>` : ''}</details>
        ${canWrite(p.user_id) ? (editing ? exceptionFormHtml(p.user_id, state.date, r)
          : `<button type="button" class="btn btn--secondary sp-card__action" data-action="exception">${esc(tr(r.exception ? 'action.editException' : 'action.exception'))}</button>`) : ''}
      </article>`;
  }

  // ---- Tagesausnahme -------------------------------------------------------

  function exceptionFormHtml(personId, date, r) {
    const ex = r.exception ?? {};
    // Projekte des Tages laut Plan (ohne Ausnahme), damit sie sich absagen/verschieben lassen.
    const planDay = r.plan?.days?.[String(weekday(date))] ?? emptyDay();
    const projectTitles = [...new Set((planDay.projects ?? []).map((x) => x.title))];
    const sel = (name, value, options) => `<select class="form-input" name="${name}">${options.map(([v, label]) =>
      `<option value="${v}"${v === value ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
    const timeIn = (name, value, when) => `<input type="time" class="form-input" name="${name}" value="${esc(value ?? '')}"${when ? ` data-when="${when}"` : ''}>`;
    const lessonsMode = ex.lessons?.cancelled ? 'cancel' : ex.lessons?.end ? 'end' : 'plan';
    const raster = r.plan?.periods_id ? state.rasters.find((x) => x.id === r.plan.periods_id) : null;
    // Mit Stundenraster: "endet nach Stunde N" statt einer Uhrzeit.
    const lessonsEnd = raster
      ? `<select class="form-input" name="lessons_end" data-when="lessons=end">${raster.periods.map((pp) =>
        `<option value="${esc(pp.end)}"${ex.lessons?.end === pp.end ? ' selected' : ''}>${esc(tr('period.after', { n: pp.n, time: pp.end }))}</option>`).join('')}</select>`
      : timeIn('lessons_end', ex.lessons?.end, 'lessons=end');
    const careMode = ex.care?.cancelled ? 'cancel' : ex.care?.start ? 'times' : 'plan';
    const endMode = ex.end?.mode ?? 'plan';
    return `
      <form class="sp-ex" data-action="save-exception" data-person="${personId}" novalidate>
        <label class="sp-field"><span>${esc(tr('ex.dayLabel'))}</span>
          ${sel('day', ex.day ?? 'normal', ['normal', 'no_school', 'absent'].map((v) => [v, tr(`ex.day.${v}`)]))}</label>
        <div class="sp-field" data-when="day!=absent"><span>${esc(tr('ex.lessonsLabel'))}</span>
          <div class="sp-row">${sel('lessons', lessonsMode, ['plan', 'cancel', 'end'].map((v) => [v, tr(`ex.lessons.${v}`)]))}
          ${lessonsEnd}</div></div>
        <div class="sp-field" data-when="day!=absent"><span>${esc(tr('ex.careLabel'))}</span>
          <div class="sp-row">${sel('care', careMode, ['plan', 'cancel', 'times'].map((v) => [v, tr(`ex.care.${v}`)]))}
          ${timeIn('care_start', ex.care?.start, 'care=times')}${timeIn('care_end', ex.care?.end, 'care=times')}</div></div>
        ${projectTitles.map((title, i) => {
          const c = ex.projects?.[title];
          const mode = c?.cancelled ? 'cancel' : c?.start ? 'times' : 'plan';
          return `<div class="sp-field" data-when="day!=absent"><span>${esc(title)}</span>
            <input type="hidden" name="p${i}_title" value="${esc(title)}">
            <div class="sp-row">${sel(`p${i}`, mode, ['plan', 'cancel', 'times'].map((v) => [v, tr(`ex.project.${v}`)]))}
            ${timeIn(`p${i}_start`, c?.start, `p${i}=times`)}${timeIn(`p${i}_end`, c?.end, `p${i}=times`)}</div></div>`;
        }).join('')}
        <div class="sp-field" data-when="day!=absent"><span>${esc(tr('ex.endLabel'))}</span>
          <div class="sp-row">${sel('end', endMode, ['plan', 'home', 'pickup'].map((v) => [v, tr(`ex.end.${v === 'plan' ? 'plan' : v}`)]))}</div>
          <div class="sp-row" data-when="end=pickup">
            <label class="sp-mini">${esc(tr('field.pickup'))}${timeIn('end_pickup', ex.end?.pickup)}</label>
            <label class="sp-mini">${esc(tr('field.drive'))}<input type="number" min="0" max="600" inputmode="numeric" class="form-input" name="end_drive" value="${esc(ex.end?.drive ?? '')}"></label>
            <label class="sp-mini">${esc(tr('field.homeTime'))}${timeIn('end_home', ex.end?.home)}</label>
          </div></div>
        <label class="sp-field"><span>${esc(tr('field.note'))}</span>
          <input class="form-input" name="note" maxlength="200" value="${esc(ex.note ?? '')}"></label>
        <p class="sp-error" role="alert" hidden></p>
        <div class="sp-actions">
          <button type="submit" class="btn btn--primary">${esc(tr('action.save'))}</button>
          <button type="button" class="btn btn--secondary" data-action="cancel-exception">${esc(tr('action.cancel'))}</button>
          ${r.exception ? `<button type="button" class="btn btn--danger-outline sp-actions__end" data-action="delete-exception">${esc(tr('action.delete'))}</button>` : ''}
        </div>
      </form>`;
  }

  /** Bedingte Felder: `data-when="feld=wert"` oder `"feld!=wert"` innerhalb eines Formulars. */
  function applyConditional(root) {
    for (const form of root.querySelectorAll('form')) {
      for (const el of form.querySelectorAll('[data-when]')) {
        const [, name, op, value] = /^(\w+)(!?=)(.+)$/.exec(el.dataset.when) ?? [];
        const field = form.elements[name];
        if (!field) continue;
        el.hidden = op === '=' ? field.value !== value : field.value === value;
      }
    }
  }

  function exceptionFromForm(form, date) {
    const f = form.elements;
    const ex = { kind: 'exception', date, day: f.day.value };
    if (ex.day !== 'absent') {
      if (f.lessons.value === 'cancel') ex.lessons = { cancelled: true };
      else if (f.lessons.value === 'end') ex.lessons = { end: f.lessons_end.value };
      if (f.care.value === 'cancel') ex.care = { cancelled: true };
      else if (f.care.value === 'times') ex.care = { start: f.care_start.value, end: f.care_end.value };
      const projects = {};
      for (let i = 0; f[`p${i}_title`]; i++) {
        const title = f[`p${i}_title`].value;
        const mode = f[`p${i}`].value;
        if (mode === 'cancel') projects[title] = { cancelled: true };
        else if (mode === 'times') projects[title] = { start: f[`p${i}_start`].value, end: f[`p${i}_end`].value };
      }
      if (Object.keys(projects).length) ex.projects = projects;
      if (f.end.value === 'home') ex.end = { mode: 'home' };
      else if (f.end.value === 'pickup') {
        ex.end = { mode: 'pickup' };
        if (f.end_home.value) ex.end.home = f.end_home.value;
        if (f.end_pickup.value) ex.end.pickup = f.end_pickup.value;
        if (f.end_drive.value !== '') ex.end.drive = Number(f.end_drive.value);
      }
    }
    const note = f.note.value.trim();
    if (note) ex.note = note;
    return ex;
  }

  async function saveException(form) {
    const personId = Number(form.dataset.person);
    const date = state.date;
    const errorEl = form.querySelector('.sp-error');
    const fail = (text) => { errorEl.textContent = text; errorEl.hidden = false; };
    const data = exceptionFromForm(form, date);
    const problems = validateException(data);
    if (problems.length) return fail(problems.map((p) => tr(`problem.${p.code}`)).join(' '));
    const existing = exceptionsOf(personId).find((e) => e.date === date);
    try {
      if (isEmptyException(data)) {
        if (existing) await store.remove(existing);
      } else if (existing) {
        await store.update(existing, data);
      } else {
        await store.create(personId, data);
      }
      await loadPerson(personId);
      if (signal?.aborted) return;
      state.exEdit = null;
      renderAll();
      showToast(tr('toast.saved'), 'success');
    } catch (err) {
      if (signal?.aborted) return;
      if (err?.reason === 'conflict' || err?.reason === 'not_found') {
        await loadPerson(personId).catch(() => {});
        renderAll();
        showToast(tr('error.conflict'), 'warning', 6000);
        return;
      }
      fail(errorText(err));
    }
  }

  async function deleteException(personId) {
    const existing = exceptionsOf(personId).find((e) => e.date === state.date);
    if (!existing) return;
    try {
      await store.remove(existing);
    } catch (err) {
      if (err?.reason !== 'not_found') {
        if (err?.reason === 'conflict') showToast(tr('error.conflict'), 'warning', 6000);
        else showToast(errorText(err), 'danger');
      }
    }
    await loadPerson(personId).catch(() => {});
    if (signal?.aborted) return;
    state.exEdit = null;
    renderAll();
  }

  function errorText(err) {
    return tr({ forbidden: 'error.forbidden', storage_full: 'error.full', conflict: 'error.conflict', not_found: 'error.gone' }[err?.reason] ?? 'error.generic');
  }

  // ---- Woche ---------------------------------------------------------------

  function personChips(list) {
    if (list.length <= 1) return '';
    return `<div class="sp-chips">${list.map((p) => `
      <button type="button" class="btn ${p.user_id === state.focus ? 'btn--primary' : 'btn--secondary'} sp-chip"
              data-action="focus" data-person="${p.user_id}" aria-pressed="${p.user_id === state.focus}">${esc(p.display_name)}</button>`).join('')}</div>`;
  }

  /** Die Tage einer Woche: Mo-Fr, Sa/So nur wenn dort etwas steht. */
  function weekDays(personId, monday) {
    return [...Array(7)].map((_, i) => addDays(monday, i))
      .map((date) => ({ key: date, result: dayFor(personId, date) }))
      .filter(({ key, result }) => weekday(key) <= 5 || result.segments.length || result.exception);
  }

  /** Was in einer Spalte ohne Unterricht steht (abwesend, Ferien, kein Plan ...). */
  function statusCell(r) {
    if (r.status === STATUS.ABSENT) return tr('status.absent');
    if (r.status === STATUS.OFF && r.holiday) return r.holiday.name;
    if (r.status === STATUS.CONFLICT) return tr('status.conflict');
    return statusLines(r)[0] ?? '';
  }

  /** Text statt Stunden, wenn an dem Tag kein Unterricht ist - sonst null. */
  function columnStatus(c) {
    if (c.status) return statusCell(c.result);
    if (c.cells.size) return null;
    const r = c.result;
    if (r.holiday) return r.holiday.name;
    if (r.exception?.day === 'no_school') return tr('ex.day.no_school');
    if (r.exception?.lessons?.cancelled) return tr('grid.cancelled');
    return null;
  }

  /**
   * Die Wochentabelle: Zeilen = Stunden (mit Pausen), Spalten = Tage, darunter
   * Nachmittag und Heimkehr. `dated` zeigt Datum, Abweichungen und Ferien -
   * ohne ist es der allgemeine Plan (PDF eines Plans).
   */
  function gridHtml(days, { dated = true } = {}) {
    const { rows, columns } = buildWeekGrid(days, state.rasters);
    const lessonRows = rows.length ? rows : [{ kind: 'period', n: null, start: null, end: null, empty: true }];
    const head = columns.map((c) => {
      const r = c.result;
      const cls = ['sp-grid__day'];
      if (dated && c.key === state.today) cls.push('sp-grid__day--today');
      if (dated && r.exception) cls.push('sp-grid__day--exception');
      if (dated && (r.status === STATUS.ABSENT || r.status === STATUS.OFF)) cls.push('sp-grid__day--off');
      const label = dated ? fmtDate(c.key, { weekday: 'short', day: 'numeric', month: 'numeric' }) : tr(`weekday.${weekday(c.key)}`);
      return `<th scope="col" class="${cls.join(' ')}">${esc(label)}
        ${dated ? `<div class="sp-grid__badges">${badges(r)}</div>` : ''}
        ${dated && r.exception?.note ? `<div class="sp-grid__note">${esc(r.exception.note)}</div>` : ''}</th>`;
    }).join('');
    const body = lessonRows.map((row, ri) => {
      const label = row.empty ? esc(tr('grid.lessons'))
        : row.kind === 'break'
          ? `${esc(tr('type.break'))} <small>${esc(time(row.start))}–${esc(time(row.end))}</small>`
          : `${row.n ? `${esc(tr('grid.period', { n: row.n }))} ` : ''}<small>${esc(time(row.start))}–${esc(time(row.end))}</small>`;
      const cells = columns.map((c) => {
        const text = columnStatus(c);
        if (text !== null) {
          return ri === 0 ? `<td class="sp-grid__status" rowspan="${lessonRows.length}">${esc(text)}</td>` : '';
        }
        const cell = c.cells.get(ri);
        if (cell) {
          const seg = cell.seg;
          return `<td class="sp-grid__lesson"${cell.span > 1 ? ` rowspan="${cell.span}"` : ''}>
            <span class="sp-grid__title">${esc(seg.title || tr('type.lesson'))}</span>${seg.room ? `<span class="sp-grid__room">${esc(seg.room)}</span>` : ''}</td>`;
        }
        if (c.covered.has(ri)) return '';
        return `<td class="${row.kind === 'break' ? 'sp-grid__break' : 'sp-grid__free'}"></td>`;
      }).join('');
      return `<tr class="sp-grid__row sp-grid__row--${row.kind}"><th scope="row" class="sp-grid__slot">${label}</th>${cells}</tr>`;
    }).join('');
    const afternoon = columns.map((c) => {
      const items = [...c.extra, ...c.afternoon].sort((a, b) => a.start - b.start);
      return `<td class="sp-grid__after">${items.map((x) => `<div class="sp-grid__item sp-grid__item--${x.type}">
        <small>${esc(time(x.start))}–${esc(time(x.end))}</small> ${esc(what(x))}${x.place && x.place !== SCHOOL ? ` · ${esc(placeName(x.place))}` : ''}</div>`).join('')}</td>`;
    }).join('');
    const homeRow = columns.map((c) => {
      const r = c.result;
      if (r.status === STATUS.OK && r.home) return `<td class="sp-grid__home">${esc(time(r.home.minutes))}${r.home.mode === 'pickup' ? ` <small>${esc(tr('type.pickup'))}</small>` : ''}</td>`;
      if (r.status === STATUS.OPEN || r.status === STATUS.CONFLICT) {
        return `<td class="sp-grid__home sp-grid__home--open" title="${esc(r.reasons.map(reasonText).join(' '))}">${esc(tr('grid.open'))}</td>`;
      }
      return '<td class="sp-grid__home">–</td>';
    }).join('');
    const hasAfternoon = columns.some((c) => c.afternoon.length || c.extra.length);
    return `
      <div class="sp-gridwrap"><table class="sp-grid">
        <thead><tr><th class="sp-grid__corner" scope="col"><span class="sr-only">${esc(tr('grid.time'))}</span></th>${head}</tr></thead>
        <tbody>${body}
          ${hasAfternoon ? `<tr class="sp-grid__row sp-grid__row--after"><th scope="row" class="sp-grid__slot">${esc(tr('grid.afternoon'))}</th>${afternoon}</tr>` : ''}
          <tr class="sp-grid__row sp-grid__row--home"><th scope="row" class="sp-grid__slot">${esc(tr('grid.home'))}</th>${homeRow}</tr>
        </tbody>
      </table></div>`;
  }

  /** Eine Woche eines Kindes: Name, Klasse/Lehrkraft, Tabelle. */
  function personWeekHtml(p, monday, { heading = false } = {}) {
    const days = weekDays(p.user_id, monday);
    const plan = days.find((d) => d.result.plan)?.result.plan ?? null;
    const info = schoolInfo(plan);
    return `<section class="sp-person">
      ${heading ? `<h2 class="sp-person__name">${esc(p.display_name)}</h2>` : ''}
      ${info ? `<p class="sp-hint">${esc(info)}</p>` : ''}
      ${gridHtml(days)}</section>`;
  }

  function weekRange(monday) {
    return `${fmtDate(monday, { day: 'numeric', month: 'short' })} – ${fmtDate(addDays(monday, 6), { day: 'numeric', month: 'short', year: 'numeric' })}`;
  }

  function weekHtml() {
    const list = withPlans();
    if (!list.length) return `<p class="sp-message__text">${esc(tr(state.people.some((p) => p.access === 'write') ? 'today.none' : 'today.noPeople'))}</p>`;
    if (!list.some((p) => p.user_id === state.focus)) state.focus = list[0].user_id;
    const all = state.weekAll && list.length > 1;
    const monday = mondayOf(state.date);
    const chips = list.length > 1 ? `<div class="sp-chips">
      <button type="button" class="btn ${all ? 'btn--primary' : 'btn--secondary'} sp-chip" data-action="week-all" aria-pressed="${all}">${esc(tr('week.all'))}</button>
      ${list.map((p) => `<button type="button" class="btn ${!all && p.user_id === state.focus ? 'btn--primary' : 'btn--secondary'} sp-chip"
        data-action="focus" data-person="${p.user_id}" aria-pressed="${!all && p.user_id === state.focus}">${esc(p.display_name)}</button>`).join('')}</div>` : '';
    const shown = all ? list : [person(state.focus)];
    return `
      ${chips}
      <div class="sp-datenav">
        <button type="button" class="btn btn--secondary sp-icon" data-action="day" data-delta="-7" aria-label="${esc(tr('week.prev'))}"><i data-lucide="chevron-left" aria-hidden="true"></i></button>
        <p class="sp-dayname">${esc(weekRange(monday))}</p>
        <button type="button" class="btn btn--secondary sp-icon" data-action="day" data-delta="7" aria-label="${esc(tr('week.next'))}"><i data-lucide="chevron-right" aria-hidden="true"></i></button>
        <button type="button" class="btn btn--secondary" data-action="print-week"><i data-lucide="printer" aria-hidden="true"></i> ${esc(tr('action.pdf'))}</button>
      </div>
      ${holidayHint()}
      ${shown.map((p) => personWeekHtml(p, monday, { heading: all })).join('')}
      <p class="sp-note">${esc(tr('planNote'))}</p>`;
  }

  // ---- PDF (Drucken, immer Querformat) -------------------------------------

  /**
   * Druckt fertiges HTML ueber den Druckdialog des Browsers ("Als PDF
   * speichern"). Das Blatt haengt kurz direkt am <body>; style.css blendet beim
   * Drucken alles andere aus und setzt A4 quer.
   */
  function printPages(pages, title) {
    document.querySelector('.sp-print')?.remove();
    const root = document.createElement('div');
    root.className = 'sp-print';
    root.insertAdjacentHTML('beforeend', pages.map((pg) => `<section class="sp-print__page">${pg}
      <p class="sp-print__foot">${esc(tr('print.foot', { date: fmtDate(state.today, { day: 'numeric', month: 'long', year: 'numeric' }) }))}</p></section>`).join(''));
    document.body.append(root);
    document.documentElement.classList.add('sp-printing');
    const oldTitle = document.title;
    document.title = title;
    const done = () => {
      root.remove();
      document.documentElement.classList.remove('sp-printing');
      document.title = oldTitle;
    };
    window.addEventListener('afterprint', done, { once: true });
    window.print();
  }

  function printHead(name, sub, plan) {
    const info = schoolInfo(plan);
    return `<header class="sp-print__head"><h1>${esc(tr('title'))} · ${esc(name)}</h1>
      <p>${esc(sub)}${info ? ` · ${esc(info)}` : ''}</p></header>`;
  }

  function printWeek() {
    const list = withPlans();
    const shown = state.weekAll && list.length > 1 ? list : [person(state.focus)].filter(Boolean);
    const monday = mondayOf(state.date);
    const pages = shown.map((p) => {
      const days = weekDays(p.user_id, monday);
      const plan = days.find((d) => d.result.plan)?.result.plan ?? null;
      return printHead(p.display_name, tr('print.week', { range: weekRange(monday) }), plan) + gridHtml(days);
    });
    printPages(pages, `${tr('title')} ${shown.map((p) => p.display_name).join(', ')} ${monday}`);
  }

  /** Der allgemeine Plan ohne Datum - bei A/B-Wochen je eine Seite. */
  function printPlan(plan) {
    if (!plan) return;
    const p = person(state.focus);
    const open = { ...plan, valid_from: '0000-01-01', valid_to: '9999-12-31' };
    let mondays = [mondayOf(state.today)];
    if (plan.ab_anchor) {
      const m = mondays[0];
      mondays = abWeek(m, plan.ab_anchor) === 'A' ? [m, addDays(m, 7)] : [addDays(m, 7), m];
    }
    const range = tr('plans.range', { from: fmtDate(plan.valid_from, { day: 'numeric', month: 'short', year: 'numeric' }), to: fmtDate(plan.valid_to, { day: 'numeric', month: 'short', year: 'numeric' }) });
    const pages = mondays.map((monday, i) => {
      const days = [...Array(7)].map((_, d) => addDays(monday, d))
        .map((date) => ({ key: date, result: computeDay({ plans: [open], date, rasters: state.rasters }) }))
        .filter(({ key, result }) => weekday(key) <= 5 || result.segments.length);
      const sub = `${plan.label} · ${range}${plan.ab_anchor ? ` · ${tr('badge.week', { week: i === 0 ? 'A' : 'B' })}` : ''}`;
      return printHead(p?.display_name ?? '', sub, plan) + gridHtml(days, { dated: false });
    });
    printPages(pages, `${tr('title')} ${p?.display_name ?? ''} ${plan.label}`);
  }

  // ---- Plaene --------------------------------------------------------------

  function planState(p) {
    if (p.valid_to < state.today) return tr('plans.past');
    if (p.valid_from > state.today) return tr('plans.future', { from: fmtDate(p.valid_from, { day: 'numeric', month: 'short', year: 'numeric' }) });
    return tr('plans.active');
  }

  function plansHtml() {
    const list = editable();
    if (!list.length) return `<p class="sp-message__text">${esc(tr('today.noPeople'))}</p>`;
    if (!list.some((p) => p.user_id === state.focus)) state.focus = list[0].user_id;
    const id = state.focus;
    const plans = plansOf(id);
    const write = canWrite(id);
    const draft = state.draft?.personId === id ? state.draft : null;
    const items = plans.map((p) => {
      const clash = overlappingPlans(plans, p.valid_from, p.valid_to, p.id);
      const range = tr('plans.range', { from: fmtDate(p.valid_from, { day: 'numeric', month: 'short', year: 'numeric' }), to: fmtDate(p.valid_to, { day: 'numeric', month: 'short', year: 'numeric' }) });
      if (draft?.base?.id === p.id) return `<li class="sp-plan sp-plan--editing">${planEditorHtml(draft)}</li>`;
      return `
        <li class="sp-plan" data-plan="${esc(p.id)}">
          <div class="sp-plan__head">
            <div><p class="sp-plan__label">${esc(p.label)}</p>
              <p class="sp-plan__meta">${esc(range)} · ${esc(planState(p))}${p.class_name ? ` · ${esc(tr('school.class', { name: p.class_name }))}` : ''}${clash.length ? ` · <strong>${esc(tr('plans.overlap', { labels: clash.map((c) => c.label).join(', ') }))}</strong>` : ''}</p></div>
            ${!draft ? `<div class="sp-plan__tools">
              ${write ? `<button type="button" class="btn btn--secondary" data-action="edit-plan">${esc(tr('action.edit'))}</button>
              <button type="button" class="btn btn--secondary" data-action="copy-plan">${esc(tr('action.copyPlan'))}</button>` : ''}
              ${copyTargets().length ? `<button type="button" class="btn btn--secondary" data-action="copy-to">${esc(tr('action.copyTo'))}</button>` : ''}
              <button type="button" class="btn btn--secondary" data-action="print-plan"><i data-lucide="printer" aria-hidden="true"></i> ${esc(tr('action.pdf'))}</button></div>` : ''}
          </div>
          ${state.copyTo === p.id && !draft ? copyFormHtml() : ''}
        </li>`;
    }).join('');
    return `
      ${personChips(list)}
      ${write ? '' : `<p class="sp-hint">${esc(tr('plans.readonly'))}</p>`}
      <ul class="sp-plans">${items || `<li class="sp-message__text">${esc(tr('plans.none'))}</li>`}</ul>
      ${draft && !draft.base ? `<div class="sp-plan sp-plan--editing">${planEditorHtml(draft)}</div>` : ''}
      ${write && !draft ? `<button type="button" class="btn btn--primary sp-new" data-action="new-plan">${esc(tr('action.newPlan'))}</button>` : ''}
      ${rastersHtml()}`;
  }

  /** Kinder, fuer die man einen Plan anlegen darf - ohne das gerade gewaehlte. */
  function copyTargets() {
    return state.people.filter((p) => p.access === 'write' && p.user_id !== state.focus);
  }

  function copyFormHtml() {
    return `
      <form class="sp-planedit" data-action="copy-to" novalidate>
        <label class="sp-field"><span>${esc(tr('copy.target'))}</span>
          <select class="form-input" name="target">${copyTargets().map((p) => `<option value="${p.user_id}">${esc(p.display_name)}</option>`).join('')}</select></label>
        <label class="sp-check"><input type="checkbox" name="care" checked> ${esc(tr('copy.care'))}</label>
        <label class="sp-check"><input type="checkbox" name="projects"> ${esc(tr('copy.projects'))}</label>
        <p class="sp-hint">${esc(tr('copy.intro'))}</p>
        <div class="sp-actions">
          <button type="submit" class="btn btn--primary">${esc(tr('copy.start'))}</button>
          <button type="button" class="btn btn--secondary" data-action="cancel-copy">${esc(tr('action.cancel'))}</button>
        </div>
      </form>`;
  }

  function startCopy(form) {
    const base = plansOf(state.focus).find((p) => p.id === state.copyTo);
    const target = Number(form.elements.target.value);
    if (!base || !canWrite(target)) return;
    const plan = copyPlanFor(base, { care: form.elements.care.checked, projects: form.elements.projects.checked });
    state.copyTo = null;
    state.focus = target;
    state.draft = { personId: target, base: null, plan, hint: tr('copy.hint', { name: person(target)?.display_name ?? '' }) };
    renderAll();
  }

  // ---- Stundenraster (haushaltsweit) ---------------------------------------

  function rastersHtml() {
    const d = state.rasterDraft;
    const items = state.rasters.map((r) => (d?.base?.id === r.id
      ? `<li class="sp-plan sp-plan--editing">${rasterEditorHtml(d)}</li>`
      : `<li class="sp-plan" data-raster="${esc(r.id)}"><div class="sp-plan__head">
          <div><p class="sp-plan__label">${esc(r.name)}</p>
            <p class="sp-plan__meta">${esc(tr('raster.meta', { count: r.periods.length, from: r.periods[0]?.start ?? '', to: r.periods.at(-1)?.end ?? '' }))}</p></div>
          ${state.sharedWrite && !d ? `<div class="sp-plan__tools"><button type="button" class="btn btn--secondary" data-action="edit-raster">${esc(tr('action.edit'))}</button></div>` : ''}
        </div></li>`)).join('');
    return `
      <section class="sp-rasters">
        <h2 class="sp-section">${esc(tr('raster.title'))}</h2>
        <p class="sp-hint">${esc(tr('raster.intro'))}</p>
        <ul class="sp-plans">${items || `<li class="sp-message__text">${esc(tr('raster.none'))}</li>`}</ul>
        ${d && !d.base ? `<div class="sp-plan sp-plan--editing">${rasterEditorHtml(d)}</div>` : ''}
        ${state.sharedWrite && !d ? `<button type="button" class="btn btn--secondary sp-new" data-action="new-raster">${esc(tr('raster.new'))}</button>` : ''}
      </section>`;
  }

  function rasterEditorHtml(d) {
    const r = d.raster;
    return `
      <form class="sp-planedit" data-action="save-raster" novalidate>
        <label class="sp-field"><span>${esc(tr('raster.name'))}</span>
          <input class="form-input" maxlength="80" placeholder="${esc(tr('raster.namePlaceholder'))}" data-rbind="name" value="${esc(r.name)}"></label>
        ${r.periods.map((p, i) => `
          <div class="sp-entry sp-entry--period">
            <span class="sp-rowlabel">${esc(tr('period.n', { n: p.n }))}</span>
            <input type="time" class="form-input" aria-label="${esc(tr('field.start'))}" data-rbind="periods.${i}.start" value="${esc(p.start)}">
            <input type="time" class="form-input" aria-label="${esc(tr('field.end'))}" data-rbind="periods.${i}.end" value="${esc(p.end)}">
            <button type="button" class="btn btn--secondary sp-icon" data-action="remove-period" data-index="${i}" aria-label="${esc(tr('action.remove'))}"><i data-lucide="x" aria-hidden="true"></i></button>
          </div>`).join('')}
        <div class="sp-actions sp-actions--add"><button type="button" class="btn btn--secondary" data-action="add-period">${esc(tr('raster.addPeriod'))}</button></div>
        <p class="sp-error" role="alert" hidden></p>
        <div class="sp-actions">
          <button type="submit" class="btn btn--primary">${esc(tr('action.save'))}</button>
          <button type="button" class="btn btn--secondary" data-action="cancel-raster">${esc(tr('action.cancel'))}</button>
          ${d.base ? `<button type="button" class="btn btn--danger-outline sp-actions__end" data-action="delete-raster">${esc(tr('action.delete'))}</button>` : ''}
        </div>
      </form>`;
  }

  async function saveRaster(form) {
    const d = state.rasterDraft;
    const errorEl = form.querySelector('.sp-error');
    const raster = { ...d.raster, name: String(d.raster.name ?? '').trim(), periods: d.raster.periods.map((p, i) => ({ ...p, n: i + 1 })) };
    const problems = validateRaster(raster);
    if (problems.length) { errorEl.textContent = problems.map((x) => tr(`problem.${x.code}`, { n: x.n })).join(' '); errorEl.hidden = false; return; }
    try {
      if (d.base) await store.update(d.base, raster);
      else await store.create(null, raster);
      state.rasters = await store.loadShared({ signal });
      if (signal?.aborted) return;
      state.rasterDraft = null;
      renderAll();
      showToast(tr('toast.saved'), 'success');
    } catch (err) {
      if (signal?.aborted) return;
      if (err?.reason === 'conflict' || err?.reason === 'not_found') {
        state.rasters = await store.loadShared({ signal }).catch(() => state.rasters);
        const fresh = d.base ? state.rasters.find((x) => x.id === d.base.id) : null;
        state.rasterDraft = fresh ? { base: fresh, raster: dataOf(structuredClone(fresh)) } : null;
        renderAll();
        showToast(tr(fresh ? 'error.conflict' : 'error.gone'), 'warning', 6000);
        return;
      }
      errorEl.textContent = errorText(err);
      errorEl.hidden = false;
    }
  }

  async function deleteRaster() {
    const d = state.rasterDraft;
    if (!d?.base) return;
    try {
      await store.remove(d.base);
      showToast(tr('toast.deleted'), 'default');
    } catch (err) {
      if (err?.reason === 'conflict') showToast(tr('error.conflict'), 'warning', 6000);
      else if (err?.reason !== 'not_found') showToast(errorText(err), 'danger');
    }
    state.rasters = await store.loadShared({ signal }).catch(() => state.rasters);
    if (signal?.aborted) return;
    state.rasterDraft = null;
    renderAll();
  }

  /** Alle Orte, die im Plan vorkommen - fuer jeden braucht es eine Heimwegdauer. */
  function placesOf(plan) {
    const set = new Set([SCHOOL]);
    for (const d of WEEKDAYS) {
      for (const e of [...(plan.days[d]?.care ?? []), ...(plan.days[d]?.projects ?? [])]) set.add((e.place ?? '').trim());
    }
    return [...set];
  }

  function planEditorHtml(draft) {
    const p = draft.plan;
    const ab = Boolean(p.ab_anchor);
    const bind = (path, type, extra = '') => `data-bind="${path}" data-kind="${type}"${extra}`;
    const val = (path) => esc(getPath(p, path) ?? '');
    const weeksSel = (path) => (ab ? `<select class="form-input sp-weeks" ${bind(path, 'weeks')} aria-label="${esc(tr('field.weeks'))}">${['all', 'A', 'B'].map((w) =>
      `<option value="${w}"${(getPath(p, path) ?? 'all') === w ? ' selected' : ''}>${esc(tr(`weeks.${w}`))}</option>`).join('')}</select>` : '');
    const raster = p.periods_id ? state.rasters.find((x) => x.id === p.periods_id) : null;
    // "von" zeigt den Beginn der Stunde, "bis" ihr Ende - so passt es in ein schmales Feld.
    const periodSel = (path, value, which) => `<select class="form-input sp-period" aria-label="${esc(tr(which === 'from' ? 'field.start' : 'field.end'))}" ${bind(path, 'int')}>${(raster?.periods ?? []).map((pp) =>
      `<option value="${pp.n}"${value === pp.n ? ' selected' : ''}>${esc(tr(`period.${which}`, { n: pp.n, start: pp.start, end: pp.end }))}</option>`).join('')}</select>`;
    const row = (type, d, i, e) => {
      const base = `days.${d}.${type}.${i}`;
      const byPeriod = type === 'lessons' && (e.period_from !== undefined);
      const titleField = type === 'lessons'
        ? `<input class="form-input sp-grow" placeholder="${esc(tr('field.subject'))}" aria-label="${esc(tr('field.subject'))}" maxlength="80" ${bind(`${base}.title`, 'text')} value="${val(`${base}.title`)}">`
        : type === 'projects'
          ? `<input class="form-input sp-grow" placeholder="${esc(tr('field.projectTitle'))}" aria-label="${esc(tr('type.project'))}" maxlength="80" ${bind(`${base}.title`, 'text')} value="${val(`${base}.title`)}">`
          : `<span class="sp-grow sp-rowlabel">${esc(tr('type.care'))}</span>`;
      const placeField = type === 'lessons'
        ? `<input class="form-input sp-small" placeholder="${esc(tr('field.room'))}" aria-label="${esc(tr('field.room'))}" maxlength="80" ${bind(`${base}.room`, 'text')} value="${val(`${base}.room`)}">`
        : `<input class="form-input sp-small" placeholder="${esc(tr('field.placeSchool'))}" aria-label="${esc(tr('field.place'))}" maxlength="80" ${bind(`${base}.place`, 'text', ' data-rerender="1"')} value="${val(`${base}.place`)}">`;
      return `<div class="sp-entry">
        ${titleField}
        ${byPeriod
          ? `${periodSel(`${base}.period_from`, e.period_from, 'from')}${periodSel(`${base}.period_to`, e.period_to ?? e.period_from, 'to')}`
          : `<input type="time" class="form-input" aria-label="${esc(tr('field.start'))}" ${bind(`${base}.start`, 'time')} value="${val(`${base}.start`)}">
        <input type="time" class="form-input" aria-label="${esc(tr('field.end'))}" ${bind(`${base}.end`, 'time')} value="${val(`${base}.end`)}">`}
        ${placeField}${weeksSel(`${base}.weeks`)}
        <button type="button" class="btn btn--secondary sp-icon" data-action="remove-row" data-path="days.${d}.${type}" data-index="${i}" aria-label="${esc(tr('action.remove'))}"><i data-lucide="x" aria-hidden="true"></i></button>
      </div>`;
    };
    const days = WEEKDAYS.filter((d) => Number(d) <= 5 || state.showWeekend
      || (p.days[d]?.lessons?.length || p.days[d]?.care?.length || p.days[d]?.projects?.length)).map((d) => {
      const day = p.days[d] ?? emptyDay();
      const end = day.end ?? { mode: 'home' };
      return `
        <fieldset class="sp-dayedit">
          <legend>${esc(tr(`weekday.${d}`))}</legend>
          ${(day.lessons ?? []).map((e, i) => row('lessons', d, i, e)).join('')}
          ${(day.care ?? []).map((e, i) => row('care', d, i, e)).join('')}
          ${(day.projects ?? []).map((e, i) => row('projects', d, i, e)).join('')}
          <div class="sp-actions sp-actions--add">
            <button type="button" class="btn btn--secondary" data-action="add-row" data-path="days.${d}.lessons">${esc(tr('action.addLesson'))}</button>
            <button type="button" class="btn btn--secondary" data-action="add-row" data-path="days.${d}.care">${esc(tr('action.addCare'))}</button>
            <button type="button" class="btn btn--secondary" data-action="add-row" data-path="days.${d}.projects">${esc(tr('action.addProject'))}</button>
            ${d !== '1' ? `<button type="button" class="btn btn--ghost" data-action="like-monday" data-day="${d}">${esc(tr('action.likeMonday'))}</button>` : ''}
          </div>
          <div class="sp-row sp-dayend">
            <span>${esc(tr('field.dayEnd'))}</span>
            <select class="form-input" ${bind(`days.${d}.end.mode`, 'text', ' data-rerender="1"')}>
              ${['home', 'pickup'].map((m) => `<option value="${m}"${end.mode === m ? ' selected' : ''}>${esc(tr(`dayEnd.${m}`))}</option>`).join('')}
            </select>
            ${end.mode === 'pickup' ? `
              <label class="sp-mini">${esc(tr('field.pickup'))}<input type="time" class="form-input" ${bind(`days.${d}.end.pickup`, 'time')} value="${val(`days.${d}.end.pickup`)}"></label>
              <label class="sp-mini">${esc(tr('field.drive'))}<input type="number" min="0" max="600" class="form-input" ${bind(`days.${d}.end.drive`, 'int')} value="${val(`days.${d}.end.drive`)}"></label>
              <label class="sp-mini">${esc(tr('field.homeTime'))}<input type="time" class="form-input" ${bind(`days.${d}.end.home`, 'time')} value="${val(`days.${d}.end.home`)}"></label>` : ''}
          </div>
        </fieldset>`;
    }).join('');
    return `
      <form class="sp-planedit" data-action="save-plan" novalidate>
        ${draft.hint ? `<p class="sp-hint sp-hint--strong">${esc(draft.hint)}</p>` : ''}
        <label class="sp-field"><span>${esc(tr('field.label'))}</span>
          <input class="form-input" maxlength="80" placeholder="${esc(tr('field.labelPlaceholder'))}" ${bind('label', 'text')} value="${val('label')}"></label>
        <div class="sp-row">
          <label class="sp-field"><span>${esc(tr('field.from'))}</span><input type="date" class="form-input" ${bind('valid_from', 'text')} value="${val('valid_from')}"></label>
          <label class="sp-field"><span>${esc(tr('field.to'))}</span><input type="date" class="form-input" ${bind('valid_to', 'text')} value="${val('valid_to')}"></label>
        </div>
        <label class="sp-field"><span>${esc(tr('raster.select'))}</span>
          <select class="form-input" ${bind('periods_id', 'text', ' data-rerender="1"')}>
            <option value="">${esc(tr('raster.noneSelected'))}</option>
            ${state.rasters.map((r) => `<option value="${esc(r.id)}"${p.periods_id === r.id ? ' selected' : ''}>${esc(r.name)}</option>`).join('')}
          </select></label>
        <fieldset class="sp-group"><legend>${esc(tr('field.school'))}</legend>
          <label class="sp-mini">${esc(tr('field.class'))}
            <input class="form-input sp-class" maxlength="20" placeholder="${esc(tr('field.classPlaceholder'))}" ${bind('class_name', 'text')} value="${val('class_name')}"></label>
          ${(p.teachers ?? []).map((x, i) => `<div class="sp-row">
            <label class="sp-field"><span>${esc(tr('field.teacherName'))}</span>
              <input class="form-input" maxlength="80" ${bind(`teachers.${i}.name`, 'text')} value="${val(`teachers.${i}.name`)}"></label>
            <label class="sp-field"><span>${esc(tr('field.teacherContact'))}</span>
              <input class="form-input" maxlength="80" ${bind(`teachers.${i}.contact`, 'text')} value="${val(`teachers.${i}.contact`)}"></label>
            <button type="button" class="btn btn--secondary sp-icon" data-action="remove-row" data-path="teachers" data-index="${i}" aria-label="${esc(tr('action.remove'))}"><i data-lucide="x" aria-hidden="true"></i></button>
          </div>`).join('')}
          <div class="sp-actions sp-actions--add"><button type="button" class="btn btn--secondary" data-action="add-teacher">${esc(tr('action.addTeacher'))}</button></div>
        </fieldset>
        <fieldset class="sp-group"><legend>${esc(tr('field.travel'))}</legend>
          ${placesOf(p).map((place) => `<label class="sp-mini sp-travel">${esc(tr('field.travelFrom', { place: placeName(place) }))}
            <input type="number" min="0" max="600" inputmode="numeric" class="form-input" data-travel="${esc(place)}" value="${esc(p.travel?.[place] ?? '')}"> ${esc(tr('field.minutes'))}</label>`).join('')}
        </fieldset>
        <fieldset class="sp-group"><legend>${esc(tr('field.holidays'))}</legend>
          ${['care', 'projects'].map((cat) => `<label class="sp-mini">${esc(tr(cat === 'care' ? 'field.holidaysCare' : 'field.holidaysProjects'))}
            <select class="form-input" ${bind(`holidays.${cat}`, 'text')}>${['yes', 'no', 'ask'].map((v) => `<option value="${v}"${(p.holidays?.[cat] ?? 'ask') === v ? ' selected' : ''}>${esc(tr(`holidayRule.${v}`))}</option>`).join('')}</select></label>`).join('')}
        </fieldset>
        <fieldset class="sp-group"><legend>${esc(tr('field.ab'))}</legend>
          <label class="sp-check"><input type="checkbox" data-action="toggle-ab"${ab ? ' checked' : ''}> ${esc(tr('field.ab'))}</label>
          ${ab ? `<label class="sp-mini">${esc(tr('field.abAnchor'))}<input type="date" class="form-input" ${bind('ab_anchor', 'text')} value="${val('ab_anchor')}"></label>
            <p class="sp-hint">${esc(tr('field.abHint'))}</p>` : ''}
        </fieldset>
        ${days}
        ${state.showWeekend ? '' : `<button type="button" class="btn btn--ghost" data-action="show-weekend">${esc(tr('action.showWeekend'))}</button>`}
        <p class="sp-error" role="alert" hidden></p>
        <div class="sp-actions sp-actions--sticky">
          <button type="submit" class="btn btn--primary">${esc(tr('action.save'))}</button>
          <button type="button" class="btn btn--secondary" data-action="cancel-plan">${esc(tr('action.cancel'))}</button>
          ${draft.base ? `<button type="button" class="btn btn--danger-outline sp-actions__end" data-action="delete-plan">${esc(tr('action.delete'))}</button>` : ''}
        </div>
      </form>`;
  }

  function cleanPlanForSave(plan) {
    const p = structuredClone(plan);
    for (const d of WEEKDAYS) {
      const day = p.days[d] ?? emptyDay();
      for (const key of ['lessons', 'care', 'projects']) {
        day[key] = (day[key] ?? []).map((e) => {
          const out = { ...e };
          for (const f of ['title', 'room', 'place']) {
            if (typeof out[f] === 'string') out[f] = out[f].trim();
            if (out[f] === '') delete out[f];
          }
          if (!p.ab_anchor || out.weeks === 'all') delete out.weeks;
          return out;
        });
      }
      if (day.end?.mode !== 'pickup') day.end = { mode: 'home' };
      else {
        for (const f of ['pickup', 'home']) if (!day.end[f]) delete day.end[f];
        if (!Number.isInteger(day.end.drive)) delete day.end.drive;
      }
      p.days[d] = day;
    }
    const used = new Set(placesOf(p));
    for (const key of Object.keys(p.travel ?? {})) if (!used.has(key)) delete p.travel[key];
    if (!p.ab_anchor) p.ab_anchor = null;
    if (!p.periods_id) p.periods_id = null;
    for (const d of WEEKDAYS) {
      p.days[d].lessons = p.days[d].lessons.map((e) => {
        if (e.period_from === undefined) return e;
        const { start: _s, end: _e, ...rest } = e;
        return { ...rest, period_to: Math.max(rest.period_to ?? rest.period_from, rest.period_from) };
      });
    }
    p.label = String(p.label ?? '').trim();
    p.class_name = String(p.class_name ?? '').trim();
    if (!p.class_name) delete p.class_name;
    p.teachers = cleanTeachers(p.teachers);
    if (!p.teachers.length) delete p.teachers;
    return p;
  }

  async function savePlan(form) {
    const draft = state.draft;
    const errorEl = form.querySelector('.sp-error');
    const fail = (text) => { errorEl.textContent = text; errorEl.hidden = false; };
    const plan = cleanPlanForSave(draft.plan);
    const others = plansOf(draft.personId).filter((p) => p.id !== draft.base?.id);
    const problems = validatePlan({ ...plan, id: draft.base?.id }, others);
    if (problems.length) {
      return fail(problems.map((x) => tr(`problem.${x.code}`, {
        ...x, day: x.day ? tr(`weekday.${x.day}`) : '', labels: (x.labels ?? []).join(', '), place: placeName(x.place),
      })).join(' '));
    }
    try {
      if (draft.base) await store.update(draft.base, plan);
      else await store.create(draft.personId, plan);
      await loadPerson(draft.personId);
      if (signal?.aborted) return;
      state.draft = null;
      renderAll();
      showToast(tr('toast.saved'), 'success');
    } catch (err) {
      if (signal?.aborted) return;
      if ((err?.reason === 'conflict' || err?.reason === 'not_found') && draft.base) {
        // Nie still mit der neuen Revision nachschreiben: aktuelle Fassung zeigen.
        const fresh = await store.get(draft.base.id).catch(() => null);
        await loadPerson(draft.personId).catch(() => {});
        state.draft = fresh ? { personId: draft.personId, base: fresh, plan: dataOf(fresh) } : null;
        renderAll();
        const msg = main.querySelector('.sp-planedit .sp-error');
        if (msg) { msg.textContent = tr('error.conflict'); msg.hidden = false; } else showToast(tr('error.gone'), 'warning', 6000);
        return;
      }
      fail(errorText(err));
    }
  }

  async function deletePlan() {
    const draft = state.draft;
    if (!draft?.base) return;
    try {
      await store.remove(draft.base);
      showToast(tr('toast.deleted'), 'default');
    } catch (err) {
      if (err?.reason === 'conflict') showToast(tr('error.conflict'), 'warning', 6000);
      else if (err?.reason !== 'not_found') showToast(errorText(err), 'danger');
    }
    await loadPerson(draft.personId).catch(() => {});
    if (signal?.aborted) return;
    state.draft = null;
    renderAll();
  }

  function rerenderEditor() {
    const y = window.scrollY;
    renderAll();
    window.scrollTo(0, y);
  }

  // ------------------------------------------------------------------
  // Ereignisse
  // ------------------------------------------------------------------

  async function moveDate(date) {
    state.date = date;
    state.exEdit = null;
    try { await ensureHolidays(date); } catch { /* bleibt bei 'unknown' */ }
    if (!signal?.aborted) renderAll();
  }

  container.addEventListener('input', (e) => {
    const el = e.target;
    if (el.dataset.rbind && state.rasterDraft) { setPath(state.rasterDraft.raster, el.dataset.rbind, el.value); return; }
    if (!state.draft) return;
    if (el.dataset.bind) {
      let v = el.value;
      if (el.dataset.kind === 'int') v = v === '' ? undefined : Number(v);
      setPath(state.draft.plan, el.dataset.bind, v);
    } else if (el.dataset.travel !== undefined) {
      state.draft.plan.travel ??= {};
      if (el.value === '') delete state.draft.plan.travel[el.dataset.travel];
      else state.draft.plan.travel[el.dataset.travel] = Number(el.value);
    }
  }, { signal });

  container.addEventListener('change', (e) => {
    const el = e.target;
    if (el.dataset.action === 'pick-date' && el.value) { moveDate(el.value); return; }
    if (el.dataset.action === 'toggle-ab' && state.draft) {
      state.draft.plan.ab_anchor = el.checked ? mondayOf(state.today) : null;
      rerenderEditor();
      return;
    }
    if (el.tagName === 'SELECT' && el.dataset.bind && state.draft) {
      setPath(state.draft.plan, el.dataset.bind, el.dataset.kind === 'int' ? Number(el.value) : el.value);
    }
    if (el.dataset.rerender && state.draft) { rerenderEditor(); return; }
    if (el.form?.classList.contains('sp-ex')) applyConditional(main);
  }, { signal });

  container.addEventListener('submit', (e) => {
    const form = e.target;
    e.preventDefault();
    if (form.dataset.action === 'save-exception') saveException(form);
    else if (form.dataset.action === 'save-plan') savePlan(form);
    else if (form.dataset.action === 'save-raster') saveRaster(form);
    else if (form.dataset.action === 'copy-to') startCopy(form);
  }, { signal });

  container.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el || !container.contains(el) || el.tagName === 'INPUT' || el.tagName === 'FORM') return;
    const card = el.closest('[data-person]');
    switch (el.dataset.action) {
      case 'retry': load(); break;
      case 'view':
        state.view = el.dataset.view;
        storeView(state.view);
        state.draft = null;
        state.rasterDraft = null;
        state.exEdit = null;
        state.copyTo = null;
        renderAll();
        break;
      case 'day': moveDate(addDays(state.date, Number(el.dataset.delta))); break;
      case 'today': moveDate(state.today); break;
      case 'focus': state.focus = Number(el.dataset.person); state.weekAll = false; state.draft = null; state.copyTo = null; renderAll(); break;
      case 'week-all': state.weekAll = true; renderAll(); break;
      case 'copy-to': state.copyTo = el.closest('[data-plan]').dataset.plan; renderAll(); break;
      case 'cancel-copy': state.copyTo = null; renderAll(); break;
      case 'print-week': printWeek(); break;
      case 'print-plan': printPlan(plansOf(state.focus).find((p) => p.id === el.closest('[data-plan]').dataset.plan)); break;
      case 'add-teacher': (state.draft.plan.teachers ??= []).push({ name: '', contact: '' }); rerenderEditor(); break;
      case 'exception': state.exEdit = { personId: Number(card.dataset.person), date: state.date }; renderAll(); break;
      case 'cancel-exception': state.exEdit = null; renderAll(); break;
      case 'delete-exception': deleteException(Number(el.closest('form').dataset.person)); break;
      case 'new-plan': {
        const year = Number(state.today.slice(0, 4));
        state.draft = { personId: state.focus, base: null, plan: emptyPlan({ validFrom: state.today, validTo: `${year + 1}-07-31` }) };
        renderAll();
        break;
      }
      case 'edit-plan': {
        const base = plansOf(state.focus).find((p) => p.id === el.closest('[data-plan]').dataset.plan);
        state.draft = { personId: state.focus, base, plan: dataOf(structuredClone(base)) };
        renderAll();
        break;
      }
      case 'copy-plan': {
        const base = plansOf(state.focus).find((p) => p.id === el.closest('[data-plan]').dataset.plan);
        const from = addDays(base.valid_to, 1);
        const to = `${Number(from.slice(0, 4)) + 1}-${base.valid_to.slice(5)}`;
        state.draft = { personId: state.focus, base: null, plan: copyPlan(base, { label: '', validFrom: from, validTo: to > from ? to : addDays(from, 364) }) };
        renderAll();
        break;
      }
      case 'cancel-plan': state.draft = null; renderAll(); break;
      case 'new-raster': state.rasterDraft = { base: null, raster: emptyRaster('') }; renderAll(); break;
      case 'edit-raster': {
        const base = state.rasters.find((x) => x.id === el.closest('[data-raster]').dataset.raster);
        state.rasterDraft = { base, raster: dataOf(structuredClone(base)) };
        renderAll();
        break;
      }
      case 'cancel-raster': state.rasterDraft = null; renderAll(); break;
      case 'delete-raster': deleteRaster(); break;
      case 'add-period': state.rasterDraft.raster.periods.push(nextPeriod(state.rasterDraft.raster.periods)); rerenderEditor(); break;
      case 'remove-period': state.rasterDraft.raster.periods.splice(Number(el.dataset.index), 1); rerenderEditor(); break;
      case 'delete-plan': deletePlan(); break;
      case 'show-weekend': state.showWeekend = true; rerenderEditor(); break;
      case 'add-row': {
        const list = getPath(state.draft.plan, el.dataset.path);
        const type = el.dataset.path.split('.').pop();
        const prev = list.at(-1);
        const start = prev?.end ?? (type === 'lessons' ? '08:00' : '');
        const raster = state.draft.plan.periods_id ? state.rasters.find((x) => x.id === state.draft.plan.periods_id) : null;
        if (type === 'lessons' && raster?.periods?.length) {
          const next = Math.min((prev?.period_to ?? 0) + 1, raster.periods.at(-1).n);
          list.push({ period_from: next, period_to: raster.periods.at(-1).n, title: '' });
        } else {
          list.push(type === 'lessons' ? { start, end: '', title: '' } : type === 'care' ? { start, end: '' } : { start, end: '', title: '' });
        }
        rerenderEditor();
        break;
      }
      case 'remove-row': getPath(state.draft.plan, el.dataset.path).splice(Number(el.dataset.index), 1); rerenderEditor(); break;
      case 'like-monday': state.draft.plan.days[el.dataset.day] = structuredClone(state.draft.plan.days['1']); rerenderEditor(); break;
      default: break;
    }
  }, { signal });

  // Die Uhr laeuft weiter: "jetzt laut Plan" jede Minute neu - nur in der Heute-Ansicht.
  const timer = setInterval(() => {
    const now = nowInZone(state.tz);
    const dayChanged = now.date !== state.today;
    const wasToday = state.date === state.today;
    state.nowMin = now.minutes;
    state.today = now.date;
    if (dayChanged && wasToday) state.date = now.date;
    if (state.view === 'today' && !state.exEdit && !main.querySelector('form')) renderAll();
  }, 60_000);
  signal?.addEventListener('abort', () => clearInterval(timer));

  await load();
}

