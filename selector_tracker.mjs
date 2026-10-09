import fs from 'node:fs';
import path from 'node:path';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hasArenaModelPayload, parseModelsFromHtml } from './arena_parser.mjs';

export const SELECTOR_URL =
  (process.env.ARENA_SELECTOR_URL || 'https://arena.ai/text/direct').trim();
const SNAPSHOT_FILE = process.env.SELECTOR_SNAPSHOT_FILE ||
  path.join(process.cwd(), 'selector_snapshot.json');
const MIN_MODELS = 100;

function normalizeText(value) {
  return String(value ?? '').trim().toLowerCase();
}

/** Key by publicName, not Arena's UUID, to avoid false additions on UUID rotation. */
export function normalizeSelectorModels(rawModels) {
  const normalized = {};

  for (const model of Object.values(rawModels || {})) {
    if (!model || typeof model !== 'object') continue;

    const publicName = String(model.publicName || model.name || model.id || '').trim();
    if (!publicName) continue;

    const displayName = String(model.displayName || publicName).trim();
    const entry = {
      id: String(model.id || ''),
      publicName,
      displayName,
      organization: String(model.organization || model.provider || ''),
      userSelectable: typeof model.userSelectable === 'boolean' ? model.userSelectable : null,
      aliasCandidate: normalizeText(publicName) !== normalizeText(displayName),
    };

    const existing = normalized[publicName];
    if (!existing) {
      normalized[publicName] = entry;
      continue;
    }

    if (!existing.organization && entry.organization) existing.organization = entry.organization;
    if (existing.userSelectable === null && entry.userSelectable !== null) {
      existing.userSelectable = entry.userSelectable;
    }
    if (existing.displayName === existing.publicName && entry.displayName !== entry.publicName) {
      existing.displayName = entry.displayName;
      existing.aliasCandidate = entry.aliasCandidate;
    }
  }

  return Object.fromEntries(Object.entries(normalized).sort(([a], [b]) => a.localeCompare(b)));
}

export function diffSelectorModels(previous, current) {
  const oldModels = previous || {};
  const newModels = current || {};
  const added = [];
  const mappingChanged = [];
  const selectableChanged = [];

  for (const [publicName, model] of Object.entries(newModels)) {
    const old = oldModels[publicName];
    if (!old) {
      added.push(model);
      continue;
    }

    if (normalizeText(old.displayName) !== normalizeText(model.displayName)) {
      mappingChanged.push({ before: old, after: model });
    }

    if (old.userSelectable !== model.userSelectable &&
        old.userSelectable !== null && model.userSelectable !== null) {
      selectableChanged.push({ before: old, after: model });
    }
  }

  return { added, mappingChanged, selectableChanged };
}

function loadSnapshot() {
  if (!fs.existsSync(SNAPSHOT_FILE)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function saveSnapshot(snapshot) {
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
}

async function fetchSelectorModels() {
  const headers = {
    'User-Agent': 'ArenaSelectorTracker/1.0 (+https://github.com/Namra7-x/lmarena-tracker)',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
  };

  let lastError = 'unknown';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(SELECTOR_URL, {
        headers,
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        lastError = 'HTTP ' + response.status;
      } else {
        const html = await response.text();
        if (!hasArenaModelPayload(html)) {
          lastError = 'response did not contain recognizable Next.js model data';
        } else {
          const rawModels = parseModelsFromHtml(html);
          const models = normalizeSelectorModels(rawModels);
          const count = Object.keys(models).length;

          if (count >= MIN_MODELS) return models;
          lastError = 'only ' + count + ' selector entries found; refusing to replace baseline';
        }
      }
    } catch (error) {
      lastError = error?.message || String(error);
    }

    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 700));
  }

  throw new Error('Failed to fetch selector registry from ' + SELECTOR_URL + ': ' + lastError);
}

function aliasSummary(models, limit = 12) {
  return Object.values(models)
    .filter((model) => model.aliasCandidate)
    .sort((a, b) => a.publicName.localeCompare(b.publicName))
    .slice(0, limit)
    .map((model) => '\x60' + model.publicName + '\x60 → \x60' + model.displayName + '\x60' +
      (model.organization ? ' (' + model.organization + ')' : ''));
}

