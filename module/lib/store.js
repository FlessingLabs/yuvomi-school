/**
 * Stundenplan - Daten im Yuvomi-Modulspeicher
 *
 * Jeder Plan und jede Tagesausnahme ist ein Datensatz, der EINEM Kind gehoert
 * (`subject_id` = dessen Yuvomi-Benutzer-Id). Wer welche Datensaetze sehen oder
 * aendern darf, entscheidet Yuvomi auf dem Server (Freigaben pro Person,
 * Migration 275) - diese Datei schickt nur Anfragen und uebersetzt Antworten.
 * Eine ausgeblendete Schaltflaeche ist hier nie die Sicherung.
 *
 * `api` ist Yuvomis `/api.js`-Client oder im Test eine Attrappe.
 */

export const MODULE_ID = 'flessinglabs-school';
const BASE = `/modules/${MODULE_ID}`;

export class StoreError extends Error {
  /**
   * @param {string} reason  conflict | not_found | forbidden | storage_full | storage_unavailable |
   *                         storage_unsupported | persons_unsupported | invalid | failed
   */
  constructor(reason, message = reason, status = 0) {
    super(message);
    this.name = 'StoreError';
    this.reason = reason;
    this.status = status;
  }
}

function translate(err) {
  if (err instanceof StoreError || err?.name === 'AbortError') return err;
  const status = err?.status ?? 0;
  const reason = err?.data?.reason ?? null;
  if (status === 404 && reason === 'module_storage_unavailable') return new StoreError('storage_unavailable', err.message, 404);
  // Die Route gibt es nicht: Yuvomi ohne Modulspeicher bzw. ohne Personen (Migration 275).
  if (status === 404 && !reason) return new StoreError('storage_unsupported', err.message, 404);
  if (status === 404) return new StoreError('not_found', err.message, 404);
  if (status === 409) return new StoreError('conflict', err.message, 409);
  if (status === 403) return new StoreError('forbidden', err.message, 403);
  if (status === 413) return new StoreError('storage_full', err.message, 413);
  if (status === 400) return new StoreError('invalid', err.message, 400);
  return new StoreError('failed', err?.message || 'failed', status);
}

async function call(fn) {
  try {
    return await fn();
  } catch (err) {
    throw translate(err);
  }
}

/** Datensatz -> { id, revision, subject_id, ...data } */
function fromRecord(r) {
  return { ...r.data, id: String(r.id), revision: r.revision, subject_id: r.subject_id ?? null };
}

/** Nur die Daten eines Eintrags, ohne die Felder, die der Server vergibt. */
export function dataOf(entry) {
  const { id, revision, subject_id: _s, ...data } = entry;
  return data;
}

export function createStore(api) {
  return {
    /** Die Personen, deren Plaene der Angemeldete sehen darf, mit `access` read|write. */
    async people({ signal } = {}) {
      const res = await call(() => api.get(`${BASE}/people`, { signal }));
      // Ein Yuvomi mit Modulspeicher, aber ohne Personen-Freigaben (nur
      // Migration 274) kennt /people nicht - dann gaebe es keine Trennung
      // zwischen den Kindern. Das wird nicht ueberspielt.
      if (!Array.isArray(res?.data)) throw new StoreError('persons_unsupported');
      return res.data;
    },

    /** Alle Plaene und Ausnahmen einer Person. */
    async load(subjectId, { signal } = {}) {
      const plans = [];
      const exceptions = [];
      let after = '';
      for (let page = 0; page < 50; page++) {
        const q = `?subject_id=${encodeURIComponent(subjectId)}&limit=200${after ? `&after=${encodeURIComponent(after)}` : ''}`;
        const res = await call(() => api.get(`${BASE}/records${q}`, { signal }));
        for (const r of res?.data ?? []) {
          if (r.subject_id !== subjectId) continue; // haushaltsweite Datensaetze gehoeren nicht zu einem Kind
          const e = fromRecord(r);
          if (e.kind === 'plan') plans.push(e);
          else if (e.kind === 'exception') exceptions.push(e);
        }
        if (!res?.next) break;
        after = res.next;
      }
      plans.sort((a, b) => (a.valid_from ?? '').localeCompare(b.valid_from ?? '') || a.id.localeCompare(b.id));
      return { plans, exceptions };
    },

    async create(subjectId, data) {
      const res = await call(() => api.post(`${BASE}/records`, { subject_id: subjectId, data }));
      // Ein Yuvomi ohne Personen-Datensaetze ignoriert subject_id still und
      // speichert haushaltsweit. Dann den Datensatz sofort zuruecknehmen.
      if (res?.data?.subject_id !== subjectId) {
        await call(() => api.delete(`${BASE}/records/${encodeURIComponent(res.data.id)}?revision=${res.data.revision}`)).catch(() => {});
        throw new StoreError('persons_unsupported');
      }
      return fromRecord(res.data);
    },

    /** Ersetzen mit der Revision, die `current` traegt - nie still mit einer neueren. */
    async update(current, data) {
      const res = await call(() => api.put(`${BASE}/records/${encodeURIComponent(current.id)}`, { data, revision: current.revision }));
      return fromRecord(res.data);
    },

    async remove(current) {
      await call(() => api.delete(`${BASE}/records/${encodeURIComponent(current.id)}?revision=${current.revision}`));
    },

    async get(id) {
      try {
        return fromRecord((await call(() => api.get(`${BASE}/records/${encodeURIComponent(id)}`))).data);
      } catch (err) {
        if (err.reason === 'not_found') return null;
        throw err;
      }
    },

    // Freigaben - nur fuer Admins; der Server weist alle anderen ab.
    async grants() {
      return (await call(() => api.get(`${BASE}/grants`))).data ?? {};
    },
    async setGrants(subjectId, grants) {
      return (await call(() => api.put(`${BASE}/grants/${encodeURIComponent(subjectId)}`, { grants }))).data;
    },
  };
}
