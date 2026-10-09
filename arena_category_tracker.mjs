import fs from 'node:fs';
import path from 'node:path';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hasArenaModelPayload, parseModelsFromHtml } from './arena_parser.mjs';

export const CATEGORY_SOURCES = [
  { name: 'text', url: 'https://arena.ai/leaderboard/chat/text', minModels: 100 },
  { name: 'vision', url: 'https://arena.ai/leaderboard/chat/vision', minModels: 50 },

  { name: 'text_math', url: 'https://arena.ai/leaderboard/text/math', minModels: 50 },
  { name: 'text_hard_prompts', url: 'https://arena.ai/leaderboard/text/hard-prompts', minModels: 50 },
  { name: 'text_instruction_following', url: 'https://arena.ai/leaderboard/text/instruction-following', minModels: 50 },
  { name: 'text_expert', url: 'https://arena.ai/leaderboard/text/expert', minModels: 50 },
  { name: 'text_creative_writing', url: 'https://arena.ai/leaderboard/text/creative-writing', minModels: 50 },
  { name: 'text_coding', url: 'https://arena.ai/leaderboard/chat/text/coding', minModels: 50 },
  { name: 'text_writing_literature_language', url: 'https://arena.ai/leaderboard/text/industry-writing-and-literature-and-language', minModels: 50 },

  { name: 'agent_overall', url: 'https://arena.ai/leaderboard/agent', minModels: 20 },
  { name: 'agent_code', url: 'https://arena.ai/leaderboard/agent/code', minModels: 20 },
  { name: 'agent_chat', url: 'https://arena.ai/leaderboard/agent/chat', minModels: 20 },
  { name: 'agent_work', url: 'https://arena.ai/leaderboard/agent/work', minModels: 20 },

  { name: 'code_webdev', url: 'https://arena.ai/leaderboard/code/webdev', minModels: 20 },
  { name: 'code_image_to_webdev', url: 'https://arena.ai/leaderboard/code/image-to-webdev', minModels: 10 },

  { name: 'text_to_image', url: 'https://arena.ai/leaderboard/text-to-image', minModels: 5 },
  { name: 'image_edit', url: 'https://arena.ai/leaderboard/image-edit/single-image-edit', minModels: 5 },
  { name: 'image_edit_multi', url: 'https://arena.ai/leaderboard/image/image-edit/multi-image', minModels: 10 },
  { name: 'image_edit_art', url: 'https://arena.ai/leaderboard/image-edit/art', minModels: 10 },
  { name: 'image_edit_commercial', url: 'https://arena.ai/leaderboard/image/image-edit/multi-image-commercial-design', minModels: 10 },
  { name: 'text_to_video', url: 'https://arena.ai/leaderboard/text-to-video', minModels: 5 },
  { name: 'image_to_video', url: 'https://arena.ai/leaderboard/image-to-video', minModels: 5 },
  { name: 'video_edit', url: 'https://arena.ai/leaderboard/video-edit', minModels: 5 },

  { name: 'document', url: 'https://arena.ai/leaderboard/document', minModels: 5 },
  { name: 'search', url: 'https://arena.ai/leaderboard/search', minModels: 5 },
];

const SNAPSHOT_FILE = process.env.CATEGORY_SNAPSHOT_FILE ||
  path.join(process.cwd(), 'category_snapshot.json');
const OVERVIEW_SNAPSHOT_FILE = process.env.OVERVIEW_SNAPSHOT_FILE ||
  path.join(process.cwd(), 'snapshot.json');
const SELECTOR_SNAPSHOT_FILE = process.env.SELECTOR_SNAPSHOT_FILE ||
  path.join(process.cwd(), 'selector_snapshot.json');

