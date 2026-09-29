'use strict';

// ---- Config ---------------------------------------------------------------
// Your deployed Cloudflare Worker URL (no trailing slash). Must also be listed
// in connect-src of the CSP in index.html and _headers.
const API_BASE = 'https://wardogs-api.YOUR-SUBDOMAIN.workers.dev';

// WARDOGS Early Access launch: Sept 10, 2026 16:00 UTC (fixed).
const RELEASE_MS = Date.UTC(2026, 8, 10, 16, 0, 0);

const RECENT_KEY = 'wardogs.recent.v1';
const RECENT_MAX = 8;

// ---- Input parsing (strict allow-lists) ------------------------------------
const ID64_RE = /^7656119\d{10}$/;
const VANITY_RE = /^[A-Za-z0-9_-]{2,32}$/;

/** Returns { type: 'steamid'|'vanity', value } or null. */
function parseInput(raw) {
  const s = String(raw || '').trim();
  if (!s || s.length > 100) return null;

  if (/steamcommunity\.com/i.test(s)) {
    let url;
    try {
      url = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s);
    } catch {
      return null;
    }
    if (!/^(www\.)?steamcommunity\.com$/i.test(url.hostname)) return null;
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    if (parts[0] === 'profiles' && ID64_RE.test(parts[1])) return { type: 'steamid', value: parts[1] };
    if (parts[0] === 'id' && VANITY_RE.test(parts[1])) return { type: 'vanity', value: parts[1] };
    return null;
  }

  if (ID64_RE.test(s)) return { type: 'steamid', value: s };
  if (VANITY_RE.test(s)) return { type: 'vanity', value: s };
  return null;
}

// ---- DOM ------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const els = {
  sinceHours: $('since-hours'),
  sinceClock: $('since-clock'),
  releaseLocal: $('release-local'),
  form: $('search-form'),
  input: $('steam-input'),
  submit: $('submit-btn'),
  error: $('error'),
  recentWrap: $('recent-wrap'),
  recent: $('recent'),
  clearRecent: $('clear-recent'),
  result: $('result'),
  resultName: $('result-name'),
  played: $('played-hours'),
  since2: $('since-hours-2'),
  bar: $('bar'),
  barFill: $('bar-fill'),
  percent: $('percent-line'),
};

let playedMinutes = null;

// ---- Release timer ----------------------------------------------------------
function hoursSinceRelease(now = Date.now()) {
  return Math.max(0, (now - RELEASE_MS) / 3_600_000);
}

function pad(n) { return String(n).padStart(2, '0'); }

function tick() {
  const now = Date.now();
  const h = hoursSinceRelease(now);
  els.sinceHours.textContent = h.toFixed(4);

  const totalSec = Math.max(0, Math.floor((now - RELEASE_MS) / 1000));
  const d = Math.floor(totalSec / 86400);
  const hh = Math.floor((totalSec % 86400) / 3600);
  const mm = Math.floor((totalSec % 3600) / 60);
  const ss = totalSec % 60;
  els.sinceClock.textContent = `${d}d ${pad(hh)}:${pad(mm)}:${pad(ss)}`;

  if (playedMinutes !== null) renderComparison(h);
}

function renderComparison(sinceH) {
  const playedH = playedMinutes / 60;
  const pct = sinceH > 0 ? (playedH / sinceH) * 100 : 0;
  els.played.textContent = playedH.toFixed(1);
  els.since2.textContent = sinceH.toFixed(1);
  els.barFill.style.width = Math.min(100, pct).toFixed(3) + '%';
  els.bar.setAttribute('aria-valuenow', Math.min(100, pct).toFixed(1));

  els.percent.replaceChildren(
    'That’s ',
    Object.assign(document.createElement('strong'), { textContent: pct.toFixed(2) + '%' }),
    ' of all the time since WARDOGS launched.'
  );
}

// ---- Recent searches (localStorage, validated) -------------------------------
function loadRecent() {
  try {
    const arr = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    if (!Array.isArray(arr)) return [];
    return arr.filter((v) => typeof v === 'string' && parseInput(v)).slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

function saveRecent(list) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX))); } catch { /* storage unavailable */ }
}

function addRecent(value) {
  const list = loadRecent().filter((v) => v.toLowerCase() !== value.toLowerCase());
  list.unshift(value);
  saveRecent(list);
  renderRecent();
}

function renderRecent() {
  const list = loadRecent();
  els.recent.replaceChildren(
    ...list.map((v) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = v;
      b.addEventListener('click', () => {
        els.input.value = v;
        lookup(v);
      });
      li.append(b);
      return li;
    })
  );
  els.recentWrap.hidden = list.length === 0;
}

// ---- Lookup -------------------------------------------------------------------
const ERROR_TEXT = {
  not_found: 'No Steam profile found with that name.',
  private: 'That profile’s game details are private. Set Game details to Public in Steam privacy settings.',
  not_owned: 'That account doesn’t own WARDOGS (or it’s hidden).',
  bad_input: 'Enter a valid Steam username, SteamID64, or profile URL.',
  rate_limited: 'Too many requests. Wait a minute and try again.',
  upstream: 'Steam didn’t respond. Try again shortly.',
};

function showError(msg) {
  els.error.textContent = msg;
  els.error.hidden = false;
}

function clearError() {
  els.error.textContent = '';
  els.error.hidden = true;
}

let inFlight = false;

async function lookup(raw) {
  if (inFlight) return;
  clearError();

  const parsed = parseInput(raw);
  if (!parsed) {
    showError(ERROR_TEXT.bad_input);
    return;
  }

  inFlight = true;
  els.submit.disabled = true;
  els.submit.textContent = 'Loading…';

  try {
    const url = new URL('/playtime', API_BASE);
    url.searchParams.set(parsed.type, parsed.value);

    const res = await fetch(url, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(12000),
    });

    let data = null;
    try { data = await res.json(); } catch { /* ignore */ }

    if (!res.ok || !data || typeof data !== 'object') {
      const code = data && typeof data.error === 'string' ? data.error : 'upstream';
      showError(ERROR_TEXT[code] || ERROR_TEXT.upstream);
      return;
    }

    const minutes = Number(data.minutes);
    if (!Number.isFinite(minutes) || minutes < 0) {
      showError(ERROR_TEXT.upstream);
      return;
    }

    playedMinutes = minutes;
    const name = typeof data.name === 'string' ? data.name.slice(0, 64) : parsed.value;
    els.resultName.textContent = name;
    els.result.hidden = false;
    renderComparison(hoursSinceRelease());
    addRecent(parsed.value);
  } catch (err) {
    showError(navigator.onLine === false ? 'You’re offline.' : ERROR_TEXT.upstream);
  } finally {
    inFlight = false;
    els.submit.disabled = false;
    els.submit.textContent = 'Look up';
  }
}

// ---- Wire up ----------------------------------------------------------------------
els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  lookup(els.input.value);
});

els.clearRecent.addEventListener('click', () => {
  try { localStorage.removeItem(RECENT_KEY); } catch { /* ignore */ }
  renderRecent();
});

els.releaseLocal.textContent = new Date(RELEASE_MS).toLocaleString(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

renderRecent();
tick();
setInterval(tick, 1000);

if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js', { scope: './' }).catch(() => {});
  });
}
