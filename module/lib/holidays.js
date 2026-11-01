/**
 * Stundenplan - Ferien und Feiertage aus Yuvomi
 *
 * Quelle ist Yuvomis eigene Ferienfunktion: GET /calendar/holidays?from&to
 * (gesetzliche Feiertage und Schulferien des eingestellten Landes / der Region).
 * Was sie NICHT weiss, wird nicht behauptet:
 *
 *   - Keine Ferien eingestellt, Schulferien ausgeschaltet oder kein Recht auf
 *     den Kalender: jeder Tag ohne bekannten Feiertag gilt als 'unknown', und
 *     die Seite sagt "Ferien werden nicht beruecksichtigt".
 *   - Nur gesetzliche Feiertage eingeschaltet: Feiertage werden erkannt,
 *     Schulferien nicht - ebenfalls 'unknown' fuer alle anderen Tage.
 */
import { addDays } from './time.js';

/**
 * @returns {Promise<{ coverage: 'full'|'public_only'|'none'|'unavailable', holidayFor: (date: string) => null|'unknown'|{type, name} }>}
 */
export async function loadHolidays(api, from, to, { signal } = {}) {
  let prefs;
  try {
    prefs = (await api.get('/preferences', { signal }))?.data ?? {};
  } catch {
    prefs = {};
  }
  const showPublic = Boolean(prefs.holiday_show_public);
  const showSchool = Boolean(prefs.holiday_show_school);
  if (!prefs.holiday_country || (!showPublic && !showSchool)) {
    return { coverage: 'none', holidayFor: () => 'unknown' };
  }

  let rows;
  try {
    rows = (await api.get(`/calendar/holidays?from=${from}&to=${to}`, { signal }))?.data ?? [];
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    return { coverage: 'unavailable', holidayFor: () => 'unknown' };
  }

  const byDate = new Map();
  for (const r of rows) {
    for (let d = r.start_date; d <= r.end_date && d <= to; d = addDays(d, 1)) {
      if (d < from) continue;
      // Ein Feiertag in den Ferien bleibt ein Feiertag - beides heisst "kein Unterricht".
      if (!byDate.has(d) || r.type === 'public') byDate.set(d, { type: r.type, name: r.name });
    }
  }
  const coverage = showSchool ? 'full' : 'public_only';
  return {
    coverage,
    holidayFor: (date) => byDate.get(date) ?? (showSchool ? null : 'unknown'),
  };
}
