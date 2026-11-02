/**
 * Stundenplan - Wochentabelle
 *
 * Macht aus den berechneten Tagen (computeDay) eine Tabelle wie auf dem
 * Stundenplan der Schule: Zeilen sind die Stunden, Spalten die Tage. Gibt es
 * ein Stundenraster und passen alle Stunden darauf, sind die Zeilen die Stunden
 * des Rasters (mit Nummer). Sonst werden die Zeilen aus den Anfangs- und
 * Endzeiten der Woche gebildet. Luecken ab 10 Minuten zwischen zwei Zeilen
 * sind Pausen.
 *
 * Nur Unterricht steht im Raster; Betreuung und Projekte stehen je Tag darunter.
 */
import { toMinutes } from './time.js';

const STATUS_CELL = new Set(['absent', 'off', 'no_plan', 'empty', 'conflict']);
// Kuerzere Luecken (Stundenwechsel) bekommen keine eigene Pausenzeile.
const MIN_BREAK = 10;

function rasterSlots(raster) {
  return (raster?.periods ?? [])
    .map((p) => ({ n: p.n, start: toMinutes(p.start), end: toMinutes(p.end) }))
    .filter((p) => p.start !== null && p.end !== null)
    .sort((a, b) => a.start - b.start);
}

/** Elementare Zeitabschnitte: zwischen allen Grenzen, nur wo Unterricht ist. */
function timeSlots(lessons) {
  const bounds = [...new Set(lessons.flatMap((s) => [s.start, s.end]))].sort((a, b) => a - b);
  const slots = [];
  for (let i = 1; i < bounds.length; i++) {
    const start = bounds[i - 1];
    const end = bounds[i];
    if (lessons.some((s) => s.start <= start && end <= s.end)) slots.push({ n: null, start, end });
  }
  return slots;
}

/** Index der ersten und letzten Zeile, die eine Stunde genau abdeckt - oder null. */
function cover(slots, seg) {
  const first = slots.findIndex((x) => x.start === seg.start);
  if (first < 0) return null;
  for (let i = first; i < slots.length; i++) {
    if (slots[i].end === seg.end) return [first, i];
    if (slots[i].end > seg.end) return null;
  }
  return null;
}

/**
 * @param {object[]} days    [{ key, result }] - result aus computeDay
 * @param {object[]} rasters Stundenraster des Haushalts
 * @returns {{ rows: object[], columns: object[] }}
 *   rows:    [{ kind: 'period'|'break', n, start, end }]
 *   columns: [{ key, result, cells: Map(rowIndex -> { seg, span }), covered: Set, status, extra, afternoon }]
 */
export function buildWeekGrid(days, rasters = []) {
  const lessonsOf = (r) => (r.segments ?? []).filter((s) => s.type === 'lesson');
  const all = days.flatMap((d) => lessonsOf(d.result));

  // Das Raster, das die meisten Tage benutzen.
  const counts = new Map();
  for (const d of days) {
    const id = d.result.plan?.periods_id;
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const rasterId = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  let slots = rasterSlots(rasters.find((r) => r.id === rasterId));
  if (!slots.length || all.some((s) => !cover(slots, s))) slots = timeSlots(all);
  else {
    // Nur bis zur letzten benutzten Stunde; die erste Stunde bleibt immer stehen.
    const last = Math.max(0, ...all.map((s) => cover(slots, s)[1]));
    slots = slots.slice(0, last + 1);
  }

  const rows = [];
  for (const s of slots) {
    const prev = rows.at(-1);
    if (prev && s.start - prev.end >= MIN_BREAK) rows.push({ kind: 'break', n: null, start: prev.end, end: s.start });
    rows.push({ kind: 'period', ...s });
  }
  const rowOf = (slotIndex) => rows.indexOf(rows.filter((r) => r.kind === 'period')[slotIndex]);

  const columns = days.map(({ key, result }) => {
    const cells = new Map();
    const covered = new Set();
    const extra = [];
    for (const seg of lessonsOf(result)) {
      const c = cover(slots, seg);
      const from = c ? rowOf(c[0]) : -1;
      const to = c ? rowOf(c[1]) : -1;
      const free = from >= 0 && [...Array(to - from + 1)].every((_, i) => !covered.has(from + i));
      if (!free) { extra.push(seg); continue; }
      cells.set(from, { seg, span: to - from + 1 });
      for (let i = from; i <= to; i++) covered.add(i);
    }
    const status = !cells.size && STATUS_CELL.has(result.status) ? result.status : null;
    const afternoon = (result.segments ?? []).filter((s) => s.type === 'care' || s.type === 'project');
    return { key, result, cells, covered, status, extra, afternoon };
  });
  return { rows, columns };
}
