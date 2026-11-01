import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, StoreError, dataOf } from '../module/lib/store.js';
import { loadHolidays } from '../module/lib/holidays.js';
import { emptyPlan, copyPlan, validatePlan, validateException, isEmptyException, overlappingPlans } from '../module/lib/plan.js';

/** Attrappe des Fork-Modulspeichers mit Personen (Migration 275). */
function fakeYuvomi({ persons = true, viewer = 1, access = { 2: 'write', 3: 'read' } } = {}) {
  const rows = new Map();
  let n = 0;
  const calls = [];
  const fail = (status, reason) => Object.assign(new Error(reason ?? `HTTP ${status}`), { status, data: reason ? { reason } : {} });
  const visible = (r) => r.subject_id === null || r.subject_id === viewer || access[r.subject_id];
  const api = {
    async get(path) {
      calls.push(['GET', path]);
      const url = new URL(path, 'http://x');
      if (url.pathname.endsWith('/people')) {
        if (!persons) throw fail(404);
        return { data: Object.entries(access).map(([id, a]) => ({ user_id: Number(id), display_name: `P${id}`, access: a, self: false })) };
      }
      if (url.pathname.endsWith('/records')) {
        const subject = Number(url.searchParams.get('subject_id'));
        return { data: [...rows.values()].filter(visible).filter((r) => r.subject_id === subject).map((r) => structuredClone(r)), next: null };
      }
      const r = rows.get(url.pathname.split('/').pop());
      if (!r || !visible(r)) throw fail(404, 'record_not_found');
      return { data: structuredClone(r) };
    },
    async post(path, body) {
      calls.push(['POST', path, body]);
      if (persons && access[body.subject_id] !== 'write') throw fail(403, 'module_person_access_denied');
      const id = `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
      const r = { id, revision: 1, subject_id: persons ? body.subject_id : null, data: structuredClone(body.data) };
      rows.set(id, r);
      return { data: structuredClone(r) };
    },
    async put(path, body) {
      calls.push(['PUT', path, body]);
      const r = rows.get(path.split('/').pop());
      if (!r) throw fail(404, 'record_not_found');
      if (access[r.subject_id] !== 'write') throw fail(403, 'module_person_access_denied');
      if (r.revision !== body.revision) throw fail(409, 'record_conflict');
      r.data = structuredClone(body.data); r.revision++;
      return { data: structuredClone(r) };
    },
    async delete(path) {
      calls.push(['DELETE', path]);
      const url = new URL(path, 'http://x');
      const r = rows.get(url.pathname.split('/').pop());
      if (!r) throw fail(404, 'record_not_found');
      if (r.revision !== Number(url.searchParams.get('revision'))) throw fail(409, 'record_conflict');
      rows.delete(r.id);
      return { data: { id: r.id, deleted: true } };
    },
  };
  return { api, rows, calls };
}

test('store: plans and exceptions per person, string ids, revisions', async () => {
  const y = fakeYuvomi();
  const store = createStore(y.api);
  assert.deepEqual((await store.people()).map((p) => p.user_id), [2, 3]);
  const plan = await store.create(2, emptyPlan({ label: 'Schuljahr', validFrom: '2026-08-01', validTo: '2027-07-31' }));
  await store.create(2, { kind: 'exception', date: '2026-11-04' });
  assert.equal(typeof plan.id, 'string');
  const loaded = await store.load(2);
  assert.equal(loaded.plans.length, 1);
  assert.equal(loaded.exceptions.length, 1);
  const edited = await store.update(plan, { ...dataOf(plan), label: 'Schuljahr 2026/27' });
  assert.equal(edited.revision, 2);
  await assert.rejects(store.update(plan, dataOf(plan)), { reason: 'conflict' }, 'stale revision is a conflict, never retried');
  await assert.rejects(store.create(3, emptyPlan()), { reason: 'forbidden' }, 'read-only for this person');
});

test('store: a Yuvomi without person records is refused, nothing stays household-wide', async () => {
  const y = fakeYuvomi({ persons: false });
  const store = createStore(y.api);
  await assert.rejects(store.people(), { reason: 'storage_unsupported' });
  await assert.rejects(store.create(2, emptyPlan()), (e) => e instanceof StoreError && e.reason === 'persons_unsupported');
  assert.equal(y.rows.size, 0, 'the household-wide record was taken back at once');
});

test('holidays: coverage from Yuvomi preferences, unknown is never "no holiday"', async () => {
  const api = (prefs, rows, fail = false) => ({
    async get(path) {
      if (path === '/preferences') return { data: prefs };
      if (fail) throw Object.assign(new Error('403'), { status: 403 });
      return { data: rows };
    },
  });
  const rows = [{ type: 'school', name: 'Herbstferien', start_date: '2026-10-26', end_date: '2026-11-06' }, { type: 'public', name: 'Reformationstag', start_date: '2026-10-31', end_date: '2026-10-31' }];
  const full = await loadHolidays(api({ holiday_country: 'DE', holiday_show_school: true, holiday_show_public: true }, rows), '2026-10-01', '2026-11-30');
  assert.equal(full.coverage, 'full');
  assert.deepEqual(full.holidayFor('2026-10-28'), { type: 'school', name: 'Herbstferien' });
  assert.deepEqual(full.holidayFor('2026-10-31'), { type: 'public', name: 'Reformationstag' });
  assert.equal(full.holidayFor('2026-11-10'), null);
  const publicOnly = await loadHolidays(api({ holiday_country: 'DE', holiday_show_public: true }, rows.slice(1)), '2026-10-01', '2026-11-30');
  assert.equal(publicOnly.holidayFor('2026-11-10'), 'unknown', 'school holidays are not known');
  const none = await loadHolidays(api({}, []), '2026-10-01', '2026-11-30');
  assert.equal(none.coverage, 'none');
  assert.equal(none.holidayFor('2026-11-10'), 'unknown');
  const noCalendar = await loadHolidays(api({ holiday_country: 'DE', holiday_show_school: true }, [], true), '2026-10-01', '2026-11-30');
  assert.equal(noCalendar.coverage, 'unavailable', 'no calendar right');
});

test('plan validation: required range, overlaps, entry times, pickup', () => {
  const others = [{ id: 'x', label: 'Alt', valid_from: '2025-08-01', valid_to: '2026-07-31' }];
  const p = emptyPlan({ label: 'Neu', validFrom: '2026-08-01', validTo: '2027-07-31' });
  assert.deepEqual(validatePlan(p, others), []);
  assert.deepEqual(validatePlan({ ...p, valid_from: '2026-07-01' }, others).map((x) => x.code), ['range_overlaps']);
  assert.deepEqual(validatePlan({ ...p, label: ' ' }).map((x) => x.code), ['label_missing']);
  assert.deepEqual(validatePlan({ ...p, valid_to: '2026-01-01' }).map((x) => x.code), ['range_reversed']);
  const bad = structuredClone(p);
  bad.days['1'].lessons.push({ start: '13:00', end: '08:00', title: 'x' }, { start: '08:00', end: '09:00', title: '' });
  bad.days['2'] = { lessons: [{ start: '08:00', end: '13:00', title: 'x' }], care: [], projects: [], end: { mode: 'pickup' } };
  assert.deepEqual(validatePlan(bad).map((x) => x.code).sort(), ['entry_order', 'entry_title', 'pickup_incomplete'].sort());
  assert.deepEqual(overlappingPlans(others, '2026-07-31', '2026-09-01').map((x) => x.label), ['Alt']);
});

test('copy a plan as the template for the next school year', () => {
  const p = { ...emptyPlan({ label: '2025/26', validFrom: '2025-08-01', validTo: '2026-07-31' }), id: 'a', revision: 3, subject_id: 2 };
  p.days['1'].care.push({ start: '13:00', end: '15:00' });
  const c = copyPlan(p, { label: '2026/27', validFrom: '2026-08-01', validTo: '2027-07-31' });
  assert.equal(c.id, undefined);
  assert.equal(c.days['1'].care.length, 1);
  c.days['1'].care = [];
  assert.equal(p.days['1'].care.length, 1, 'the old plan is not changed');
});

test('exception validation', () => {
  assert.deepEqual(validateException({ date: '2026-11-04', care: { start: '13:00', end: '16:00' } }), []);
  assert.deepEqual(validateException({ date: 'morgen' }).map((x) => x.code), ['date_missing']);
  assert.deepEqual(validateException({ date: '2026-11-04', end: { mode: 'pickup', pickup: '25:00' } }).map((x) => x.code), ['time_invalid']);
  assert.equal(isEmptyException({ date: '2026-11-04', day: 'normal', projects: {} }), true);
  assert.equal(isEmptyException({ date: '2026-11-04', note: 'Zahnarzt' }), false);
});

import { emptyRaster, nextPeriod, validateRaster } from '../module/lib/plan.js';

test('raster: next period keeps length and break; validation', () => {
  const r = emptyRaster('GS');
  r.periods.push(nextPeriod(r.periods));
  assert.deepEqual(r.periods[1], { n: 2, start: '08:50', end: '09:35' });
  r.periods.push(nextPeriod(r.periods));
  assert.deepEqual(r.periods[2], { n: 3, start: '09:40', end: '10:25' });
  assert.deepEqual(validateRaster(r), []);
  assert.deepEqual(validateRaster({ name: '', periods: [] }).map((x) => x.code), ['raster_name_missing', 'raster_empty']);
  assert.deepEqual(validateRaster({ name: 'x', periods: [{ n: 1, start: '08:00', end: '09:00' }, { n: 2, start: '08:30', end: '09:30' }] }).map((x) => x.code), ['raster_overlap']);
});

test('plan validation: lessons by period need a raster and a sensible range', () => {
  const p = emptyPlan({ label: 'x', validFrom: '2026-08-01', validTo: '2027-07-31' });
  p.days['1'].lessons.push({ period_from: 3, period_to: 2, title: 'Mathe' });
  assert.deepEqual(validatePlan(p).map((x) => x.code).sort(), ['entry_order', 'periods_without_raster']);
  p.periods_id = 'r1';
  p.days['1'].lessons[0] = { period_from: 1, period_to: 4, title: 'Mathe' };
  assert.deepEqual(validatePlan(p), []);
});
