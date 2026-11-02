/**
 * Stundenplan - ein Tag laut Plan
 *
 * `computeDay()` beantwortet fuer EIN Kind und EINEN Tag: welche Abschnitte
 * gelten (Unterricht, Betreuung, Projekte, Heimweg), wo Luecken sind, und wann
 * das Kind laut Plan nach Hause kommt - oder warum das offen bleibt.
 *
 * DAS IST EINE PLANZEIT. Kein Standort, keine Ankunftsbestaetigung. Die
 * Funktion rechnet nur, was ausdruecklich eingetragen ist:
 *
 *   - Heimkehr nur, wenn das Tagesende festgelegt ist (Heimweg mit Dauer ab dem
 *     letzten Ort, oder Abholung mit Heimkehrzeit bzw. Abholzeit + Fahrt).
 *   - Faellt etwas aus und sagt die Ausnahme nicht, was stattdessen gilt, bleibt
 *     die Heimkehr OFFEN. Ein ausgefallenes Projekt heisst nicht "frueher
 *     daheim" - das Kind koennte laenger in der Betreuung bleiben.
 *   - Eine Luecke zwischen zwei Eintraegen ist "keine Angabe", nie Betreuung.
 *   - Ein Tag ohne Eintrag ist "nichts eingetragen", nicht "schulfrei".
 *   - Widersprueche (Ueberschneidungen, Ende vor Beginn) machen den Tag offen.
 *
 * Datenformen (Datensaetze im Yuvomi-Modulspeicher, siehe lib/plan.js):
 *   Plan:      { kind:'plan', label, valid_from, valid_to, ab_anchor, travel, holidays, days }
 *   Ausnahme:  { kind:'exception', date, day, lessons, care, projects, end, note }
 */
import { toMinutes, weekday, abWeek } from './time.js';

/** Der Ort des Schulgebaeudes in `travel` - Unterricht findet immer dort statt. */
export const SCHOOL = '';

/** Ergebnis-Zustaende eines Tages. */
export const STATUS = Object.freeze({
  OK: 'ok',            // Heimkehr berechnet
  OPEN: 'open',        // Heimkehr offen - `reasons` sagen warum
  OFF: 'off',          // laut Plan nichts (Ferien, schulfrei, Unterricht faellt aus)
  EMPTY: 'empty',      // fuer diesen Wochentag ist nichts eingetragen
  NO_PLAN: 'no_plan',  // kein Plan gilt an diesem Tag
  CONFLICT: 'conflict', // mehrere Plaene gelten gleichzeitig
  ABSENT: 'absent',    // Ausnahme: das Kind ist an diesem Tag abwesend
});

function inWeek(entry, letter) {
  const w = entry?.weeks ?? 'all';
  return w === 'all' || letter === null || w === letter;
}

/** Plaene, deren Gueltigkeitszeitraum `date` enthaelt. */
export function plansFor(plans, date) {
  return plans.filter((p) => p.valid_from && p.valid_to && p.valid_from <= date && date <= p.valid_to);
}

/** Die Ausnahme fuer `date`, oder null. Mehrere fuer denselben Tag sind ein Widerspruch. */
export function exceptionsFor(exceptions, date) {
  return exceptions.filter((e) => e.date === date);
}

/**
 * Unterricht nach Stundenraster: `{ period_from: 1, period_to: 6 }` statt
 * Uhrzeiten. Die Zeiten kommen aus dem Raster, das der Plan nennt
 * (`plan.periods_id`) - aendert die Schule ihre Zeiten, aendert man nur das
 * Raster. Fehlt das Raster oder eine Stunde, bleibt die Zeit leer, und der Tag
 * wird offen statt geraten.
 */
export function resolveLesson(entry, raster) {
  if (entry.period_from === undefined && entry.period_to === undefined) return entry;
  const from = raster?.periods?.find((p) => p.n === entry.period_from);
  const to = raster?.periods?.find((p) => p.n === (entry.period_to ?? entry.period_from));
  if (!from || !to) return { ...entry, start: null, end: null, periodMissing: true };
  return { ...entry, start: from.start, end: to.end };
}

function seg(type, entry, extra = {}) {
  return {
    type,
    start: toMinutes(entry.start),
    end: toMinutes(entry.end),
    title: entry.title ?? null,
    place: type === 'lesson' ? SCHOOL : (entry.place ?? SCHOOL),
    room: entry.room ?? null,
    period_from: entry.period_from ?? null,
    period_to: entry.period_to ?? entry.period_from ?? null,
    periodMissing: Boolean(entry.periodMissing),
    ...extra,
  };
}

