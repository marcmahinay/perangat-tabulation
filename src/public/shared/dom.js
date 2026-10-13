// Tiny DOM helpers. Text always goes in as text nodes, never as HTML, so names
// typed by the tabulator can never inject markup.

/** h('button', { class: 'btn', onclick: fn }, 'Save') */
export function h(tag, attrs, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') element.className = value;
    else if (key.startsWith('on')) element.addEventListener(key.slice(2), value);
    else if (key === 'style' || key.includes('-') || !(key in element)) element.setAttribute(key, value === true ? '' : value);
    else element[key] = value;
  }
  element.append(...children.flat(Infinity).filter((child) => child != null && child !== false));
  return element;
}

export function clear(element) {
  element.replaceChildren();
  return element;
}

/** Fixed-decimal number, or a dash when there is nothing to show. */
export function fmt(value, places = 2) {
  return value == null ? '–' : Number(value).toFixed(places);
}

/** Number without trailing zeros: 35 -> "35", 32.5 -> "32.5". */
export function plain(value) {
  return value == null ? '' : String(Number(value));
}

/** 370 -> "6:10" */
export function clock(seconds) {
  if (seconds == null) return '';
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** "6:10" -> 370, "6" -> 360. Returns null when the text is not a time. */
export function parseClock(text) {
  const value = String(text).trim();
  let match = /^(\d{1,3}):([0-5]\d)$/.exec(value);
  if (match) return Number(match[1]) * 60 + Number(match[2]);
  match = /^(\d{1,3})$/.exec(value);
  return match ? Number(match[1]) * 60 : null;
}

/** SQLite stores UTC "YYYY-MM-DD HH:MM:SS"; show it in local time. */
export function localTime(sqliteUtc) {
  if (!sqliteUtc) return '';
  const date = new Date(`${sqliteUtc.replace(' ', 'T')}Z`);
  return Number.isNaN(date.getTime()) ? sqliteUtc : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}
