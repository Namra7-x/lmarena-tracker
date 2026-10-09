/**
 * Arena leaderboard parser.
 *
 * Supports the legacy initialModels registry and the current arena.ai
 * leaderboard's streamed Next.js payload (modelKey/modelDisplayName records).
 * No third-party dependencies are required.
 */

const LEADERBOARD_SCHEMA = 'arena-leaderboard-rsc-v1';
const LEGACY_SCHEMA = 'legacy-initialModels-v1';

export function hasArenaModelPayload(html) {
  return typeof html === 'string' && (
    html.includes('initialModels') ||
    (html.includes('modelKey') && html.includes('modelDisplayName'))
  );
}

export function decodeNextJsPayload(html) {
  const pushRe = /self\.__next_f\.push\(\[1,"((?:\\.|[^"\\])*)"\]\)/gs;
  const parts = [];
  let match;
  while ((match = pushRe.exec(html)) !== null) {
    const raw = match[1];
    try {
      parts.push(JSON.parse('"' + raw + '"'));
    } catch {
      parts.push(raw);
    }
  }
  return parts.join('');
}

function extractJsonArray(text, key = '"initialModels":') {
  const idx = text.indexOf(key);
  if (idx === -1) return null;

  const start = text.indexOf('[', idx + key.length);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const c = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }

    if (c === '"') inString = true;
    else if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return null;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseLegacyModels(texts) {
  for (const text of texts) {
    const rawArray = extractJsonArray(text);
    if (!rawArray) continue;

    try {
      const models = JSON.parse(rawArray);
      if (!Array.isArray(models)) continue;

      const map = {};
      for (const model of models) {
        if (model && typeof model.id === 'string' && model.id.trim()) {
          map[model.id] = model;
        }
      }
      if (Object.keys(map).length > 0) return map;
    } catch {
      // Try the next text representation, then the current schema.
    }
  }
  return null;
}

/**
 * Walk object boundaries in the decoded stream. Each completed object is
 * considered independently, avoiding assumptions about the names/order of
 * leaderboard sections (text, code, agent, vision, etc.).
 */
function extractLeaderboardRows(text) {
  const rows = [];
  const objectStarts = [];
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }

    if (c === '"') {
      inString = true;
      continue;
    }

    if (c === '{') {
      objectStarts.push(i);
      continue;
    }

    if (c !== '}') continue;

    const start = objectStarts.pop();
    if (start === undefined) continue;

    const length = i - start + 1;
    // A leaderboard row is small. Skipping huge parent objects avoids
    // repeatedly parsing entire leaderboard arrays.
    if (length > 16000) continue;

    const candidate = text.slice(start, i + 1);
    if (!candidate.includes('"modelKey"') ||
        !candidate.includes('"modelDisplayName"')) continue;

    try {
      const row = JSON.parse(candidate);
      if (
        isPlainObject(row) &&
        typeof row.modelKey === 'string' &&
        row.modelKey.trim() &&
        typeof row.modelDisplayName === 'string' &&
        row.modelDisplayName.trim()
      ) {
        rows.push(row);
      }
    } catch {
      // RSC includes non-JSON framing as well as JSON fragments.
    }
  }

  return rows;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function normalizeLeaderboardRow(row) {
  const id = row.modelKey.trim();
  const displayName = nonEmptyString(row.modelDisplayName) || id;
  const rawOrg = row.organization ?? row.organizationName ?? row.org;
  const rawProvider = row.provider ?? row.providerName;
  const capabilities = isPlainObject(row.capabilities)
    ? row.capabilities
    : {
        inputCapabilities: isPlainObject(row.inputCapabilities) ? row.inputCapabilities : {},
        outputCapabilities: isPlainObject(row.outputCapabilities) ? row.outputCapabilities : {},
      };

  const ranks = [
    row.rank,
    ...(isPlainObject(row.rankByModality) ? Object.values(row.rankByModality) : []),
  ].filter((rank) => Number.isFinite(rank) && rank >= 0);

  return {
    ...row,
    id,
    publicName: nonEmptyString(row.publicName) || displayName,
    name: nonEmptyString(row.name) || id,
    displayName,
    organization: typeof rawOrg === 'string' ? rawOrg : '',
    provider: typeof rawProvider === 'string' ? rawProvider : '',
    userSelectable: typeof row.userSelectable === 'boolean' ? row.userSelectable : null,
    rank: ranks.length ? Math.min(...ranks) : Number.MAX_SAFE_INTEGER,
    rankByModality: isPlainObject(row.rankByModality) ? { ...row.rankByModality } : {},
    capabilities,
    __sourceSchema: LEADERBOARD_SCHEMA,
    __organizationAvailable: rawOrg !== undefined,
  };
}

