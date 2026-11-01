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
  if (plan.ab_anchor !== null && plan.ab_anchor !== undefined && !isDate(plan.ab_anchor)) add('ab_anchor_invalid');
  for (const [place, minutes] of Object.entries(plan.travel ?? {})) {
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 600) add('travel_invalid', { place });
  }
  for (const d of WEEKDAYS) {
    const day = plan.days?.[d] ?? {};
    const check = (type, e) => {
      const s = toMinutes(e.start);
      const en = toMinutes(e.end);
      if (s === null || en === null) add('entry_time', { day: d, type });
      else if (en <= s) add('entry_order', { day: d, type });
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