const IDENTITY_FIELDS = new Set([
  'id', 'modelKey', 'modelDisplayName', 'displayName', 'publicName', 'name',
  'rank', 'rankUpper', 'rankLower', 'rating', 'ratingUpper', 'ratingLower',
  'votes', 'rankByModality', 'organization', 'organizationName', 'modelOrganization',
  'provider', 'providerName', '__sourceSchema', '__organizationAvailable',
  'netImprovement', 'confirmedSuccess', 'praiseVsComplaint', 'steerability',
  'bashRecovery', 'toolHallucination', 'sessions', 'costPerTaskP50',
  'outputTokensPerTaskP50', 'inputPricePerMillion', 'outputPricePerMillion',
]);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stableValue(value) {
  if (Array.isArray(value)) {
    const normalized = value.map(stableValue);
    if (normalized.every((item) => item === null ||
        ['string', 'number', 'boolean'].includes(typeof item))) {
      return normalized.sort((a, b) => String(a).localeCompare(String(b)));
    }
    return normalized;
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  if (value === undefined || typeof value === 'function') return null;
  return value;
}

function finiteOrNull(value) {
  return Number.isFinite(value) && value < Number.MAX_SAFE_INTEGER ? value : null;
}

function normalizeText(value) {
  return String(value ?? '').trim().toLowerCase();
}

function isMeaningfulMetadata(value) {
  if (value === undefined || typeof value === 'function') return false;
  if (typeof value === 'string') return value.length <= 2000;
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.length <= 100;
  if (isPlainObject(value)) return Object.keys(value).length <= 100;
  return false;
}

export function normalizeCategoryModels(rawModels) {
  const result = {};

  for (const [key, raw] of Object.entries(rawModels || {})) {
    if (!raw || typeof raw !== 'object') continue;

    const modelKey = String(raw.modelKey || raw.id || key || '').trim();
    if (!modelKey) continue;
    const displayName = String(raw.displayName || raw.modelDisplayName || raw.publicName || modelKey).trim();
    const metadata = {};
    const metrics = {};
    for (const field of [
      'netImprovement', 'confirmedSuccess', 'praiseVsComplaint', 'steerability',
      'bashRecovery', 'toolHallucination', 'costPerTaskP50',
      'outputTokensPerTaskP50', 'inputPricePerMillion', 'outputPricePerMillion',
    ]) {
      if (Number.isFinite(raw[field])) metrics[field] = raw[field];
    }

    for (const [field, value] of Object.entries(raw)) {
      if (IDENTITY_FIELDS.has(field) || field.startsWith('__')) continue;
      if (isMeaningfulMetadata(value)) metadata[field] = stableValue(value);
    }

    result[modelKey] = {
      modelKey,
      displayName,
      organization: String(raw.modelOrganization || raw.organization || raw.organizationName || '').trim(),
      provider: String(raw.provider || raw.providerName || '').trim(),
      rank: finiteOrNull(raw.rank),
      rankUpper: finiteOrNull(raw.rankUpper),
      rankLower: finiteOrNull(raw.rankLower),
      rating: finiteOrNull(raw.rating),
      ratingUpper: finiteOrNull(raw.ratingUpper),
      ratingLower: finiteOrNull(raw.ratingLower),
      votes: finiteOrNull(raw.votes),
      rankByModality: isPlainObject(raw.rankByModality) ? stableValue(raw.rankByModality) : {},
      metrics,
      metadata,
    };
  }

  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

function sameValue(left, right) {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function scoreThreshold(value) {
  // Agent rankings use fraction-like scores; text rankings use Elo-like scores.
  return Math.abs(value) < 1 ? 0.005 : 3;
}

function metricChanges(before, after) {
  const changes = [];

  for (const field of ['rank', 'rankUpper', 'rankLower']) {
    const oldValue = before[field];
    const newValue = after[field];
    if (Number.isFinite(oldValue) && Number.isFinite(newValue) &&
        Math.abs(newValue - oldValue) >= 3) {
      changes.push({ field, before: oldValue, after: newValue });
    }
  }

  if (Number.isFinite(before.rating) && Number.isFinite(after.rating)) {
    const delta = after.rating - before.rating;
    if (Math.abs(delta) >= scoreThreshold(before.rating)) {
      changes.push({ field: 'rating', before: before.rating, after: after.rating });
    }
  }

  // Counts usually rise on every poll; alert only on a material decrease.
  if (Number.isFinite(before.votes) && Number.isFinite(after.votes) && after.votes < before.votes) {
    const drop = before.votes - after.votes;
    if (drop >= Math.max(100, before.votes * 0.15)) {
      changes.push({ field: 'votes decreased', before: before.votes, after: after.votes });
    }
  }

  const oldModalities = before.rankByModality || {};
  const newModalities = after.rankByModality || {};
  for (const modality of new Set([...Object.keys(oldModalities), ...Object.keys(newModalities)])) {
    const oldRank = oldModalities[modality];
    const newRank = newModalities[modality];
    if (Number.isFinite(oldRank) && Number.isFinite(newRank) && Math.abs(newRank - oldRank) >= 3) {
      changes.push({ field: 'rankByModality.' + modality, before: oldRank, after: newRank });
    }
  }

  // Agent rankings expose several dimensions besides the composite score.
  // Ignore tiny percentage fluctuations and routine token/session growth.
  if (isPlainObject(before.metrics) && isPlainObject(after.metrics)) {
    const allMetrics = new Set([...Object.keys(before.metrics), ...Object.keys(after.metrics)]);
    for (const field of allMetrics) {
      const oldValue = before.metrics[field];
      const newValue = after.metrics[field];
      if (!Number.isFinite(oldValue) || !Number.isFinite(newValue)) continue;
      let threshold = 0.005;
      if (field === 'costPerTaskP50' || field.includes('PricePerMillion')) {
        threshold = Math.max(0.01, Math.abs(oldValue) * 0.15);
      } else if (field === 'outputTokensPerTaskP50') {
        threshold = Math.max(1000, Math.abs(oldValue) * 0.15);
      }
      if (Math.abs(newValue - oldValue) >= threshold) {
        changes.push({ field: 'metrics.' + field, before: oldValue, after: newValue });
      }
    }
  }

  return changes;
}

export function diffCategoryModels(previous, current) {
  const oldModels = previous || {};
  const newModels = current || {};
  const added = [];
  const removed = [];
  const mappingChanged = [];
  const metadataChanged = [];
  const metricChanged = [];

  for (const [modelKey, model] of Object.entries(newModels)) {
    const old = oldModels[modelKey];
    if (!old) {
      added.push(model);
      continue;
    }

    if (normalizeText(old.displayName) !== normalizeText(model.displayName)) {
      mappingChanged.push({ before: old, after: model });
    }

    const fields = [];
    // Old snapshots lack these properties. Compare only fields previously stored
    // to avoid a one-time schema-migration alert for every existing model.
    if (Object.prototype.hasOwnProperty.call(old, 'organization') &&
        old.organization !== model.organization) fields.push('organization');
    if (Object.prototype.hasOwnProperty.call(old, 'provider') &&
        old.provider !== model.provider) fields.push('provider');

    if (isPlainObject(old.metadata) && isPlainObject(model.metadata)) {
      const oldFields = new Set(Object.keys(old.metadata));
      const newFields = new Set(Object.keys(model.metadata));
      for (const field of new Set([...oldFields, ...newFields])) {
        if (!oldFields.has(field) || !newFields.has(field) ||
            !sameValue(old.metadata[field], model.metadata[field])) {
          fields.push(field);
        }
      }
    }

    if (fields.length) metadataChanged.push({ before: old, after: model, fields: [...new Set(fields)] });

    const changedMetrics = metricChanges(old, model);
    if (changedMetrics.length) metricChanged.push({ before: old, after: model, changes: changedMetrics });
  }

  for (const [modelKey, model] of Object.entries(oldModels)) {
    if (!Object.prototype.hasOwnProperty.call(newModels, modelKey)) removed.push(model);
  }

  return { added, removed, mappingChanged, metadataChanged, metricChanged };
}

function readJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

async function fetchCategory(source, previousForSource = null) {
  const headers = {
    'User-Agent': 'ArenaCategoryTracker/1.0 (+https://github.com/Namra7-x/lmarena-tracker)',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
  };

  let lastError = 'unknown';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetch(source.url, {
        headers,
        signal: AbortSignal.timeout(12000),
      });

      if (!response.ok) {
        lastError = 'HTTP ' + response.status;
      } else {
        const html = await response.text();
        if (!hasArenaModelPayload(html)) {
          lastError = 'no recognizable Arena model payload';
        } else {
          let raw;
          try {
            raw = parseModelsFromHtml(html);
          } catch (parseError) {
            // Keep a compact clue in Actions logs so new Arena payload schemas can
            // be reverse-engineered without dumping entire page HTML.
            const markers = ['modelKey', 'modelDisplayName', 'contenders/', 'netImprovement',
              'confirmedSuccess', 'sessions', 'initialModels', 'rankByModality'];
            const clues = markers.map((marker) => {
              const index = html.indexOf(marker);
              return index < 0 ? marker + '=absent' :
                marker + '@' + index + ':' + html.slice(Math.max(0, index - 70), index + 180).replace(/\\s+/g, ' ');
            });
            lastError = (parseError?.message || String(parseError)) + '; payload clues: ' + clues.join(' | ');
            continue;
          }
          const models = normalizeCategoryModels(raw);
          const count = Object.keys(models).length;
          const previousCount = Object.keys(previousForSource || {}).length;
          if (count >= source.minModels) {
            if (previousCount >= 20 && count < previousCount * 0.5) {
              lastError = 'sudden row-count drop from ' + previousCount + ' to ' + count +
                '; refusing a likely partial response';
            } else {
              return models;
            }
          } else {
            lastError = 'only ' + count + ' model IDs; refusing to update baseline';
          }
        }
      }
    } catch (error) {
      lastError = error?.message || String(error);
    }

    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(source.name + ' category fetch failed: ' + lastError);
}

async function sendDiscord(title, description, url = 'https://arena.ai/leaderboard') {
  const webhook = process.env.DISCORD_WEBHOOK_URL;
  if (!webhook) {
    console.log('DISCORD_WEBHOOK_URL is not set; skipping category alert delivery.');
    return;
  }

  const response = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      embeds: [{
        title,
        url,
        description: description.slice(0, 3900),
        color: 0xf1c40f,
        timestamp: new Date().toISOString(),
        footer: { text: 'Arena category leaderboards • public page data' },
      }],
    }),
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) throw new Error('Discord webhook returned HTTP ' + response.status);
}


