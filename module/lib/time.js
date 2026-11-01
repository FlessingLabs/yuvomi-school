/**
 * Stundenplan - Uhrzeiten und Kalendertage
 *
 * Ein Plan beschreibt WANDUHRZEITEN ("13:00") an KALENDERTAGEN ("2026-11-05")
 * des Haushalts. Gerechnet wird deshalb in Minuten seit Mitternacht und mit
 * Datumstexten - nie mit Date-Objekten in der Zeitzone des Geraets. Welcher Tag
 * "heute" ist und wie spaet es gerade ist, sagt `nowInZone()` fuer die
 * Haushaltszone (Yuvomi: GET /preferences -> timezone_effective). So ist ein
 * Kind um 16:20 zu Hause, auch am Tag der Zeitumstellung, und auf einem Handy
 * im Urlaub in einer anderen Zone.
 */

const TIME_RE = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "13:05" -> 785; alles andere -> null. */
export function toMinutes(text) {
  const m = TIME_RE.exec(String(text ?? '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** 785 -> "13:05". Werte ueber 24 Stunden laufen in den naechsten Tag ("24:10" gibt es nicht). */
export function fromMinutes(min) {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export function isDate(text) {
  const m = DATE_RE.exec(String(text ?? ''));
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/** Tage seit 1970-01-01 fuer ein Datum - reine Kalenderrechnung, keine Zone. */
export function dayNumber(date) {
  const [y, mo, d] = date.split('-').map(Number);
  return Math.round(Date.UTC(y, mo - 1, d) / 86_400_000);
}

export function fromDayNumber(n) {
  const d = new Date(n * 86_400_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export function addDays(date, n) {
  return fromDayNumber(dayNumber(date) + n);
}

/** ISO-Wochentag: 1 = Montag ... 7 = Sonntag. */
export function weekday(date) {
  const wd = ((dayNumber(date) % 7) + 7 + 3) % 7; // 1970-01-01 war ein Donnerstag
  return wd + 1;
}

/** Der Montag der Woche, in der `date` liegt. */
export function mondayOf(date) {
  return addDays(date, 1 - weekday(date));
}

/**
 * A- oder B-Woche: gezaehlt in ganzen Kalenderwochen ab dem Montag der Woche
 * von `anchor` (einer A-Woche). Ferien verschieben den Rhythmus NICHT; eine
 * Schule, die nach den Ferien neu mit A beginnt, bekommt einen neuen Plan oder
 * einen neuen Anker. Vor dem Anker wird rueckwaerts gezaehlt.
 */
export function abWeek(date, anchor) {
  const weeks = Math.round((dayNumber(mondayOf(date)) - dayNumber(mondayOf(anchor))) / 7);
  return ((weeks % 2) + 2) % 2 === 0 ? 'A' : 'B';
}

/**
 * Kalendertag und Minute JETZT in der Zone `timeZone` (IANA, z. B.
 * "Europe/Berlin"). `instant` ist fuer Tests.
 */
export function nowInZone(timeZone, instant = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(instant).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}
