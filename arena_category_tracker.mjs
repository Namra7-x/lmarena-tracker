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
  { name: 'agent_pareto', url: 'https://arena.ai/leaderboard/agent/pareto', minModels: 10 },

  { name: 'code_pareto', url: 'https://arena.ai/leaderboard/code/pareto', minModels: 10 },
  { name: 'code_webdev', url: 'https://arena.ai/leaderboard/code/webdev', minModels: 20 },
  { name: 'code_react', url: 'https://arena.ai/leaderboard/code/react', minModels: 20 },
  { name: 'code_content_creation', url: 'https://arena.ai/leaderboard/code/content-creation-and-editing-tools', minModels: 20 },
  { name: 'code_reference_design', url: 'https://arena.ai/leaderboard/code/webdev/reference-based-design', minModels: 20 },
  { name: 'code_data_analytics', url: 'https://arena.ai/leaderboard/code/webdev/data-analytics', minModels: 20 },
  { name: 'code_image_to_webdev', url: 'https://arena.ai/leaderboard/code/image-to-webdev', minModels: 10 },
  { name: 'image_to_code_overall', url: 'https://arena.ai/leaderboard/image-to-code/overall', minModels: 10 },

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

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeText(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function normalizeCategoryModels(rawModels) {
  const normalized = {};

  for (const [key, raw] of Object.entries(rawModels || {})) {
    if (!raw || typeof raw !== 'object') continue;
    const modelKey = String(raw.modelKey || raw.id || key || '').trim();
    if (!modelKey) continue;

    normalized[modelKey] = {
      modelKey,
      displayName: String(raw.displayName || raw.modelDisplayName || raw.publicName || modelKey).trim(),
      publicName: String(raw.publicName || '').trim(),
      organization: String(raw.modelOrganization || raw.organization || raw.organizationName || '').trim(),
      provider: String(raw.provider || raw.providerName || '').trim(),
      userSelectable: typeof raw.userSelectable === 'boolean' ? raw.userSelectable : null,
    };
  }

  return Object.fromEntries(Object.entries(normalized).sort(([a], [b]) => a.localeCompare(b)));
}

// Only new IDs are model-discovery events. Rank/score/vote/metadata changes,
// name-only changes and disappeared records are intentionally ignored.
export function diffCategoryModels(previous, current) {
  const oldModels = previous || {};
  const newModels = current || {};
  const added = [];

  for (const [modelKey, model] of Object.entries(newModels)) {
    if (!Object.prototype.hasOwnProperty.call(oldModels, modelKey)) added.push(model);
  }

  return { added };
}

function collectKnownIds(snapshot) {
  const ids = new Set();
  for (const [key, value] of Object.entries(snapshot || {})) {
    ids.add(String(key));
    if (!isPlainObject(value)) continue;
    for (const model of Object.values(value)) {
      if (!isPlainObject(model)) continue;
      if (model.modelKey) ids.add(String(model.modelKey));
      if (model.id) ids.add(String(model.id));
    }
  }
  return ids;
}

function collectPreviousCategoryIds(previousSnapshot) {
  const ids = new Set();
  for (const models of Object.values(previousSnapshot || {})) {
    if (!isPlainObject(models)) continue;
    for (const [key, model] of Object.entries(models)) {
      ids.add(String(key));
      if (model?.modelKey) ids.add(String(model.modelKey));
    }
  }
  return ids;
}

export function findFirstSeenModels(results, previousSnapshot = {}, overviewSnapshot = {}, selectorSnapshot = {}) {
  const knownIds = collectKnownIds(overviewSnapshot);
  for (const id of collectPreviousCategoryIds(previousSnapshot)) knownIds.add(id);

  // Selector entries have their own detector, so avoid duplicate alerts when
  // the exact key/ID has already appeared in the Direct selector registry.
  for (const [key, model] of Object.entries(selectorSnapshot || {})) {
    knownIds.add(String(key));
    if (model?.id) knownIds.add(String(model.id));
    if (model?.publicName) knownIds.add(String(model.publicName));
  }

  const detections = new Map();

  for (const result of results || []) {
    if (result.error || !result.models) continue;

    // A newly added route is baselined quietly instead of generating alerts for
    // all existing records on that page.
    const priorForSource = previousSnapshot?.[result.source.name];
    if (!isPlainObject(priorForSource) || Object.keys(priorForSource).length === 0) continue;

    for (const model of Object.values(result.models)) {
      const modelKey = String(model?.modelKey || '').trim();
      if (!modelKey || knownIds.has(modelKey)) continue;

      let detection = detections.get(modelKey);
      if (!detection) {
        detection = { ...model, modelKey, sources: [] };
        detections.set(modelKey, detection);
      }

      if (!detection.sources.some((source) => source.name === result.source.name)) {
        detection.sources.push({ name: result.source.name, url: result.source.url });
      }
    }
  }

  return [...detections.values()]
    .map((item) => ({
      ...item,
      sources: item.sources.sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.modelKey.localeCompare(b.modelKey));
}

export function findSelectorAliasClues(displayName, selectorSnapshot = {}) {
  const target = normalizeText(displayName);
  if (!target) return [];

  return Object.values(selectorSnapshot || {})
    .filter((model) => model && model.aliasCandidate &&
      normalizeText(model.displayName) === target)
    .slice(0, 3)
    .map((model) => ({
      publicName: String(model.publicName || ''),
      displayName: String(model.displayName || ''),
    }));
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
            const markers = ['modelKey', 'modelDisplayName', 'contenderName', 'contenders/', 'modelId', 'modelName',
              '"model"', 'displayName', 'rows', 'entries', 'rank', 'score', 'netImprovement',
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

  for (let attempt = 1; attempt <= 4; attempt++) {
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

    if (response.ok) return;
    if (response.status !== 429 || attempt === 4) {
      throw new Error('Discord webhook returned HTTP ' + response.status);
    }

    let retryAfter = Number(response.headers.get('Retry-After')) || 2;
    try {
      const data = await response.json();
      retryAfter = Number(data.retry_after) || retryAfter;
    } catch {
      // Retry-After header is the fallback.
    }
    const waitMs = Math.min(Math.max(retryAfter * 1000 + 250, 1000), 10000);
    console.warn('Discord rate limit hit; retrying in ' + waitMs + 'ms.');
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
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

function humanizeSource(name) {
  const labels = {
    text: 'Text',
    vision: 'Vision',
    text_math: 'Text Math',
    text_hard_prompts: 'Hard Prompts',
    text_instruction_following: 'Instruction Following',
    text_expert: 'Expert',
    text_creative_writing: 'Creative Writing',
    text_coding: 'Coding',
    text_writing_literature_language: 'Writing & Literature',
    agent_overall: 'Agent Overall',
    agent_code: 'Agent Code',
    agent_chat: 'Agent Chat',
    agent_work: 'Agent Work',
    agent_pareto: 'Agent Pareto',
    code_pareto: 'Code Pareto',
    code_webdev: 'WebDev',
    code_react: 'React',
    code_content_creation: 'Content Creation',
    code_reference_design: 'Reference Design',
    code_data_analytics: 'Data Analytics',
    code_image_to_webdev: 'Image to WebDev',
    image_to_code_overall: 'Image to Code',
    text_to_image: 'Text to Image',
    image_edit: 'Image Edit',
    image_edit_multi: 'Multi-Image Edit',
    image_edit_art: 'Art Edit',
    image_edit_commercial: 'Commercial Design Edit',
    text_to_video: 'Text to Video',
    image_to_video: 'Image to Video',
    video_edit: 'Video Edit',
    document: 'Document',
    search: 'Search',
  };
  return labels[name] || name.replace(/_/g, ' ');
}

function modelEmbed(model, selectorSnapshot) {
  const tick = String.fromCharCode(96);
  const primaryUrl = model.sources[0]?.url || 'https://arena.ai/leaderboard';
  const displayName = model.displayName || model.modelKey;
  const organization = model.organization || 'Not exposed';
  const provider = model.provider || 'Not exposed';
  const selectable = model.userSelectable === null ? 'Not exposed' :
    (model.userSelectable ? 'Yes' : 'No');
  const sourceLinks = model.sources
    .map((source) => '[' + humanizeSource(source.name) + '](' + source.url + ')')
    .join(', ');
  const aliasClues = findSelectorAliasClues(displayName, selectorSnapshot);
  const lines = [
    '### [' + displayName + '](' + primaryUrl + ')',
    '',
    '🔎 **Detection:** New model ID absent from the current overall snapshot and previous tracked category IDs.',
    '',
    '🏢 **Organization:** ' + organization,
    '',
    '🏭 **Provider:** ' + provider,
    '',
    '🔘 **Directly selectable:** ' + selectable,
    '',
    '🧭 **First observed on:** ' + sourceLinks,
    '',
    '🆔 **Model ID:**',
    tick + model.modelKey + tick,
  ];

  if (aliasClues.length) {
    lines.push('', '🪄 **Matching selector alias clue:**');
    lines.push(...aliasClues.map((alias) =>
      tick + alias.publicName + tick + ' → ' + tick + alias.displayName + tick
    ));
  }

  lines.push('', '*Public-page signal only; this does not confirm a stealth or unreleased model.*');

  return {
    author: {
      name: 'LMSYS Arena Tracker',
      url: primaryUrl,
      icon_url: 'https://arena.ai/favicon.ico',
    },
    title: '🕵️ NEW ARENA MODEL SIGNAL',
    url: primaryUrl,
    description: lines.join('\n'),
    color: 0x9b59b6,
    timestamp: new Date().toISOString(),
    footer: { text: 'Arena model detector • public pages only' },
  };
}

async function sendDiscordEmbeds(embeds) {
  const webhook = (process.env.DISCORD_WEBHOOK_URL || process.env.DISCORD_WEBHOOK || '').trim();
  if (!webhook) {
    console.log('DISCORD webhook is not set; model alert delivery skipped.');
    for (const embed of embeds) {
      console.log('[Model detection dry run]\n' + embed.title + '\n' + embed.description);
    }
    return;
  }

  // Match the main tracker: one independent Discord message per detected model.
  // This keeps each alert readable and prevents several model cards being bundled
  // into one long, difficult-to-scan message.
  for (const embed of embeds) {
    let delivered = false;

    for (let attempt = 1; attempt <= 4; attempt++) {
      const response = await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          embeds: [embed],
          allowed_mentions: { parse: [] },
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (response.ok) {
        delivered = true;
        break;
      }
      if (response.status !== 429 || attempt === 4) {
        throw new Error('Discord webhook returned HTTP ' + response.status);
      }

      let retryAfter = Number(response.headers.get('Retry-After')) || 2;
      try {
        const data = await response.json();
        retryAfter = Number(data.retry_after) || retryAfter;
      } catch {
        // Use Retry-After header when the response body is not JSON.
      }

      const waitMs = Math.min(Math.max(retryAfter * 1000 + 250, 1000), 10000);
      console.warn('Discord rate limit hit; retrying in ' + waitMs + 'ms.');
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    if (!delivered) throw new Error('Discord model alert was not delivered.');
  }
}

export async function runCategoryTracker() {
  const previousSnapshot = readJson(SNAPSHOT_FILE, {});
  const overviewSnapshot = readJson(OVERVIEW_SNAPSHOT_FILE, {});
  const selectorSnapshot = readJson(SELECTOR_SNAPSHOT_FILE, {});
  const results = await fetchWithConcurrency(CATEGORY_SOURCES, previousSnapshot, 5);

  if (results.every((result) => result.error)) {
    throw new Error('All category sources failed; preserving the model-ID baseline.');
  }

  const detections = findFirstSeenModels(results, previousSnapshot, overviewSnapshot, selectorSnapshot);
  console.log('Model-discovery sources: ' +
    results.filter((result) => !result.error).length + '/' + CATEGORY_SOURCES.length + ' successful.');
  console.log('New distinct category-only model IDs: ' + detections.length + '.');

  if (detections.length) {
    await sendDiscordEmbeds(detections.map((model) => modelEmbed(model, selectorSnapshot)));
  }

  // Retain only the active routes and compact identity records. No ranks, scores,
  // votes, or general leaderboard metadata are persisted.
  const nextSnapshot = {};
  for (const source of CATEGORY_SOURCES) {
    const result = results.find((item) => item.source.name === source.name);
    if (result?.models) nextSnapshot[source.name] = result.models;
    else if (isPlainObject(previousSnapshot[source.name])) {
      nextSnapshot[source.name] = previousSnapshot[source.name];
    }
  }

  saveJson(SNAPSHOT_FILE, nextSnapshot);

  return {
    sourcesSucceeded: results.filter((result) => !result.error).length,
    sourceCount: CATEGORY_SOURCES.length,
    detections: detections.map((model) => ({
      modelKey: model.modelKey,
      displayName: model.displayName,
      sources: model.sources.map((source) => source.name),
    })),
    errors: results.filter((result) => result.error).map((result) => ({
      name: result.source.name,
      error: result.error.message,
    })),
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCategoryTracker().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
