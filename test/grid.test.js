import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeDay, positionAt, SCHOOL } from '../module/lib/day.js';
import { buildWeekGrid } from '../module/lib/grid.js';
import { copyPlanFor, cleanTeachers, validatePlan, emptyPlan } from '../module/lib/plan.js';
import { addDays } from '../module/lib/time.js';

const MON = '2026-11-02';
const raster = { id: 'r1', name: 'GS', periods: [
  { n: 1, start: '08:00', end: '08:45' }, { n: 2, start: '08:50', end: '09:35' },
  { n: 3, start: '09:50', end: '10:35' }, { n: 4, start: '10:40', end: '11:25' },
] };
const base = (days, extra = {}) => ({
  kind: 'plan', label: 'SJ', valid_from: '2026-08-01', valid_to: '2027-07-31', ab_anchor: null,
  travel: { [SCHOOL]: 15 }, holidays: { care: 'yes', projects: 'yes' }, days, ...extra,
});

test('a gap between two lessons is a break, not "nothing entered"', () => {
  const plan = base({ 1: { lessons: [{ start: '08:00', end: '09:35', title: 'Mathe' }, { start: '09:50', end: '11:25', title: 'Deutsch' }], end: { mode: 'home' } } });
  const r = computeDay({ plans: [plan], date: MON });
  const brk = r.segments.find((s) => s.type === 'break');
  assert.ok(brk);
  assert.equal(r.segments.some((s) => s.type === 'gap'), false);
  assert.equal(positionAt(r, 9 * 60 + 36).current.type, 'break');
  assert.equal(positionAt(r, 9 * 60 + 36).next.title, 'Deutsch', 'next skips the break');
});

test('a gap between lessons and childcare stays "nothing entered"', () => {
  const plan = base({ 1: { lessons: [{ start: '08:00', end: '11:25', title: 'U' }], care: [{ start: '12:00', end: '14:00' }], end: { mode: 'home' } } });
  const r = computeDay({ plans: [plan], date: MON });
  assert.deepEqual(r.segments.map((s) => s.type), ['lesson', 'gap', 'care', 'travel']);
});

test('week grid: rows follow the raster, breaks between periods, double periods span', () => {
  const plan = base({
    1: { lessons: [{ period_from: 1, period_to: 2, title: 'Mathe' }, { period_from: 3, title: 'Deutsch', room: '12' }], end: { mode: 'home' } },
    2: { lessons: [{ period_from: 1, period_to: 4, title: 'Ausflug' }], end: { mode: 'home' } },
  }, { periods_id: 'r1' });
  const days = [0, 1, 2].map((i) => addDays(MON, i)).map((date) => ({ key: date, result: computeDay({ plans: [plan], date, rasters: [raster] }) }));
  const { rows, columns } = buildWeekGrid(days, [raster]);
  assert.deepEqual(rows.map((r) => r.kind), ['period', 'period', 'break', 'period', 'period']);
  assert.equal(rows[2].start, 9 * 60 + 35);
  assert.equal(columns[0].cells.get(0).span, 2, 'periods 1-2 (no break between them in the rows)');
  assert.equal(columns[0].cells.get(3).seg.room, '12');
  assert.equal(columns[1].cells.get(0).span, 5, 'periods 1-4 span the break row too');
  assert.equal(columns[2].status, 'empty', 'Wednesday has nothing entered');
});

test('week grid without raster: rows from the week\'s times; absence fills the column', () => {
  const plan = base({
    1: { lessons: [{ start: '08:00', end: '09:35', title: 'A' }, { start: '09:50', end: '11:25', title: 'B' }], end: { mode: 'home' } },
    2: { lessons: [{ start: '08:00', end: '11:25', title: 'C' }], end: { mode: 'home' } },
  });
  const ex = [{ kind: 'exception', date: addDays(MON, 1), day: 'absent' }];
  const days = [0, 1].map((i) => addDays(MON, i)).map((date) => ({ key: date, result: computeDay({ plans: [plan], exceptions: ex, date }) }));
  const { rows, columns } = buildWeekGrid(days);
  assert.deepEqual(rows.map((r) => r.kind), ['period', 'break', 'period']);
  assert.equal(columns[1].status, 'absent');
  assert.equal(columns[1].cells.size, 0);
});

test('copy for another child: lessons always, childcare and activities on request', () => {
  const plan = { ...base({ 1: { lessons: [{ start: '08:00', end: '12:00', title: 'U' }], care: [{ start: '12:00', end: '14:00' }], projects: [{ start: '14:00', end: '15:00', title: 'Theater' }], end: { mode: 'home' } } }), id: 'x', revision: 3, subject_id: 7 };
  const c = copyPlanFor(plan);
  assert.equal(c.id, undefined);
  assert.equal(c.subject_id, undefined);
  assert.equal(c.days[1].lessons.length, 1);
  assert.equal(c.days[1].care.length, 1);
  assert.equal(c.days[1].projects.length, 0);
  assert.equal(copyPlanFor(plan, { care: false, projects: true }).days[1].care.length, 0);
  assert.equal(plan.days[1].projects.length, 1, 'the original stays untouched');
});

test('class and teachers: cleaned and checked', () => {
  assert.deepEqual(cleanTeachers([{ name: ' Frau Berg ', contact: '' }, { name: '', contact: '' }, { name: 'Herr Ost', contact: 'ost@schule.de' }]),
    [{ name: 'Frau Berg' }, { name: 'Herr Ost', contact: 'ost@schule.de' }]);
  const p = { ...emptyPlan({ label: 'SJ', validFrom: '2026-08-01', validTo: '2027-07-31' }), class_name: '4b', teachers: [{ name: 'Frau Berg' }] };
  assert.deepEqual(validatePlan(p), []);
  assert.deepEqual(validatePlan({ ...p, teachers: [{ name: '', contact: '0171' }] }).map((x) => x.code), ['teacher_name_missing']);
  assert.deepEqual(validatePlan({ ...p, class_name: 'x'.repeat(21) }).map((x) => x.code), ['class_long']);
});
