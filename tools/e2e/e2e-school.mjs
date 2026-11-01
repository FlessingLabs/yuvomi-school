#!/usr/bin/env node
/**
 * Abnahmetest Stundenplan gegen ein ECHTES Yuvomi mit Modulspeicher und
 * Personen-Freigaben (FlessingLabs-Fork, Migrationen 274/275).
 *
 *   node tools/e2e/e2e-school.mjs <phase> [--base URL] [--user U] [--password P]
 *
 * Phasen:
 *   setup     legt (falls noetig) den ersten Admin an, dazu Testmitglieder mit
 *             dem Praefix "e2e" (drei Kinder, ein Elternteil, eine weitere
 *             Person), Freigaben, Plaene und eine Ausnahme - und prueft Rechte,
 *             Heimkehr, Konflikte und dass andere Bereiche unveraendert antworten.
 *   persist   nach einem Neustart: Plaene, Ausnahme und Freigaben sind noch da.
 *   readonly  nur lesend, fuer eine laufende Installation.
 *   unsupported  gegen ein Yuvomi OHNE Personen-Freigaben: das Modul meldet
 *             `storage_unsupported` und legt nichts an.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const lib = (f) => import(path.join(here, '../../module/lib', f));
const { createStore, dataOf } = await lib('store.js');
const { computeDay, STATUS, SCHOOL } = await lib('day.js');
const { fromMinutes, mondayOf, addDays } = await lib('time.js');
const { emptyPlan, copyPlan } = await lib('plan.js');

const args = process.argv.slice(2);
const phase = args[0] ?? 'setup';
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const BASE = opt('base', 'http://127.0.0.1:3000').replace(/\/+$/, '');
const USER = opt('user', 'admin');
const PASSWORD = opt('password', 'school-test-pw');
const MODULE = 'flessinglabs-school';

function session(label) {
  const jar = new Map();
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  async function raw(p, init = {}) {
    const res = await fetch(BASE + p, { ...init, redirect: 'manual', headers: { ...(init.headers ?? {}), cookie: cookie(), origin: BASE } });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    return res;
  }
  async function call(method, p, body) {
    const headers = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (method !== 'GET') headers['x-csrf-token'] = jar.get('csrf-token') ?? '';
    const res = await raw(`/api/v1${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw Object.assign(new Error(`${label}: ${method} ${p} -> ${res.status} ${JSON.stringify(data)}`), { status: res.status, data });
    return data;
  }
  const api = { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), put: (p, b) => call('PUT', p, b), patch: (p, b) => call('PATCH', p, b), delete: (p) => call('DELETE', p) };
  return {
    api, raw,
    async login(user, password) {
      const res = await raw('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: user, password }) });
      assert.equal(res.status, 200, `${label}: login ${user} -> ${res.status}`);
      await api.get('/auth/me');
      return this;
    },
  };
}

async function ensureAdmin() {
  const res = await fetch(`${BASE}/api/v1/auth/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: USER, display_name: 'E2E Admin', password: PASSWORD, language: 'de' }) });
  console.log('setup admin:', res.status);
}

async function checkModule(admin) {
  const m = (await admin.api.get('/modules?admin=1')).data.find((x) => x.id === MODULE);
  assert.ok(m, 'Stundenplan module installed');
  assert.equal(m.status, 'enabled', `${m.status}: ${m.error ?? ''}`);
  console.log('module:', m.id, m.version, m.status);
  for (const f of ['index.js', 'settings.js', 'lib/day.js', 'lib/store.js', 'lib/plan.js', 'lib/time.js', 'lib/holidays.js', 'style.css', 'locales/de.json']) {
    assert.equal((await admin.raw(`/api/v1/modules/assets/${MODULE}/${f}`)).status, 200, f);
  }
}

const NAMES = ['e2elea', 'e2emax', 'e2eian', 'e2emama', 'e2eoma'];
const PW = (n) => `${n}-pw-123`;

if (phase === 'unsupported') {
  await ensureAdmin();
  const admin = await session('admin').login(USER, PASSWORD);
  await assert.rejects(createStore(admin.api).people(), { reason: 'storage_unsupported' });
  console.log('Yuvomi without person storage -> storage_unsupported: OK');
  process.exit(0);
}

if (phase === 'readonly') {
  const admin = await session('admin').login(USER, PASSWORD);
  await checkModule(admin);
  const store = createStore(admin.api);
  const people = await store.people();
  for (const p of people) {
    const d = await store.load(p.user_id);
    if (d.plans.length) console.log(`${p.display_name}: ${d.plans.length} plan(s), ${d.exceptions.length} change(s)`);
  }
  console.log('readonly phase OK (nothing was changed)');
  process.exit(0);
}

if (phase === 'setup') await ensureAdmin();
const admin = await session('admin').login(USER, PASSWORD);
const store = createStore(admin.api);

if (phase === 'persist') {
  const people = await store.people();
  const lea = people.find((p) => p.display_name === 'e2elea');
  const d = await store.load(lea.user_id);
  assert.deepEqual(d.plans.map((p) => p.label).sort(), ['E2E 2025/26', 'E2E 2026/27']);
  assert.equal(d.exceptions.length, 1);
  const mama = people.find((p) => p.display_name === 'e2emama');
  assert.ok((await store.grants())[lea.user_id].some((g) => g.user_id === mama.user_id && g.access === 'write'));
  console.log('persist phase OK');
  process.exit(0);
}

// ---------------------------------------------------------------- setup
await checkModule(admin);

// Mitglieder (nur anlegen, wenn es sie noch nicht gibt).
const users = (await admin.api.get('/auth/users')).data ?? [];
const ids = {};
for (const n of NAMES) {
  const existing = users.find((u) => u.username === n);
  ids[n] = existing?.id ?? (await admin.api.post('/auth/users', { username: n, display_name: n, password: PW(n) })).user.id;
}
const as = async (n) => session(n).login(n, PW(n));

// Freigaben: Mama pflegt alle drei Kinder; Oma bekommt nichts.
for (const kid of ['e2elea', 'e2emax', 'e2eian']) {
  await store.setGrants(ids[kid], [{ user_id: ids.e2emama, access: 'write' }]);
}
console.log('grants: mama writes for lea, max, ian');

const mama = createStore((await as('e2emama')).api);
const lea = createStore((await as('e2elea')).api);
const oma = createStore((await as('e2eoma')).api);

// Aufraeumen aus frueheren Laeufen.
for (const kid of ['e2elea', 'e2emax', 'e2eian']) {
  const d = await store.load(ids[kid]);
  for (const r of [...d.plans, ...d.exceptions]) await store.remove(r);
}

// Plaene (Mama legt an): Lea und Max mit Betreuung im alten, ohne im neuen Schuljahr; Ian neu mit Betreuung + Abholung.
const year1 = { ...emptyPlan({ label: 'E2E 2025/26', validFrom: '2025-08-01', validTo: '2026-07-31' }), travel: { [SCHOOL]: 20 } };
year1.days['3'] = { lessons: [{ start: '08:00', end: '13:00', title: 'Unterricht' }], care: [{ start: '13:00', end: '14:30' }], projects: [{ title: 'Theater', start: '14:30', end: '16:00' }], end: { mode: 'home' } };
const year2 = copyPlan(year1, { label: 'E2E 2026/27', validFrom: '2026-08-01', validTo: '2027-07-31' });
year2.days['3'] = { lessons: [{ start: '08:00', end: '13:00', title: 'Unterricht' }], care: [], projects: [{ title: 'Theater', start: '14:30', end: '16:00' }], end: { mode: 'home' } };
for (const kid of ['e2elea', 'e2emax']) {
  await mama.create(ids[kid], year1);
  await mama.create(ids[kid], year2);
}
const ianPlan = { ...emptyPlan({ label: 'E2E 2026/27', validFrom: '2026-08-01', validTo: '2027-07-31' }), travel: { [SCHOOL]: 15 } };
ianPlan.days['3'] = { lessons: [{ start: '08:00', end: '12:00', title: 'Unterricht' }], care: [{ start: '12:00', end: '15:30' }], projects: [], end: { mode: 'pickup', pickup: '15:30', drive: 10 } };
await mama.create(ids.e2eian, ianPlan);

// Ausnahme fuer Lea: Theater faellt aus, ohne Ersatzangabe.
const WED_OLD = '2026-07-08';
await mama.create(ids.e2elea, { kind: 'exception', date: WED_OLD, projects: { Theater: { cancelled: true } } });

// Rechte
await assert.rejects(lea.create(ids.e2elea, emptyPlan({ label: 'x', validFrom: '2026-01-01', validTo: '2026-01-02' })), { reason: 'forbidden' });
assert.deepEqual((await lea.people()).map((p) => [p.display_name, p.access]), [['e2elea', 'read']]);
assert.equal((await lea.load(ids.e2elea)).plans.length, 2, 'Lea reads her own plans');
assert.equal((await lea.load(ids.e2emax)).plans.length, 0, 'Lea does not see Max');
assert.equal((await oma.load(ids.e2elea)).plans.length, 0, 'Oma sees nothing without a grant');
const omaPeople = (await oma.people()).map((p) => p.display_name);
assert.ok(!omaPeople.includes('e2elea'), 'Oma is not offered Lea');
console.log('rights: parent writes, child reads own, others see nothing: OK');

// Heimkehr
const leaData = await mama.load(ids.e2elea);
const day = (data, date) => computeDay({ plans: data.plans, exceptions: data.exceptions, date, holiday: 'unknown' });
const nextWed = '2026-11-04';
assert.equal(fromMinutes(day(leaData, '2026-07-01').home.minutes), '16:20', 'old year: lessons, care, theatre, home');
assert.equal(day(leaData, WED_OLD).status, STATUS.OPEN, 'theatre cancelled: home stays open');
assert.equal(fromMinutes(day(leaData, nextWed).home.minutes), '16:20', 'new year: no care, gap shown');
assert.ok(day(leaData, nextWed).segments.some((s) => s.type === 'gap'));
const ianData = await mama.load(ids.e2eian);
assert.equal(fromMinutes(day(ianData, nextWed).home.minutes), '15:40', 'Ian picked up at 15:30 + 10 min');
assert.equal(day(ianData, '2026-07-01').status, STATUS.NO_PLAN, 'no plan before his starts');
console.log('home times: OK');

// Zwei Geraete, eine Revision
const plan = (await mama.load(ids.e2emax)).plans[1];
await mama.update(plan, { ...dataOf(plan), label: 'E2E 2026/27 (geaendert)' });
await assert.rejects(store.update(plan, { ...dataOf(plan), label: 'E2E veraltet' }), { reason: 'conflict' });
const fresh = (await mama.load(ids.e2emax)).plans[1];
assert.equal(fresh.label, 'E2E 2026/27 (geaendert)', 'the stale write did not overwrite');
await mama.update(fresh, { ...dataOf(fresh), label: 'E2E 2026/27' });
console.log('conflict on two devices: OK');

// Andere Bereiche
for (const p of ['/tasks', '/notes', '/shopping', '/calendar/holidays?from=2026-11-01&to=2026-11-30', '/dashboard', '/modules']) {
  const res = await admin.raw(`/api/v1${p}`);
  assert.ok(res.status < 400, `${p} -> ${res.status}`);
}
console.log('other areas: OK');
console.log('setup phase OK');
