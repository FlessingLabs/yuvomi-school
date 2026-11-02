import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeDay, positionAt, STATUS, SCHOOL } from '../module/lib/day.js';
import { fromMinutes, weekday, abWeek, nowInZone, addDays, mondayOf } from '../module/lib/time.js';

// 2026-11-02 ist ein Montag.
const MON = '2026-11-02';
const TUE = '2026-11-03';
const WED = '2026-11-04';
const THU = '2026-11-05';
const FRI = '2026-11-06';

const lesson = (start, end, title = 'Unterricht') => ({ start, end, title });

function plan(days, extra = {}) {
  return {
    kind: 'plan', label: 'Schuljahr 2026/27', valid_from: '2026-08-01', valid_to: '2027-07-31',
    ab_anchor: null, travel: { [SCHOOL]: 20, Theaterhaus: 30, Sporthalle: 15 },
    holidays: { care: 'no', projects: 'ask' },
    days, ...extra,
  };
}

const home = (r) => (r.home ? fromMinutes(r.home.minutes) : null);
const codes = (r) => r.reasons.map((x) => x.code);

test('time helpers: weekdays, A/B weeks, zone', () => {
  assert.equal(weekday(MON), 1);
  assert.equal(weekday('2026-11-08'), 7);
  assert.equal(mondayOf(THU), MON);
  assert.equal(abWeek(MON, MON), 'A');
  assert.equal(abWeek(addDays(MON, 7), MON), 'B');
  assert.equal(abWeek(addDays(MON, 14), FRI), 'A', 'anchor counts by its week, any weekday');
  assert.equal(abWeek(addDays(MON, -7), MON), 'B', 'before the anchor too');
});

test('1. lessons end, the child goes straight home', () => {
  const r = computeDay({ plans: [plan({ 1: { lessons: [lesson('08:00', '11:30', 'Mathe'), lesson('11:45', '13:00', 'Deutsch')], end: { mode: 'home' } } })], date: MON });
  assert.equal(r.status, STATUS.OK);
  assert.equal(home(r), '13:20');
  assert.equal(r.last.title, 'Deutsch', 'the end of the last lesson counts, not the number of lessons');
  assert.deepEqual(r.segments.map((s) => s.type), ['lesson', 'break', 'lesson', 'travel'], 'between two lessons the gap is a break');
});

test('2. lessons -> care -> home', () => {
  const r = computeDay({ plans: [plan({ 2: { lessons: [lesson('08:00', '13:00')], care: [{ start: '13:00', end: '15:00' }], end: { mode: 'home' } } })], date: TUE });
  assert.equal(home(r), '15:20');
  assert.equal(r.last.type, 'care');
});

test('3. lessons -> care -> project -> home (the example day)', () => {
  const r = computeDay({ plans: [plan({ 3: {
    lessons: [lesson('08:00', '13:00')], care: [{ start: '13:00', end: '14:30' }],
    projects: [{ title: 'Theater', start: '14:30', end: '16:00', place: SCHOOL }], end: { mode: 'home' },
  } })], date: WED });
  assert.equal(r.status, STATUS.OK);
  assert.equal(home(r), '16:20');
  assert.deepEqual(r.segments.map((s) => s.type), ['lesson', 'care', 'project', 'travel']);
});

test('3b. lessons -> project -> home, with a gap that is NOT shown as care', () => {
  const r = computeDay({ plans: [plan({ 4: {
    lessons: [lesson('08:00', '12:15')], projects: [{ title: 'Sport', start: '13:00', end: '14:00', place: 'Sporthalle' }], end: { mode: 'home' },
  } })], date: THU });
  assert.equal(home(r), '14:15', 'travel from the Sporthalle, not from school');
  const gap = r.segments.find((s) => s.type === 'gap');
  assert.deepEqual([fromMinutes(gap.start), fromMinutes(gap.end)], ['12:15', '13:00']);
  assert.ok(!r.segments.some((s) => s.type === 'care'));
});

