/**
 * FlessingLabs Stundenplan - Einstellungen (nur fuer Admins)
 *
 * Pro Kind festlegen, wer dessen Plaene sieht (`read`) oder pflegt (`write`).
 * Das Kind selbst sieht seinen Plan immer, Admins duerfen immer alles. Die
 * Freigaben speichert und prueft Yuvomi (PUT /modules/:id/grants/:person);
 * Yuvomi zeigt diese Seite nur Admins und weist alle anderen auch auf dem
 * Server ab. Nichts wird aus Rollen, Namen oder Alter abgeleitet.
 */
import { api } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { showToast } from '/utils/toast-show.js';
import { createStore } from './lib/store.js';

const ID = 'flessinglabs-school';
const tr = (key, params) => t(`extensions.${ID}.${key}`, params);

export async function render(container, { section } = {}) {
  if (section !== 'household') return;
  const store = createStore(api);
  container.replaceChildren();
  let people;
  let grants;
  try {
    [people, grants] = await Promise.all([store.people(), store.grants()]);
  } catch (err) {
    const kind = { storage_unsupported: 'unsupported', persons_unsupported: 'unsupported', storage_unavailable: 'unavailable', forbidden: 'forbidden' }[err?.reason] ?? 'failed';
    container.insertAdjacentHTML('beforeend', `<p>${esc(tr(`error.load.${kind}.title`))}</p><p>${esc(tr(`error.load.${kind}.text`))}</p>`);
    return;
  }

  const blocks = people.map((child) => {
    const others = people.filter((p) => p.user_id !== child.user_id);
    const current = new Map((grants[child.user_id] ?? []).map((g) => [g.user_id, g.access]));
    return `
      <form class="sp-grants" data-person="${child.user_id}" data-name="${esc(child.display_name)}">
        <h3>${esc(tr('settings.for', { name: child.display_name }))}</h3>
        ${others.length ? others.map((o) => `
          <label class="sp-grants__row">
            <span>${esc(o.display_name)}</span>
            <select class="form-input" name="u${o.user_id}">
              ${['none', 'read', 'write'].map((a) => `<option value="${a}"${(current.get(o.user_id) ?? 'none') === a ? ' selected' : ''}>${esc(tr(`settings.${a}`))}</option>`).join('')}
            </select>
          </label>`).join('') : `<p>${esc(tr('settings.noOthers'))}</p>`}
        <button type="submit" class="btn btn--primary">${esc(tr('action.save'))}</button>
      </form>`;
  }).join('');

  container.insertAdjacentHTML('beforeend', `<p>${esc(tr('settings.intro'))}</p>${blocks}`);

  container.addEventListener('submit', async (e) => {
    const form = e.target.closest('form.sp-grants');
    if (!form) return;
    e.preventDefault();
    const subject = Number(form.dataset.person);
    const list = [];
    for (const el of form.elements) {
      if (el.tagName !== 'SELECT' || el.value === 'none') continue;
      list.push({ user_id: Number(el.name.slice(1)), access: el.value });
    }
    try {
      await store.setGrants(subject, list);
      showToast(tr('settings.saved', { name: form.dataset.name }), 'success');
    } catch (err) {
      showToast(tr(err?.reason === 'forbidden' ? 'error.forbidden' : 'error.generic'), 'danger');
    }
  });
}