/**
 * @param {object} input
 * @param {object[]} input.plans       alle Plaene des Kindes (data-Objekte)
 * @param {object[]} input.exceptions  alle Ausnahmen des Kindes
 * @param {string}   input.date        "YYYY-MM-DD" im Haushalt
 * @param {null|'unknown'|{type:'school'|'public', name:string}} input.holiday
 *        Ferien/Feiertag an diesem Tag; 'unknown', wenn Yuvomi keine
 *        Ferieninformation liefern kann.
 */
export function computeDay({ plans = [], exceptions = [], date, holiday = null, rasters = [] }) {
  const result = {
    date, status: STATUS.OK, plan: null, exception: null, holiday: holiday && holiday !== 'unknown' ? holiday : null,
    holidayUnknown: holiday === 'unknown', week: null, segments: [], last: null, home: null, reasons: [],
  };
  const open = (code, params = {}) => { result.reasons.push({ code, ...params }); };

  const exs = exceptionsFor(exceptions, date);
  if (exs.length > 1) {
    result.status = STATUS.OPEN;
    open('exception_duplicate', { count: exs.length });
    return result;
  }
  const ex = exs[0] ?? null;
  result.exception = ex;
  if (ex?.day === 'absent') {
    result.status = STATUS.ABSENT;
    return result;
  }

  const valid = plansFor(plans, date);
  if (valid.length === 0) {
    result.status = STATUS.NO_PLAN;
    return result;
  }
  if (valid.length > 1) {
    result.status = STATUS.CONFLICT;
    open('plans_overlap', { labels: valid.map((p) => p.label) });
    return result;
  }
  const plan = valid[0];
  result.plan = plan;
  const letter = plan.ab_anchor ? abWeek(date, plan.ab_anchor) : null;
  result.week = letter;

  const day = plan.days?.[String(weekday(date))] ?? {};
  const raster = plan.periods_id ? rasters.find((r) => r.id === plan.periods_id) ?? null : null;
  let lessons = (day.lessons ?? []).filter((e) => inWeek(e, letter)).map((e) => resolveLesson(e, raster));
  if (lessons.some((e) => e.periodMissing)) open('period_missing');
  let care = (day.care ?? []).filter((e) => inWeek(e, letter));
  let projects = (day.projects ?? []).filter((e) => inWeek(e, letter));

  // ---- Ferien, Feiertage, schulfreie Tage --------------------------------
  // Unterricht entfaellt. Betreuung und Projekte koennen trotzdem stattfinden:
  // der Plan sagt je Art ja / nein / offen.
  const offDay = Boolean(result.holiday) || ex?.day === 'no_school';
  if (offDay) {
    lessons = [];
    for (const [cat, list] of [['care', care], ['projects', projects]]) {
      if (!list.length) continue;
      const rule = plan.holidays?.[cat] ?? 'ask';
      if (rule === 'no') {
        if (cat === 'care') care = []; else projects = [];
      } else if (rule !== 'yes') {
        open('holiday_unclear', { what: cat });
      }
    }
  }

  // ---- Tagesausnahme -------------------------------------------------------
  // Was die Ausnahme ausdruecklich sagt, gilt. Was sie absagt, ohne zu sagen,
  // was stattdessen passiert, macht die Heimkehr offen.
  let cancelledSomething = false;
  if (ex) {
    if (ex.lessons?.cancelled) lessons = [];
    else if (ex.lessons?.end) {
      const cut = toMinutes(ex.lessons.end);
      lessons = lessons
        .filter((e) => toMinutes(e.start) < cut)
        .map((e) => (toMinutes(e.end) > cut ? { ...e, end: ex.lessons.end } : e));
    }
    if (ex.care?.cancelled) {
      if (care.length) cancelledSomething = true;
      care = [];
    } else if (ex.care?.start && ex.care?.end) {
      care = [{ start: ex.care.start, end: ex.care.end, place: ex.care.place ?? care[0]?.place ?? SCHOOL }];
    }
    for (const [title, change] of Object.entries(ex.projects ?? {})) {
      const idx = projects.findIndex((p) => p.title === title);
      if (change?.added) {
        projects = [...projects, { title, start: change.start, end: change.end, place: change.place ?? SCHOOL }];
      } else if (idx < 0) {
        open('exception_unknown_project', { title });
      } else if (change?.cancelled) {
        projects = projects.filter((_, i) => i !== idx);
        cancelledSomething = true;
      } else if (change?.start && change?.end) {
        projects = projects.map((p, i) => (i === idx ? { ...p, start: change.start, end: change.end, place: change.place ?? p.place } : p));
      }
    }
  }

  // ---- Abschnitte ----------------------------------------------------------
  const segments = [
    ...lessons.map((e) => seg('lesson', e)),
    ...care.map((e) => seg('care', e, { title: null })),
    ...projects.map((e) => seg('project', e)),
  ];
  for (const s of segments) {
    if (s.periodMissing) continue; // schon als period_missing gemeldet
    if (s.start === null || s.end === null) open('time_missing', { type: s.type, title: s.title });
    else if (s.end <= s.start) open('end_before_start', { type: s.type, title: s.title });
  }
  const timed = segments.filter((s) => s.start !== null && s.end !== null && s.end > s.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < timed.length; i++) {
    if (timed[i].start < timed[i - 1].end) {
      open('overlap', { a: timed[i - 1], b: timed[i] });
    }
  }

  // Luecken sichtbar machen - "keine Angabe", nicht Betreuung. Zwischen zwei
  // Unterrichtsstunden ist eine Luecke die Pause: das Kind ist in der Schule.
  const withGaps = [];
  for (const s of timed) {
    const prev = withGaps.at(-1);
    if (prev && s.start > prev.end) {
      const type = prev.type === 'lesson' && s.type === 'lesson' ? 'break' : 'gap';
      withGaps.push({ type, start: prev.end, end: s.start, place: type === 'break' ? SCHOOL : undefined });
    }
    withGaps.push(s);
  }
  result.segments = withGaps;

  if (!timed.length) {
    if (result.reasons.length) { result.status = STATUS.OPEN; return result; }
    if (offDay || ex?.lessons?.cancelled) { result.status = STATUS.OFF; return result; }
    result.status = STATUS.EMPTY;
    return result;
  }

  const last = timed.reduce((a, b) => (b.end > a.end ? b : a));
  result.last = last;

  // ---- Tagesende -----------------------------------------------------------
  const end = ex?.end ?? day.end ?? null;
  const explicitAfterCancel = Boolean(ex?.end) || Boolean(ex?.care?.start && ex?.care?.end);
  if (cancelledSomething && !explicitAfterCancel) open('cancelled_without_replacement');
  if (result.reasons.length) { result.status = STATUS.OPEN; return result; }

  if (!end?.mode) {
    result.status = STATUS.OPEN;
    open('end_missing');
    return result;
  }
  if (end.mode === 'home') {
    const minutes = plan.travel?.[last.place];
    if (!Number.isInteger(minutes) || minutes < 0) {
      result.status = STATUS.OPEN;
      open('travel_missing', { place: last.place });
      return result;
    }
    result.home = { minutes: last.end + minutes, mode: 'home', from: last.place, travel: minutes };
  } else if (end.mode === 'pickup') {
    const homeAt = toMinutes(end.home);
    const pickupAt = toMinutes(end.pickup);
    if (pickupAt !== null && pickupAt < last.end) {
      result.status = STATUS.OPEN;
      open('pickup_before_end', { pickup: end.pickup });
      return result;
    }
    if (homeAt !== null) {
      if (homeAt < last.end) {
        result.status = STATUS.OPEN;
        open('home_before_end', { home: end.home });
        return result;
      }
      result.home = { minutes: homeAt, mode: 'pickup', from: last.place, pickup: pickupAt };
    } else if (pickupAt !== null && Number.isInteger(end.drive) && end.drive >= 0) {
      result.home = { minutes: pickupAt + end.drive, mode: 'pickup', from: last.place, pickup: pickupAt, travel: end.drive };
    } else {
      result.status = STATUS.OPEN;
      open('pickup_incomplete');
      return result;
    }
  } else {
    result.status = STATUS.OPEN;
    open('end_missing');
    return result;
  }
  result.segments.push({ type: 'travel', start: last.end, end: result.home.minutes, place: last.place, mode: result.home.mode });
  return result;
}

/**
 * Wo das Kind laut Plan um `minutes` ist, was danach kommt.
 * Nur fuer die Anzeige "Heute"; aendert nichts am Ergebnis von computeDay.
 */
export function positionAt(dayResult, minutes) {
  const segs = dayResult.segments ?? [];
  const current = segs.find((s) => s.start <= minutes && minutes < s.end) ?? null;
  const next = segs.find((s) => s.start > minutes && s.type !== 'gap' && s.type !== 'break') ?? null;
  const before = segs.length > 0 && minutes < segs[0].start;
  const after = segs.length > 0 && minutes >= segs.at(-1).end;
  return { current, next, before, after };
}