test('4. care differs per weekday and per child', () => {
  const lea = plan({
    1: { lessons: [lesson('08:00', '13:00')], care: [{ start: '13:00', end: '14:30' }], end: { mode: 'home' } },
    2: { lessons: [lesson('08:00', '12:00')], care: [{ start: '12:00', end: '16:00' }], end: { mode: 'home' } },
  });
  const max = plan({ 1: { lessons: [lesson('08:00', '13:00')], end: { mode: 'home' } } });
  assert.equal(home(computeDay({ plans: [lea], date: MON })), '14:50');
  assert.equal(home(computeDay({ plans: [lea], date: TUE })), '16:20');
  assert.equal(home(computeDay({ plans: [max], date: MON })), '13:20', 'no care for Max');
});

test('5. several projects at different places', () => {
  const r = computeDay({ plans: [plan({ 5: {
    lessons: [lesson('08:00', '12:00')],
    projects: [{ title: 'Sport', start: '12:30', end: '13:30', place: 'Sporthalle' }, { title: 'Theater', start: '14:00', end: '16:00', place: 'Theaterhaus' }],
    end: { mode: 'home' },
  } })], date: FRI });
  assert.equal(home(r), '16:30', 'travel time from where the day ends');
  assert.equal(r.last.place, 'Theaterhaus');
});

test('5b. a missing travel time for the last place keeps the home time open', () => {
  const r = computeDay({ plans: [plan({ 5: { projects: [{ title: 'Musik', start: '14:00', end: '15:00', place: 'Musikschule' }], end: { mode: 'home' } } })], date: FRI });
  assert.equal(r.status, STATUS.OPEN);
  assert.deepEqual(codes(r), ['travel_missing']);
  assert.equal(r.home, null);
});

const theaterDay = plan({ 3: {
  lessons: [lesson('08:00', '13:00')], care: [{ start: '13:00', end: '14:30' }],
  projects: [{ title: 'Theater', start: '14:30', end: '16:00' }], end: { mode: 'home' },
} });

test('6. project cancelled: home stays open unless the exception says what happens instead', () => {
  const cancelled = computeDay({ plans: [theaterDay], exceptions: [{ kind: 'exception', date: WED, projects: { Theater: { cancelled: true } } }], date: WED });
  assert.equal(cancelled.status, STATUS.OPEN, 'no earlier home time is invented');
  assert.deepEqual(codes(cancelled), ['cancelled_without_replacement']);
  assert.equal(cancelled.home, null);

  const longerCare = computeDay({ plans: [theaterDay], exceptions: [{ kind: 'exception', date: WED, projects: { Theater: { cancelled: true } }, care: { start: '13:00', end: '16:00' } }], date: WED });
  assert.equal(longerCare.status, STATUS.OK);
  assert.equal(home(longerCare), '16:20', 'stays in care until 16:00 instead');

  const goesHome = computeDay({ plans: [theaterDay], exceptions: [{ kind: 'exception', date: WED, projects: { Theater: { cancelled: true } }, end: { mode: 'home' } }], date: WED });
  assert.equal(home(goesHome), '14:50', 'only when the exception says so explicitly');
});

test('7. earlier end of lessons does not move agreed care or project times', () => {
  const r = computeDay({ plans: [theaterDay], exceptions: [{ kind: 'exception', date: WED, lessons: { end: '11:30' } }], date: WED });
  assert.equal(r.status, STATUS.OK);
  assert.equal(home(r), '16:20');
  const gap = r.segments.find((s) => s.type === 'gap');
  assert.deepEqual([fromMinutes(gap.start), fromMinutes(gap.end)], ['11:30', '13:00'], 'the gap is shown, not filled');
});

test('8. an exception affects only its own day', () => {
  const exceptions = [{ kind: 'exception', date: WED, projects: { Theater: { cancelled: true } } }];
  assert.equal(home(computeDay({ plans: [theaterDay], exceptions, date: addDays(WED, 7) })), '16:20');
  assert.equal(computeDay({ plans: [theaterDay], exceptions, date: WED }).status, STATUS.OPEN);
  assert.equal(theaterDay.days[3].projects.length, 1, 'the weekly plan itself is unchanged');
});