function mergeDuplicate(existing, incoming) {
  const merged = { ...existing };

  const ranks = [existing.rank, incoming.rank].filter(
    (rank) => Number.isFinite(rank) && rank >= 0 && rank !== Number.MAX_SAFE_INTEGER
  );
  merged.rank = ranks.length ? Math.min(...ranks) : Number.MAX_SAFE_INTEGER;
  merged.rankByModality = {
    ...(existing.rankByModality || {}),
    ...(incoming.rankByModality || {}),
  };

  for (const field of ['organization', 'provider']) {
    if (!merged[field] && incoming[field]) merged[field] = incoming[field];
  }
  if (merged.userSelectable == null && incoming.userSelectable != null) {
    merged.userSelectable = incoming.userSelectable;
  }
  merged.__organizationAvailable =
    Boolean(existing.__organizationAvailable) || Boolean(incoming.__organizationAvailable);

  const oldCaps = existing.capabilities || {};
  const newCaps = incoming.capabilities || {};
  merged.capabilities = {
    ...oldCaps,
    ...newCaps,
    inputCapabilities: {
      ...(oldCaps.inputCapabilities || {}),
      ...(newCaps.inputCapabilities || {}),
    },
    outputCapabilities: {
      ...(oldCaps.outputCapabilities || {}),
      ...(newCaps.outputCapabilities || {}),
    },
  };

  if ((!merged.displayName || merged.displayName === merged.id) && incoming.displayName) {
    merged.displayName = incoming.displayName;
    merged.publicName = incoming.publicName || incoming.displayName;
  }

  // Vote/rating data can vary by leaderboard category; retain the highest-vote
  // record for those diagnostics while preserving the best available rank.
  if (Number(incoming.votes || 0) > Number(existing.votes || 0)) {
    if (incoming.rating !== undefined) merged.rating = incoming.rating;
    if (incoming.votes !== undefined) merged.votes = incoming.votes;
  }

  return merged;
}

export function parseModelsFromHtml(html) {
  if (typeof html !== 'string' || !html.length) {
    throw new Error('Arena response is empty');
  }

  const decoded = decodeNextJsPayload(html);
  const legacy = parseLegacyModels([decoded, html]);
  if (legacy) return legacy;

  const rows = extractLeaderboardRows(decoded);
  const models = {};

  for (const row of rows) {
    const normalized = normalizeLeaderboardRow(row);
    models[normalized.id] = models[normalized.id]
      ? mergeDuplicate(models[normalized.id], normalized)
      : normalized;
  }

  if (Object.keys(models).length === 0) {
    throw new Error('No model records found: expected initialModels or modelKey/modelDisplayName rows');
  }

  return models;
}

export function getSnapshotSchema(models) {
  const values = Object.values(models || {});
  if (values.length === 0) return 'empty';
  const schemas = new Set(values.map((model) => model?.__sourceSchema || LEGACY_SCHEMA));
  return schemas.size === 1 ? [...schemas][0] : 'mixed';
}

export const LEADERBOARD_SCHEMA_ID = LEADERBOARD_SCHEMA;
export const LEGACY_SCHEMA_ID = LEGACY_SCHEMA;
