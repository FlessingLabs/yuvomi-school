/**
 * Stundenplan - Plaene und Ausnahmen pruefen, anlegen, kopieren
 *
 * Yuvomi speichert nur JSON; was ein gueltiger Plan ist, steht hier. Die Pruefung
 * meldet Probleme, sie repariert nichts still: ein Plan mit Fehler wird nicht
 * gespeichert, und die Person sieht, was fehlt.
 */
import { toMinutes, isDate } from './time.js';
import { SCHOOL } from './day.js';

export const WEEKDAYS = ['1', '2', '3', '4', '5', '6', '7'];
const MAX_TEXT = 80;

export function emptyDay() {
  return { lessons: [], care: [], projects: [], end: { mode: 'home' } };
}

export function emptyPlan({ label = '', validFrom = '', validTo = '' } = {}) {
  const days = {};
  for (const d of WEEKDAYS) days[d] = emptyDay();
  return {
    kind: 'plan', v: 1, label, valid_from: validFrom, valid_to: validTo,
    ab_anchor: null, travel: { [SCHOOL]: 15 }, holidays: { care: 'ask', projects: 'ask' }, days,
  };
}

/** Kopie als Vorlage fuer einen neuen Zeitraum (z. B. das naechste Schuljahr). */
export function copyPlan(plan, { label, validFrom, validTo }) {
  const { id, revision, subject_id: _s, ...data } = structuredClone(plan);
  return { ...data, label, valid_from: validFrom, valid_to: validTo };
}

/**
 * Kopie fuer ein anderes Kind: gleicher Unterricht, gleicher Zeitraum.
 * Betreuung und Projekte nur, wenn gewuenscht - Geschwister teilen oft den
 * Stundenplan, aber nicht die Nachmittage.
 */
export function copyPlanFor(plan, { care = true, projects = false } = {}) {
  const { id, revision, subject_id: _s, ...data } = structuredClone(plan);
  for (const d of WEEKDAYS) {
    const day = data.days?.[d];
    if (!day) continue;
    if (!care) day.care = [];
    if (!projects) day.projects = [];
  }
  return data;
}

/** Lehrkraefte ohne leere Zeilen, Texte getrimmt. */
export function cleanTeachers(list) {
  return (list ?? [])
    .map((x) => ({ name: String(x?.name ?? '').trim(), contact: String(x?.contact ?? '').trim() }))
    .filter((x) => x.name || x.contact)
    .map((x) => (x.contact ? x : { name: x.name }));
}

/** Plaene, deren Zeitraum sich mit [from, to] ueberschneidet (ohne `exceptId`). */
export function overlappingPlans(plans, from, to, exceptId = null) {
  return plans.filter((p) => p.id !== exceptId && p.valid_from <= to && from <= p.valid_to);
}

/**
 * Probleme eines Plans als Liste von `{ code, ... }`. Leer heisst: speicherbar.
 * `others` sind die uebrigen Plaene desselben Kindes (Ueberschneidung).
 */
export function validatePlan(plan, others = []) {
  const problems = [];
  const add = (code, params = {}) => problems.push({ code, ...params });
  if (!String(plan.label ?? '').trim()) add('label_missing');
  if (!isDate(plan.valid_from) || !isDate(plan.valid_to)) add('range_missing');
  else if (plan.valid_to < plan.valid_from) add('range_reversed');
  else {
    const clash = overlappingPlans(others, plan.valid_from, plan.valid_to, plan.id);
    if (clash.length) add('range_overlaps', { labels: clash.map((p) => p.label) });
  }
  if (String(plan.class_name ?? '').length > 20) add('class_long');
  for (const x of plan.teachers ?? []) {
    if (!String(x.name ?? '').trim()) add('teacher_name_missing');
    if (String(x.name ?? '').length > MAX_TEXT || String(x.contact ?? '').length > MAX_TEXT) add('teacher_long');
  }
  if (plan.ab_anchor !== null && plan.ab_anchor !== undefined && !isDate(plan.ab_anchor)) add('ab_anchor_invalid');
  for (const [place, minutes] of Object.entries(plan.travel ?? {})) {
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 600) add('travel_invalid', { place });
  }
  for (const d of WEEKDAYS) {
    const day = plan.days?.[d] ?? {};
    const check = (type, e) => {
      if (type === 'lesson' && (e.period_from !== undefined || e.period_to !== undefined)) {
        const from = e.period_from;
        const to = e.period_to ?? e.period_from;
        if (!plan.periods_id) add('periods_without_raster', { day: d });
        if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1) add('entry_time', { day: d, type });
        else if (to < from) add('entry_order', { day: d, type });
      } else {
        const s = toMinutes(e.start);
        const en = toMinutes(e.end);
        if (s === null || en === null) add('entry_time', { day: d, type });
        else if (en <= s) add('entry_order', { day: d, type });
      }
      if ((type === 'lesson' || type === 'project') && !String(e.title ?? '').trim()) add('entry_title', { day: d, type });
      for (const f of ['title', 'room', 'place']) if (String(e[f] ?? '').length > MAX_TEXT) add('entry_long', { day: d, type });
      if (!['all', 'A', 'B', undefined].includes(e.weeks)) add('entry_weeks', { day: d, type });
    };
    for (const e of day.lessons ?? []) check('lesson', e);
    for (const e of day.care ?? []) check('care', e);
    for (const e of day.projects ?? []) check('project', e);
    const end = day.end;
    if (end?.mode === 'pickup') {
      const hasHome = toMinutes(end.home) !== null;
      const hasPickup = toMinutes(end.pickup) !== null && Number.isInteger(end.drive);
      const hasEntries = (day.lessons?.length || day.care?.length || day.projects?.length);
      if (hasEntries && !hasHome && !hasPickup) add('pickup_incomplete', { day: d });
    }
  }
  return problems;
}