async function fetchWithConcurrency(sources, previousSnapshot, limit = 5) {
  const results = new Array(sources.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= sources.length) return;
      const source = sources[index];
      try {
        results[index] = {
          source,
          models: await fetchCategory(source, previousSnapshot[source.name]),
          error: null,
        };
      } catch (error) {
        results[index] = { source, models: null, error };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, sources.length) }, () => worker()));
  return results;
}

function selectorAliasesForDisplay(displayName, selectorSnapshot) {
  const target = normalizeText(displayName);
  if (!target) return [];
  return Object.values(selectorSnapshot || {})
    .filter((model) => model && model.aliasCandidate && normalizeText(model.displayName) === target)
    .slice(0, 3)
    .map((model) => String(model.publicName) + ' -> ' + String(model.displayName));
}

function sourceSeenElsewhere(model, sourceName, snapshot) {
  const key = model.modelKey;
  const name = normalizeText(model.displayName);
  const seenKeys = [];
  const sameNameIds = [];

  for (const [otherSource, models] of Object.entries(snapshot || {})) {
    if (otherSource === sourceName || !isPlainObject(models)) continue;
    for (const [otherKey, otherModel] of Object.entries(models)) {
      if (otherKey === key) seenKeys.push(otherSource);
      if (name && normalizeText(otherModel?.displayName) === name && otherKey !== key) {
        sameNameIds.push({ source: otherSource, key: otherKey });
      }
    }
  }

  return { seenKeys: [...new Set(seenKeys)], sameNameIds: sameNameIds.slice(0, 4) };
}