test('9. new school year: the older two without care, Ian with a plan of his own', () => {
  const oldYear = plan({ 1: { lessons: [lesson('08:00', '13:00')], care: [{ start: '13:00', end: '15:00' }], end: { mode: 'home' } } },
    { label: '2025/26', valid_from: '2025-08-01', valid_to: '2026-07-31' });
  const newYear = plan({ 1: { lessons: [lesson('08:00', '13:30')], end: { mode: 'home' } } },
    { label: '2026/27', valid_from: '2026-08-01', valid_to: '2027-07-31' });
  assert.equal(home(computeDay({ plans: [oldYear, newYear], date: '2026-07-13' })), '15:20', 'old plan until it expires');
  assert.equal(home(computeDay({ plans: [oldYear, newYear], date: MON })), '13:50', 'new plan, no care any more');
  const ian = plan({ 1: { lessons: [lesson('08:00', '12:00')], care: [{ start: '12:00', end: '15:30' }], end: { mode: 'pickup', pickup: '15:30', drive: 10 } } });
  const r = computeDay({ plans: [ian], date: MON });
  assert.equal(home(r), '15:40');
  assert.equal(r.home.mode, 'pickup');
  assert.equal(computeDay({ plans: [oldYear], date: MON }).status, STATUS.NO_PLAN, 'an expired plan does not carry on');
});

test('9b. overlapping validity is a conflict, not a silent choice', () => {
  const a = plan({}, { label: 'A', valid_from: '2026-08-01', valid_to: '2026-12-31' });
  const b = plan({}, { label: 'B', valid_from: '2026-11-01', valid_to: '2027-07-31' });
  const r = computeDay({ plans: [a, b], date: MON });
  assert.equal(r.status, STATUS.CONFLICT);
  assert.deepEqual(r.reasons[0].labels, ['A', 'B']);
});

test('10. no valid or an incomplete plan: a reason instead of an invented time', () => {
  assert.equal(computeDay({ plans: [], date: MON }).status, STATUS.NO_PLAN);
  const empty = computeDay({ plans: [plan({ 2: { lessons: [lesson('08:00', '13:00')], end: { mode: 'home' } } })], date: MON });
  assert.equal(empty.status, STATUS.EMPTY, 'nothing entered for Monday is not "no school"');
  const noEnd = computeDay({ plans: [plan({ 1: { lessons: [lesson('08:00', '13:00')] } })], date: MON });
  assert.deepEqual(codes(noEnd), ['end_missing']);
  const broken = computeDay({ plans: [plan({ 1: { lessons: [lesson('13:00', '08:00')], end: { mode: 'home' } } })], date: MON });
  assert.equal(broken.status, STATUS.OPEN);
  assert.ok(codes(broken).includes('end_before_start'));
  const overlap = computeDay({ plans: [plan({ 1: { lessons: [lesson('08:00', '13:00')], care: [{ start: '12:30', end: '14:00' }], end: { mode: 'home' } } })], date: MON });
  assert.deepEqual(codes(overlap), ['overlap']);
  const missingTime = computeDay({ plans: [plan({ 1: { lessons: [{ start: '08:00', title: 'Mathe' }], end: { mode: 'home' } } })], date: MON });
  assert.deepEqual(codes(missingTime), ['time_missing']);
});

test('pickup: explicit home time, or pickup time plus drive; nothing else', () => {
  const day = (end) => plan({ 1: { lessons: [lesson('08:00', '13:00')], end } });
  assert.equal(home(computeDay({ plans: [day({ mode: 'pickup', home: '13:45' })], date: MON })), '13:45');
  assert.equal(home(computeDay({ plans: [day({ mode: 'pickup', pickup: '13:15', drive: 20 })], date: MON })), '13:35');
  assert.deepEqual(codes(computeDay({ plans: [day({ mode: 'pickup', pickup: '13:15' })], date: MON })), ['pickup_incomplete']);
  assert.deepEqual(codes(computeDay({ plans: [day({ mode: 'pickup', pickup: '12:00', drive: 10 })], date: MON })), ['pickup_before_end']);
  const picked = computeDay({ plans: [theaterDay], exceptions: [{ kind: 'exception', date: WED, end: { mode: 'pickup', pickup: '16:00', drive: 5 } }], date: WED });
  assert.equal(home(picked), '16:05', 'an exception can say: picked up today');
});