/** Ausnahme pruefen; leer heisst speicherbar. */
export function validateException(ex) {
  const problems = [];
  if (!isDate(ex.date)) problems.push({ code: 'date_missing' });
  const times = [];
  if (ex.lessons?.end) times.push(ex.lessons.end);
  if (ex.care && !ex.care.cancelled) times.push(ex.care.start, ex.care.end);
  for (const c of Object.values(ex.projects ?? {})) if (c && !c.cancelled) times.push(c.start, c.end);
  if (ex.end?.mode === 'pickup') {
    if (ex.end.home) times.push(ex.end.home);
    else times.push(ex.end.pickup);
  }
  if (times.some((t) => toMinutes(t) === null)) problems.push({ code: 'time_invalid' });
  if (String(ex.note ?? '').length > 200) problems.push({ code: 'note_long' });
  return problems;
}

/** Eine Ausnahme, die nichts aendert, braucht keinen Datensatz. */
export function isEmptyException(ex) {
  return (!ex.day || ex.day === 'normal') && !ex.lessons && !ex.care
    && !Object.keys(ex.projects ?? {}).length && !ex.end && !String(ex.note ?? '').trim();
}

/** Ein leeres Stundenraster (haushaltsweit, fuer alle Kinder einer Schule). */
export function emptyRaster(name = '') {
  return { kind: 'periods', v: 1, name, periods: [{ n: 1, start: '08:00', end: '08:45' }] };
}

/**
 * Die naechste Stunde nach der letzten: gleiche Dauer, Pause wie zuletzt
 * (sonst 5 Minuten). Nur ein Vorschlag fuer das Formular.
 */
export function nextPeriod(periods) {
  const last = periods.at(-1);
  if (!last) return { n: 1, start: '08:00', end: '08:45' };
  const prev = periods.at(-2);
  const len = (toMinutes(last.end) ?? 0) - (toMinutes(last.start) ?? 0) || 45;
  const gap = prev ? Math.max(0, (toMinutes(last.start) ?? 0) - (toMinutes(prev.end) ?? 0)) : 5;
  const start = (toMinutes(last.end) ?? 0) + gap;
  const fmt = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return { n: last.n + 1, start: fmt(start), end: fmt(start + len) };
}

/** Probleme eines Stundenrasters; leer heisst speicherbar. */
export function validateRaster(raster) {
  const problems = [];
  if (!String(raster.name ?? '').trim()) problems.push({ code: 'raster_name_missing' });
  const periods = raster.periods ?? [];
  if (!periods.length) problems.push({ code: 'raster_empty' });
  let prevEnd = -1;
  const seen = new Set();
  for (const p of periods) {
    const s = toMinutes(p.start);
    const e = toMinutes(p.end);
    if (!Number.isInteger(p.n) || p.n < 1 || seen.has(p.n)) problems.push({ code: 'raster_number', n: p.n });
    seen.add(p.n);
    if (s === null || e === null || e <= s) problems.push({ code: 'raster_time', n: p.n });
    else if (s < prevEnd) problems.push({ code: 'raster_overlap', n: p.n });
    if (e !== null) prevEnd = e;
  }
  return problems;
}
