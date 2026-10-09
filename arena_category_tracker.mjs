import fs from 'node:fs';
import path from 'node:path';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hasArenaModelPayload, parseModelsFromHtml } from './arena_parser.mjs';

export const CATEGORY_SOURCES = [
  { name: 'text', url: 'https://arena.ai/leaderboard/chat/text', minModels: 100 },
  { name: 'vision', url: 'https://arena.ai/leaderboard/chat/vision', minModels: 50 },
];

const SNAPSHOT_FILE = process.env.CATEGORY_SNAPSHOT_FILE ||
  path.join(process.cwd(), 'category_snapshot.json');
const OVERVIEW_SNAPSHOT_FILE = process.env.OVERVIEW_SNAPSHOT_FILE ||
  path.join(process.cwd(), 'snapshot.json');

export function normalizeCategoryModels(rawModels) {
  const result = {};
  for (const [key, model] of Object.entries(rawModels || {})) {
    if (!model || typeof model !== 'object') continue;
    const modelKey = String(model.id || key || '').trim();
    if (!modelKey) continue;
    result[modelKey] = {
      modelKey,
      displayName: String(model.displayName || model.publicName || modelKey).trim(),
      rank: Number.isFinite(model.rank) && model.rank < Number.MAX_SAFE_INTEGER ? model.rank : null,
      rating: Number.isFinite(model.rating) ? model.rating : null,
      votes: Number.isFinite(model.votes) ? model.votes : null,
    };
  }
  return result;
}

export function diffCategoryModels(previous, current, overviewKeys = new Set()) {
  const oldModels = previous || {};
  const newModels = current || {};
  const added = [];
  const mappingChanged = [];

  for (const [modelKey, model] of Object.entries(newModels)) {
    const old = oldModels[modelKey];
    if (!old) {
      if (!overviewKeys.has(modelKey)) added.push(model);
      continue;
    }
    if (String(old.displayName).trim().toLowerCase() !==
        String(model.displayName).trim().toLowerCase()) {
      mappingChanged.push({ before: old, after: model });
    }
  }

  return { added, mappingChanged };
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

async function fetchCategory(source) {
  const headers = {
    'User-Agent': 'ArenaCategoryTracker/1.0 (+https://github.com/Namra7-x/lmarena-tracker)',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
  };

  let lastError = 'unknown';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(source.url, {
        headers,
        signal: AbortSignal.timeout(20000),
      });

      if (!response.ok) {
        lastError = 'HTTP ' + response.status;
      } else {
        const html = await response.text();
        if (!hasArenaModelPayload(html)) {
          lastError = 'no recognizable Arena model payload';
        } else {
          const raw = parseModelsFromHtml(html);
          const models = normalizeCategoryModels(raw);
          if (Object.keys(models).length >= source.minModels) return models;
          lastError = 'only ' + Object.keys(models).length + ' model IDs; refusing to update baseline';
        }
      }
    } catch (error) {
      lastError = error?.message || String(error);
    }

    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 800));
  }

  throw new Error(source.name + ' category fetch failed: ' + lastError);
}

async function sendDiscord(title, description) {
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
        description: description.slice(0, 4000),
        color: 0xf1c40f,
        timestamp: new Date().toISOString(),
        footer: { text: 'Arena category leaderboards • public page data' },
      }],
    }),
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) throw new Error('Discord webhook returned HTTP ' + response.status);
}

export async function runCategoryTracker() {
  const previousSnapshot = readJson(SNAPSHOT_FILE, {});
  const overview = readJson(OVERVIEW_SNAPSHOT_FILE, {});
  const overviewKeys = new Set(Object.keys(overview || {}));
  const nextSnapshot = { ...previousSnapshot };
  const reports = [];

  const results = await Promise.all(CATEGORY_SOURCES.map(async (source) => {
    try {
      return { source, models: await fetchCategory(source), error: null };
    } catch (error) {
      return { source, models: null, error };
    }
  }));

  for (const { source, models, error } of results) {
    if (error) {
      console.error(error.message || error);
      continue;
    }

    const previous = previousSnapshot[source.name];
    if (!previous || Object.keys(previous).length === 0) {
      nextSnapshot[source.name] = models;
      console.log('Category baseline saved: ' + source.name + ' (' + Object.keys(models).length + ' IDs).');
      continue;
    }

    const changes = diffCategoryModels(previous, models, overviewKeys);
    nextSnapshot[source.name] = models;
    console.log(
      'Category ' + source.name + ': ' + Object.keys(models).length +
      ' IDs; new beyond overview=' + changes.added.length +
      ', display-name changes=' + changes.mappingChanged.length
    );

    if (changes.added.length || changes.mappingChanged.length) {
      reports.push({
        source: source.name,
        changes,
      });
    }
  }

  if (results.every((item) => item.error)) {
    throw new Error('All category sources failed; preserving existing snapshot.');
  }

  if (reports.length) {
    const lines = [];
    for (const report of reports) {
      const { source, changes } = report;
      lines.push('**' + source.toUpperCase() + ' leaderboard**');

      if (changes.added.length) {
        lines.push('New IDs not in overview (' + changes.added.length + '):');
        lines.push(...changes.added.slice(0, 20).map((model) =>
          '- \x60' + model.modelKey + '\x60 → \x60' + model.displayName + '\x60' +
          (model.rank === null ? '' : ' · rank ' + model.rank)
        ));
        if (changes.added.length > 20) lines.push('…and ' + (changes.added.length - 20) + ' more.');
      }

      if (changes.mappingChanged.length) {
        lines.push('Display-name changes (' + changes.mappingChanged.length + '):');
        lines.push(...changes.mappingChanged.slice(0, 15).map(({ before, after }) =>
          '- \x60' + after.modelKey + '\x60: \x60' + before.displayName +
          '\x60 → \x60' + after.displayName + '\x60'
        ));
      }
      lines.push('');
    }

    lines.push('*Category-only does not automatically mean stealth; this flags records absent from the overview snapshot.*');
    await sendDiscord('🧭 Arena category leaderboard changed', lines.join('\n'));
  }

  saveJson(SNAPSHOT_FILE, nextSnapshot);
  return { categories: results.map(({ source, models, error }) => ({
    name: source.name,
    count: models ? Object.keys(models).length : 0,
    error: error ? error.message : null,
  })) };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCategoryTracker().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