test('exceptions: no school, absent, lessons cancelled, project moved or added', () => {
  const noSchool = computeDay({ plans: [theaterDay], exceptions: [{ kind: 'exception', date: WED, day: 'no_school' }], date: WED });
  assert.equal(noSchool.status, STATUS.OPEN, 'care follows the plan (no), the project rule is "ask"');
  assert.deepEqual(codes(noSchool), ['holiday_unclear']);
  assert.ok(!noSchool.segments.some((s) => s.type === 'lesson' || s.type === 'care'));

  assert.equal(computeDay({ plans: [theaterDay], exceptions: [{ kind: 'exception', date: WED, day: 'absent' }], date: WED }).status, STATUS.ABSENT);

  const lessonsOnly = plan({ 3: { lessons: [lesson('08:00', '13:00')], end: { mode: 'home' } } });
  assert.equal(computeDay({ plans: [lessonsOnly], exceptions: [{ kind: 'exception', date: WED, lessons: { cancelled: true } }], date: WED }).status, STATUS.OFF);

  const moved = computeDay({ plans: [theaterDay], exceptions: [{ kind: 'exception', date: WED, projects: { Theater: { start: '15:00', end: '17:00' } } }], date: WED });
  assert.equal(home(moved), '17:20');
  assert.ok(moved.segments.some((s) => s.type === 'gap'), 'care still ends at 14:30; 14:30-15:00 is a gap');

  const extra = computeDay({ plans: [lessonsOnly], exceptions: [{ kind: 'exception', date: WED, projects: { Chor: { added: true, start: '13:30', end: '14:30' } } }], date: WED });
  assert.equal(home(extra), '14:50');

  const unknown = computeDay({ plans: [theaterDay], exceptions: [{ kind: 'exception', date: WED, projects: { Fussball: { cancelled: true } } }], date: WED });
  assert.deepEqual(codes(unknown), ['exception_unknown_project']);

  const twice = computeDay({ plans: [theaterDay], exceptions: [{ kind: 'exception', date: WED }, { kind: 'exception', date: WED }], date: WED });
  assert.deepEqual(codes(twice), ['exception_duplicate']);
});

test('holidays: lessons off; care and projects only where the plan says so', () => {
  const holiday = { type: 'school', name: 'Herbstferien' };
  const r = computeDay({ plans: [theaterDay], date: WED, holiday });
  assert.equal(r.status, STATUS.OPEN);
  assert.deepEqual(codes(r), ['holiday_unclear']);
  const yes = plan(theaterDay.days, { holidays: { care: 'no', projects: 'yes' } });
  const r2 = computeDay({ plans: [yes], date: WED, holiday });
  assert.equal(home(r2), '16:20', 'the project runs in the holidays, travel from school');
  const none = plan(theaterDay.days, { holidays: { care: 'no', projects: 'no' } });
  assert.equal(computeDay({ plans: [none], date: WED, holiday }).status, STATUS.OFF);
  const unknown = computeDay({ plans: [theaterDay], date: WED, holiday: 'unknown' });
  assert.equal(unknown.holidayUnknown, true, 'without holiday data the day is computed and says so');
  assert.equal(home(unknown), '16:20');
});

test('A/B weeks pick the entries of the week', () => {
  const ab = plan({ 1: {
    lessons: [lesson('08:00', '13:00', 'A-Woche'), { ...lesson('08:00', '14:00', 'B-Woche') }].map((l, i) => ({ ...l, weeks: i ? 'B' : 'A' })),
    projects: [{ title: 'Chor', start: '14:00', end: '15:00', weeks: 'B' }],
    end: { mode: 'home' },
  } }, { ab_anchor: MON });
  const a = computeDay({ plans: [ab], date: MON });
  const b = computeDay({ plans: [ab], date: addDays(MON, 7) });
  assert.equal(a.week, 'A');
  assert.equal(home(a), '13:20');
  assert.equal(b.week, 'B');
  assert.equal(home(b), '15:20');
  const noAb = computeDay({ plans: [plan(ab.days)], date: MON });
  assert.equal(noAb.status, STATUS.OPEN, 'without an anchor both weeks apply - and overlap');
});