function formatMetric(change) {
  return change.field + ': ' + String(change.before) + ' -> ' + String(change.after);
}

function formatModelSummary(model) {
  const bits = [];
  if (model.rank !== null && model.rank !== undefined) bits.push('rank ' + model.rank);
  if (model.rating !== null && model.rating !== undefined) bits.push('score ' + Number(model.rating.toFixed(3)));
  if (model.votes !== null && model.votes !== undefined) bits.push('votes/sessions ' + model.votes);
  return '- ' + model.modelKey + ' -> ' + model.displayName +
    (bits.length ? ' (' + bits.join(', ') + ')' : '');
}

function buildSourceMessage(source, changes, snapshot, selectorSnapshot) {
  const lines = ['Source: ' + source.url, 'Current IDs: ' + Object.keys(snapshot[source.name] || {}).length];

  if (changes.added.length) {
    lines.push('', 'NEW IDs ON THIS PAGE (' + changes.added.length + ')');
    for (const model of changes.added.slice(0, 10)) {
      lines.push(formatModelSummary(model));
      const context = sourceSeenElsewhere(model, source.name, snapshot);
      if (context.seenKeys.length) {
        lines.push('  Same ID already tracked on: ' + context.seenKeys.join(', '));
      } else if (context.sameNameIds.length) {
        lines.push('  Same display name under different IDs: ' +
          context.sameNameIds.map((item) => item.key + ' on ' + item.source).join('; '));
      } else {
        lines.push('  First-seen ID across current tracked leaderboard snapshots.');
      }
      const aliases = selectorAliasesForDisplay(model.displayName, selectorSnapshot);
      if (aliases.length) lines.push('  Matching Direct-selector alias clue: ' + aliases.join('; '));
    }
    if (changes.added.length > 10) lines.push('...and ' + (changes.added.length - 10) + ' more new IDs.');
  }

  if (changes.mappingChanged.length) {
    lines.push('', 'NAME / IDENTITY MAPPING CHANGES (' + changes.mappingChanged.length + ')');
    for (const pair of changes.mappingChanged.slice(0, 8)) {
      lines.push('- ' + pair.after.modelKey + ': ' + pair.before.displayName + ' -> ' + pair.after.displayName);
    }
    if (changes.mappingChanged.length > 8) lines.push('...and ' + (changes.mappingChanged.length - 8) + ' more.');
  }

  if (changes.metadataChanged.length) {
    lines.push('', 'PUBLIC METADATA CHANGES (' + changes.metadataChanged.length + ')');
    for (const item of changes.metadataChanged.slice(0, 8)) {
      lines.push('- ' + item.after.modelKey + ' (' + item.after.displayName + '): ' + item.fields.join(', '));
    }
    if (changes.metadataChanged.length > 8) lines.push('...and ' + (changes.metadataChanged.length - 8) + ' more.');
  }

  if (changes.metricChanged.length) {
    lines.push('', 'SIGNIFICANT RANK / SCORE CHANGES (' + changes.metricChanged.length + ')');
    for (const item of changes.metricChanged.slice(0, 8)) {
      lines.push('- ' + item.after.displayName + ' [' + item.after.modelKey + ']: ' +
        item.changes.map(formatMetric).join('; '));
    }
    if (changes.metricChanged.length > 8) lines.push('...and ' + (changes.metricChanged.length - 8) + ' more.');
  }

  if (changes.removed.length) {
    lines.push('', 'NO LONGER LISTED ON THIS PAGE (' + changes.removed.length + ')');
    for (const model of changes.removed.slice(0, 8)) {
      lines.push('- ' + model.modelKey + ' -> ' + model.displayName);
    }
    if (changes.removed.length > 8) lines.push('...and ' + (changes.removed.length - 8) + ' more.');
  }

  lines.push('', 'Public-page signals only: an alias or category-only ID is not proof of a stealth or unreleased model.');
  return lines.join('\\n');
}

