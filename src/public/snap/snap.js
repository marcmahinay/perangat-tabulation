// A judge's phone, linked from their scoresheet, used as a camera: it photographs
// the judge's paper sheet and sends it to be read. The scores appear on the
// judge's own device, where the judge checks them; nothing is saved from here.

import { h, clear } from '/shared/dom.js';
import { request } from '/shared/api.js';
import { photoDataUrl } from '/shared/photo.js';

const TOKEN_KEY = 'perangat.phone.token';

const root = document.getElementById('app');

let token = readToken();
let me = null;           // GET /api/snap/me
let categoryId = null;   // the category being photographed
let photoUrl = null;     // preview of the last photo, released before the next

function readToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function storeToken(value) {
  token = value;
  try {
    if (value) localStorage.setItem(TOKEN_KEY, value);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Private browsing: the link lasts until the tab is closed.
  }
}

function screen(...children) {
  clear(root).append(h('div', { class: 'snap' },
    h('img', { class: 'snap-logo', src: '/shared/logos/anniversary-97.png', alt: '97th Provincial Anniversary' }),
    children));
}

async function api(method, path, body) {
  try {
    return await request(method, `/api/snap${path}`, body, token);
  } catch (error) {
    if (error.status === 401) {
      storeToken(null);
      showLink(error.message);
    }
    throw error;
  }
}

// ---- Linking ------------------------------------------------------------------

async function link(code) {
  try {
    const linked = await request('POST', '/api/snap/link', { code });
    storeToken(linked.token);
    history.replaceState(null, '', location.pathname);
    start();
  } catch (error) {
    showLink(error.message);
  }
}

function showLink(notice) {
  const code = h('input', { type: 'text', inputMode: 'numeric', autocomplete: 'one-time-code', maxLength: 6, required: true });
  screen(
    h('h1', null, 'Link this phone'),
    h('p', { class: 'muted' }, 'On your scoresheet, press Scan with phone and point this phone\'s camera at the code shown. Or type the six-digit code here.'),
    notice && h('p', { class: 'form-error' }, notice),
    h('form', {
      onsubmit: (event) => {
        event.preventDefault();
        link(code.value.trim());
      },
    },
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Link code'), code),
      h('button', { class: 'btn primary big', type: 'submit' }, 'Link this phone'),
    ),
  );
}

// ---- Taking photos --------------------------------------------------------------

function showCamera(status) {
  const open = me.categories.filter((category) => category.status !== 'submitted');
  if (!open.some((category) => category.id === categoryId)) categoryId = open.length ? open[0].id : null;

  const select = h('select', {
    onchange: () => {
      categoryId = Number(select.value);
      showCamera();
    },
  }, open.map((category) => h('option', { value: category.id }, category.name)));
  if (categoryId) select.value = categoryId;

  const input = h('input', {
    type: 'file', accept: 'image/*', capture: 'environment', hidden: true,
    onchange: () => {
      send(input.files[0]);
      input.value = '';
    },
  });
  const judgeLabel = me.judge.name === `Judge ${me.judge.judge_no}` ? me.judge.name : `Judge ${me.judge.judge_no} — ${me.judge.name}`;

  screen(
    h('p', { class: 'who' }, me.event.name),
    h('h1', null, judgeLabel),
    open.length
      ? [
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Scoresheet'), select),
        h('button', { class: 'btn primary big', type: 'button', disabled: Boolean(status && status.busy), onclick: () => input.click() },
          status && status.busy ? 'Reading the photo…' : 'Photograph my scoresheet'),
        input,
        h('p', { class: 'muted' }, 'Lay the sheet flat in good light and fit the whole table in the picture.'),
      ]
      : h('p', { class: 'muted' }, 'Every one of your scoresheets has been submitted. There is nothing left to photograph.'),
    status && status.busy && h('p', { class: 'status' }, 'This can take up to a minute. Keep this page open.'),
    status && status.done && h('div', { class: 'status ok' },
      h('p', { class: 'strong' }, `${status.done.read} score${status.done.read === 1 ? '' : 's'} read.`),
      h('p', null, status.done.delivered
        ? 'They are on your scoresheet now. Check them there against your paper, then fill them in.'
        : 'Open your scoresheet on your own device to check them and fill them in.'),
      status.done.flagged > 0 && h('p', null, `${status.done.flagged} could not be read for sure; you will type those in.`),
    ),
    status && status.error && h('p', { class: 'form-error' }, status.error),
    photoUrl && h('img', { class: 'last-photo', src: photoUrl, alt: 'Last photo sent' }),
    h('button', { class: 'btn link-button', type: 'button', onclick: unlink }, 'Unlink this phone'),
  );
}

async function send(file) {
  if (!file) return;
  let photo;
  try {
    photo = await photoDataUrl(file);
  } catch {
    showCamera({ error: 'That file could not be opened as a photo.' });
    return;
  }
  if (photoUrl) URL.revokeObjectURL(photoUrl);
  photoUrl = photo.url;
  showCamera({ busy: true });
  try {
    const done = await api('POST', '/scan', { categoryId, image: photo.data });
    showCamera({ done });
  } catch (error) {
    if (error.status !== 401) showCamera({ error: error.message });
  }
}

async function unlink() {
  await request('POST', '/api/snap/unlink', {}, token).catch(() => {});
  storeToken(null);
  if (photoUrl) URL.revokeObjectURL(photoUrl);
  photoUrl = null;
  showLink();
}

async function start() {
  // The QR code on the scoresheet opens this page with the code after "#".
  const code = location.hash.replace('#', '');
  if (/^\d{6}$/.test(code)) {
    await link(code);
    return;
  }
  if (!token) {
    showLink();
    return;
  }
  try {
    me = await api('GET', '/me');
    showCamera();
  } catch (error) {
    if (error.status !== 401) screen(h('h1', null, 'Cannot connect'), h('p', { class: 'muted' }, error.message), h('button', { class: 'btn primary big', onclick: start }, 'Try again'));
  }
}

start();