test('14. household time zone, daylight saving and day boundaries', () => {
  // 2026-10-25: Ende der Sommerzeit in Europa. 23:30 UTC am 24. ist in Berlin schon der 25.
  assert.deepEqual(nowInZone('Europe/Berlin', new Date('2026-10-24T22:30:00Z')), { date: '2026-10-25', minutes: 30 });
  assert.deepEqual(nowInZone('Europe/Berlin', new Date('2026-10-25T14:30:00Z')), { date: '2026-10-25', minutes: 15 * 60 + 30 }, 'UTC+1 after the switch');
  assert.deepEqual(nowInZone('Europe/Berlin', new Date('2026-03-29T14:30:00Z')), { date: '2026-03-29', minutes: 16 * 60 + 30 }, 'UTC+2 after the spring switch');
  assert.deepEqual(nowInZone('America/New_York', new Date('2026-11-03T03:00:00Z')), { date: '2026-11-02', minutes: 22 * 60 });
  // Wanduhrzeiten bleiben an Umstellungstagen dieselben.
  const sunday = plan({ 7: { projects: [{ title: 'Musik', start: '14:00', end: '16:00' }], end: { mode: 'home' } } });
  assert.equal(home(computeDay({ plans: [sunday], date: '2026-10-25' })), '16:20');
});

test('position during the day: current, next, after the planned home time', () => {
  const r = computeDay({ plans: [theaterDay], date: WED });
  const at = (t) => positionAt(r, Number(t.slice(0, 2)) * 60 + Number(t.slice(3)));
  assert.equal(at('07:30').before, true);
  assert.equal(at('07:30').next.type, 'lesson');
  assert.equal(at('13:30').current.type, 'care');
  assert.equal(at('13:30').next.title, 'Theater');
  assert.equal(at('16:10').current.type, 'travel');
  assert.equal(at('17:00').after, true);
  assert.equal(at('17:00').current, null, 'after the planned time nothing claims the child is at home');
});

test('lessons by period: times come from the raster, a missing raster keeps the day open', () => {
  const raster = { id: 'r1', kind: 'periods', name: 'GS', periods: [
    { n: 1, start: '08:00', end: '08:45' }, { n: 2, start: '08:50', end: '09:35' },
    { n: 3, start: '09:55', end: '10:40' }, { n: 4, start: '10:45', end: '11:30' },
    { n: 5, start: '11:45', end: '12:30' }, { n: 6, start: '12:35', end: '13:20' },
  ] };
  const p = plan({ 1: { lessons: [{ period_from: 1, period_to: 6, title: 'Unterricht' }], care: [{ start: '13:20', end: '15:00' }], end: { mode: 'home' } } }, { periods_id: 'r1' });
  const r = computeDay({ plans: [p], date: MON, rasters: [raster] });
  assert.equal(r.status, STATUS.OK);
  assert.deepEqual([fromMinutes(r.segments[0].start), fromMinutes(r.segments[0].end)], ['08:00', '13:20']);
  assert.equal(home(r), '15:20');

  // Die Schule verschiebt die 6. Stunde: nur das Raster aendert sich.
  const later = { ...raster, periods: raster.periods.map((x) => (x.n === 6 ? { ...x, end: '13:25' } : x)) };
  assert.equal(computeDay({ plans: [p], date: MON, rasters: [later] }).status, STATUS.OPEN, 'now lessons overlap the care start');

  const missing = computeDay({ plans: [p], date: MON, rasters: [] });
  assert.equal(missing.status, STATUS.OPEN);
  assert.deepEqual(codes(missing), ['period_missing']);
  const noSuchPeriod = computeDay({ plans: [plan({ 1: { lessons: [{ period_from: 1, period_to: 9, title: 'x' }], end: { mode: 'home' } } }, { periods_id: 'r1' })], date: MON, rasters: [raster] });
  assert.deepEqual(codes(noSuchPeriod), ['period_missing']);

  const early = computeDay({ plans: [p], exceptions: [{ kind: 'exception', date: MON, lessons: { end: '11:30' } }], date: MON, rasters: [raster] });
  assert.equal(fromMinutes(early.segments[0].end), '11:30', 'an early end cuts the period block');
});