async function sendDiscordMessage(title, description, color = 0x5865f2) {
  const webhook = process.env.DISCORD_WEBHOOK_URL;
  if (!webhook) {
    console.log('DISCORD_WEBHOOK_URL is not set; skipping selector alert delivery.');
    return;
  }

  const response = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      embeds: [{
        title,
        description: description.slice(0, 4000),
        color,
        timestamp: new Date().toISOString(),
        footer: { text: 'Arena Direct selector • public page data' },
      }],
    }),
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) throw new Error('Discord webhook returned HTTP ' + response.status);
}

function formatNewEntry(model) {
  const type = model.aliasCandidate ? 'ALIAS CANDIDATE' : 'NEW SELECTOR ENTRY';
  return '- **' + type + '**: \x60' + model.publicName + '\x60 → \x60' + model.displayName + '\x60' +
    (model.organization ? ' · ' + model.organization : '') +
    (model.userSelectable === null ? '' : ' · selectable=' + model.userSelectable);
}

export async function runSelectorTracker() {
  const previous = loadSnapshot();
  const current = await fetchSelectorModels();
  const currentCount = Object.keys(current).length;
  const aliases = Object.values(current).filter((model) => model.aliasCandidate);

  if (!previous) {
    saveSnapshot(current);
    const sample = aliasSummary(current);
    const details = [
      'Saved a baseline of **' + currentCount + '** Direct-mode selector entries.',
      'Found **' + aliases.length + '** entries where \x60publicName\x60 differs from \x60displayName\x60 (alias candidates, not confirmed stealth identities).',
      sample.length ? '**Sample mappings**\n' + sample.join('\n') : 'No alias candidates in this capture.',
      'Future alerts report new selector names, changed alias/display mappings, and selectable-state changes.',
    ].join('\n\n');

    console.log('Selector baseline saved: ' + currentCount + ' entries, ' + aliases.length + ' alias candidates.');
    await sendDiscordMessage('🧭 Arena selector baseline established', details, 0x5865f2);
    return { baseline: true, count: currentCount, aliasCandidates: aliases.length };
  }

  const changes = diffSelectorModels(previous, current);
  saveSnapshot(current);

  const hasChanges = changes.added.length || changes.mappingChanged.length ||
    changes.selectableChanged.length;

  console.log(
    'Selector registry: ' + currentCount + ' entries; new=' + changes.added.length +
    ', mapping_changes=' + changes.mappingChanged.length +
    ', selectable_changes=' + changes.selectableChanged.length
  );

  if (!hasChanges) return { baseline: false, count: currentCount, changes };

  const lines = [];
  if (changes.added.length) {
    lines.push('**New selector entries (' + changes.added.length + ')**');
    lines.push(...changes.added.slice(0, 25).map(formatNewEntry));
    if (changes.added.length > 25) lines.push('…and ' + (changes.added.length - 25) + ' more.');
  }

  if (changes.mappingChanged.length) {
    lines.push('\n**Alias/display mapping changes (' + changes.mappingChanged.length + ')**');
    lines.push(...changes.mappingChanged.slice(0, 20).map(({ before, after }) =>
      '- ' + '\x60' + before.publicName + '\x60' + ' changed from ' +
      '\x60' + before.displayName + '\x60' + ' to ' +
      '\x60' + after.displayName + '\x60' +
      (after.organization ? ' · ' + after.organization : '')
    ));
    if (changes.mappingChanged.length > 20) {
      lines.push('…and ' + (changes.mappingChanged.length - 20) + ' more.');
    }
  }

  if (changes.selectableChanged.length) {
    lines.push('\n**Selectable-state changes (' + changes.selectableChanged.length + ')**');
    lines.push(...changes.selectableChanged.slice(0, 15).map(({ before, after }) =>
      '- ' + '\x60' + after.publicName + '\x60' + ' · ' +
      before.userSelectable + ' → ' + after.userSelectable
    ));
  }

  lines.push('\n*Alias candidates are clues, not proof of a model provider or an unreleased release.*');
  await sendDiscordMessage('🧭 Arena Direct selector changed', lines.join('\n'), 0xf1c40f);
  return { baseline: false, count: currentCount, changes };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runSelectorTracker().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