export async function runCategoryTracker() {
  const previousSnapshot = readJson(SNAPSHOT_FILE, {});
  const selectorSnapshot = readJson(SELECTOR_SNAPSHOT_FILE, {});
  const results = await fetchWithConcurrency(CATEGORY_SOURCES, previousSnapshot);
  const nextSnapshot = { ...previousSnapshot };
  const baselineSources = [];
  const reports = [];

  for (const { source, models, error } of results) {
    if (error) {
      console.error(error.message || error);
      continue;
    }

    const previous = previousSnapshot[source.name];
    if (!previous || Object.keys(previous).length === 0) {
      nextSnapshot[source.name] = models;
      baselineSources.push({ source, count: Object.keys(models).length });
      console.log('Category baseline saved: ' + source.name + ' (' + Object.keys(models).length + ' IDs).');
      continue;
    }

    const changes = diffCategoryModels(previous, models);
    nextSnapshot[source.name] = models;
    console.log(
      'Category ' + source.name + ': ' + Object.keys(models).length +
      ' IDs; new=' + changes.added.length +
      ', removed=' + changes.removed.length +
      ', mapping_changes=' + changes.mappingChanged.length +
      ', metadata_changes=' + changes.metadataChanged.length +
      ', significant_metric_changes=' + changes.metricChanged.length
    );

    if (changes.added.length || changes.removed.length || changes.mappingChanged.length ||
        changes.metadataChanged.length || changes.metricChanged.length) {
      reports.push({ source, changes });
    }
  }

  if (results.every((item) => item.error)) {
    throw new Error('All category sources failed; preserving existing snapshot.');
  }

  // Build the new cross-source view before writing alerts. This lets us flag IDs
  // that are new to one page but already visible on another tracked leaderboard.
  for (const { source, models } of results) {
    if (models) nextSnapshot[source.name] = models;
  }

  if (baselineSources.length) {
    const total = baselineSources.reduce((sum, item) => sum + item.count, 0);
    const lines = [
      'Expanded coverage baselined ' + baselineSources.length + ' previously untracked leaderboard routes.',
      'Model records across those routes (not deduplicated): ' + total + '.',
      '',
      ...baselineSources.map((item) =>
        '- ' + item.source.name + ': ' + item.count + ' IDs · ' + item.source.url
      ),
      '',
      'This is an inventory baseline, not a claim that these models launched now. Future runs compare each page independently.',
    ];
    await sendDiscord('🧭 Arena leaderboard coverage expanded', lines.join('\\n'));
  }

  for (const { source, changes } of reports) {
    await sendDiscord(
      '🧭 Arena leaderboard changed: ' + source.name,
      buildSourceMessage(source, changes, nextSnapshot, selectorSnapshot),
      source.url
    );
  }

  saveJson(SNAPSHOT_FILE, nextSnapshot);

  const status = results.map(({ source, models, error }) => ({
    name: source.name,
    url: source.url,
    count: models ? Object.keys(models).length : 0,
    error: error ? error.message : null,
  }));
  console.log('Tracked leaderboard sources: ' + status.filter((item) => !item.error).length +
    '/' + CATEGORY_SOURCES.length + ' successful.');
  return {
    sources: status,
    baselined: baselineSources.map((item) => item.source.name),
    alerts: reports.length,
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCategoryTracker().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
