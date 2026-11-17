/**
 * Compressed baseline helpers for full string / URL sets.
 *
 * The GitHub Actions workflow only commits `*.json` on the state branch, so
 * these helpers keep the full set gzip-compressed and base64-encoded inside
 * the component JSON. This gives us a true previous-release baseline without
 * requiring a workflow change or a second state branch.
 */

import crypto from 'node:crypto';
import zlib from 'node:zlib';

const MAX_BASELINE_STRINGS = Infinity;
const MAX_BASELINE_URLS = Infinity;

function normalizeValues(values, limit = Infinity) {
  const seen = new Set();
  for (const value of values || []) {
    if (typeof value !== 'string') continue;
    const clean = value.trim();
    if (!clean) continue;
    seen.add(clean);
    if (Number.isFinite(limit) && seen.size >= limit) break;
  }
  return Array.from(seen).sort();
}

export function encodeStringSet(values = [], limit = Infinity) {
  const unique = normalizeValues(values, limit);
  const raw = Buffer.from(unique.join('\n'), 'utf8');
  return {
    schema: 2,
    encoding: 'gzip+base64',
    count: unique.length,
    data: zlib.gzipSync(raw, { level: 9 }).toString('base64'),
  };
}

export function decodeStringSet(encoded, fallback = []) {
  if (!encoded) return Array.isArray(fallback) ? fallback : [];
  if (Array.isArray(encoded)) return encoded;
  if (typeof encoded === 'string') return encoded.split('\n').filter(Boolean);

  if (encoded.data) {
    try {
      const raw = zlib.gunzipSync(Buffer.from(encoded.data, 'base64'));
      return raw.toString('utf8').split('\n').filter(Boolean);
    } catch {
      // Fall through to the legacy array if the compressed payload is corrupt.
    }
  }

  return Array.isArray(fallback) ? fallback : [];
}

export function encodeUrlSet(values = [], limit = Infinity) {
  return encodeStringSet(values, limit);
}

export function decodeUrlSet(encoded, fallback = []) {
  return decodeStringSet(encoded, fallback);
}

/**
 * Exact set diff with a separate historical set.
 *
 * - added: in current, never seen before
 * - reintroduced: in current, seen before, but not in the immediately previous release
 * - removed: in previous, not in current
 * - persistent: in both
 */
export function diffStringSets(previousValues = [], currentValues = [], historyValues = []) {
  const previous = new Set(previousValues);
  const current = new Set(currentValues);
  const history = new Set(historyValues);

  const added = [];
  const removed = [];
  const persistent = [];
  const reintroduced = [];

  for (const value of current) {
    if (previous.has(value)) {
      persistent.push(value);
    } else if (history.has(value)) {
      reintroduced.push(value);
    } else {
      added.push(value);
    }
  }

  for (const value of previous) {
    if (!current.has(value)) removed.push(value);
  }

  added.sort();
  removed.sort();
  persistent.sort();
  reintroduced.sort();

  return {
    added,
    removed,
    persistent,
    reintroduced,
    counts: {
      current: current.size,
      previous: previous.size,
      added: added.length,
      removed: removed.length,
      persistent: persistent.length,
      reintroduced: reintroduced.length,
    },
  };
}

export function mergeStringSets(...sets) {
  const merged = new Set();
  for (const set of sets) {
    for (const value of set || []) {
      if (typeof value === 'string' && value) merged.add(value);
    }
  }
  return Array.from(merged).sort();
}

/**
 * Stable release key. Deliberately excludes ETag and Last-Modified; those are
 * diagnostics. The version/releaseId pair is stable across CDN header flips.
 */
export function computeReleaseKey(componentId, candidate) {
  const payload = [
    componentId,
    String(candidate?.version || ''),
    String(candidate?.releaseId || ''),
    String(candidate?.channel || 'stable'),
  ].join('|');
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, 32);
}

/**
 * Build a baseline object from a raw array or an existing compressed state.
 */
export function baselineFromState(state, legacyKey = 'historicalSeenHashes') {
  if (state?.stringBaseline) {
    return decodeStringSet(state.stringBaseline, state?.[legacyKey] || []);
  }
  return Array.isArray(state?.[legacyKey]) ? state[legacyKey] : [];
}

export function urlBaselineFromState(state) {
  if (state?.urlBaseline) {
    return decodeUrlSet(state.urlBaseline, state?.historicalSeenUrls || []);
  }
  return Array.isArray(state?.historicalSeenUrls) ? state.historicalSeenUrls : [];
}

export function stringHistoryFromState(state, fallback = []) {
  if (state?.stringHistory) {
    return decodeStringSet(state.stringHistory, fallback);
  }
  return Array.isArray(fallback) ? fallback : [];
}

export function urlHistoryFromState(state, fallback = []) {
  if (state?.urlHistory) {
    return decodeUrlSet(state.urlHistory, fallback);
  }
  return Array.isArray(fallback) ? fallback : [];
}
