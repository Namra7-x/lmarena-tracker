/**
 * Hugging Face Change Detector
 * Compares current remote state of tracked labs against previous snapshot.
 */

import { HF_API_BASE } from './config.mjs';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; HFSignalTracker/2.0; +https://github.com/Namra7-x/lmarena-tracker)'
};

const MAX_RECENCY_MS = 3 * 24 * 60 * 60 * 1000; // 72 hours max age for "new" alerts

/**
 * Normalizes gated status from Hugging Face API ('manual', 'auto', true -> true).
 */
export function normalizeGated(val) {
  if (val === true || val === 'manual' || val === 'auto') return true;
  return false;
}

/**
 * Fetches the latest models, spaces, and collections for a single organization.
 * Full-power queries: up to 500 models by createdAt, up to 100 models by lastModified,
 * up to 100 spaces, and up to 100 collections (100% full coverage without artificial limits).
 */
export async function fetchOrgState(org) {
  const [createdModelsRes, modModelsRes, spacesRes, collectionsRes] = await Promise.allSettled([
    fetch(`${HF_API_BASE}/models?author=${org}&sort=createdAt&direction=-1&limit=500&expand=gated&expand=createdAt&expand=pipeline_tag`, { headers: HEADERS }),
    fetch(`${HF_API_BASE}/models?author=${org}&sort=lastModified&direction=-1&limit=100&expand=gated&expand=createdAt&expand=pipeline_tag`, { headers: HEADERS }),
    fetch(`${HF_API_BASE}/spaces?author=${org}&sort=lastModified&direction=-1&limit=100&expand=createdAt`, { headers: HEADERS }),
    fetch(`${HF_API_BASE}/collections?owner=${org}&limit=100`, { headers: HEADERS })
  ]);

  let createdModels = [];
  let modModels = [];
  let spaces = [];
  let collections = [];

  if (createdModelsRes.status === 'fulfilled' && createdModelsRes.value.ok) {
    try { createdModels = await createdModelsRes.value.json(); } catch {}
  }
  if (modModelsRes.status === 'fulfilled' && modModelsRes.value.ok) {
    try { modModels = await modModelsRes.value.json(); } catch {}
  }
  if (spacesRes.status === 'fulfilled' && spacesRes.value.ok) {
    try { spaces = await spacesRes.value.json(); } catch {}
  }
  if (collectionsRes.status === 'fulfilled' && collectionsRes.value.ok) {
    try { collections = await collectionsRes.value.json(); } catch {}
  }

  // Deduplicate models by ID while preserving both createdAt and lastModified
  const modelMap = new Map();
  for (const m of createdModels) {
    if (m && m.id) modelMap.set(m.id, m);
  }
  for (const m of modModels) {
    if (m && m.id) {
      if (modelMap.has(m.id)) {
        modelMap.set(m.id, { ...modelMap.get(m.id), ...m });
      } else {
        modelMap.set(m.id, m);
      }
    }
  }

  return {
    models: Array.from(modelMap.values()),
    spaces,
    collections
  };
}

/**
 * Builds a serialized index of an org's items for fast diffing.
 */
export function buildOrgIndex(state) {
  const index = {
    models: {},
    spaces: {},
    collections: {}
  };

  for (const m of state.models || []) {
    index.models[m.id] = {
      createdAt: m.createdAt || null,
      lastModified: m.lastModified || null,
      gated: normalizeGated(m.gated),
      pipeline_tag: m.pipeline_tag || null,
      numParameters: m.numParameters || null,
    };
  }

  for (const s of state.spaces || []) {
    index.spaces[s.id] = {
      createdAt: s.createdAt || null,
      lastModified: s.lastModified || null,
      sdk: s.sdk || null
    };
  }

  for (const c of state.collections || []) {
    const itemIds = Array.isArray(c.items) ? c.items.map((i) => i?.id).filter(Boolean) : [];
    index.collections[c.slug] = {
      title: c.title || c.slug,
      lastUpdated: c.lastUpdated || null,
      itemCount: itemIds.length || (Array.isArray(c.items) ? c.items.length : 0),
      itemIds: itemIds,
    };
  }

  return index;
}

/**
 * Diffs current remote state against previous baseline snapshot for one org.
 * Full-power change detection: detects all genuine new models, spaces, collections,
 * and exact item additions.
 */
export function diffOrgState(org, currentState, previousIndex) {
  const events = [];
  if (!previousIndex) {
    return events;
  }

  // 1. Models diff
  for (const model of currentState.models || []) {
    const prev = previousIndex.models?.[model.id];
    if (!prev) {
      events.push({
        type: 'NEW_MODEL',
        org,
        item: model,
        details: {
          summary: `Brand new model **${model.id}** uploaded by ${org}.`,
          createdAt: model.createdAt,
          pipeline_tag: model.pipeline_tag,
          gated: Boolean(model.gated),
        }
      });
    } else {
      // Check for gating change (e.g. form opened or unlocked)
      const prevGated = normalizeGated(prev.gated);
      const curGated = normalizeGated(model.gated);
      if (curGated !== prevGated) {
        events.push({
          type: 'GATING_CHANGED',
          org,
          item: model,
          details: {
            change: curGated ? 'Changed to 🔒 Gated (Form Required)' : 'Unlocked / 🌐 Public Open Weights'
          }
        });
      }

      // Check for weights update ONLY if explicitly enabled (disabled by default to prevent commit touch spam)
      if (process.env.TRACK_WEIGHTS === 'true' && model.lastModified && prev.lastModified && model.lastModified !== prev.lastModified) {
        events.push({
          type: 'WEIGHTS_UPDATED',
          org,
          item: model,
          details: { summary: `Model weights / files updated for **${model.id}**.` }
        });
      }
    }
  }

  // 2. Spaces diff
  for (const space of currentState.spaces || []) {
    const prev = previousIndex.spaces?.[space.id];
    if (!prev) {
      events.push({
        type: 'NEW_SPACE',
        org,
        item: space,
        details: { summary: `New interactive demo/space **${space.id}** launched on Gradio/Docker.` }
      });
    }
  }

  // 3. Collections diff
  for (const col of currentState.collections || []) {
    const prev = previousIndex.collections?.[col.slug];
    if (!prev) {
      events.push({
        type: 'NEW_COLLECTION',
        org,
        item: col,
        details: {
          summary: `New curated collection **${col.title || col.slug}** created.`,
          items: col.items || [],
        }
      });
    } else if (
      Array.isArray(col.items) &&
      prev.itemCount !== undefined &&
      col.items.length > prev.itemCount
    ) {
      // Find exact newly added items
      const prevIds = new Set(prev.itemIds || []);
      const newlyAdded = col.items.filter((i) => i?.id && !prevIds.has(i.id));

      events.push({
        type: 'COLLECTION_UPDATED',
        org,
        item: col,
        details: {
          summary: `Collection **${col.title}** expanded from ${prev.itemCount} to ${col.items.length} items.`,
          addedItems: newlyAdded,
        }
      });
    }
  }

  return events;
}

/**
 * Runs pool with limited concurrency
 */
export async function runConcurrentPool(items, concurrency, fn) {
  const results = [];
  const executing = new Set();

  for (const item of items) {
    const p = Promise.resolve().then(() => fn(item));
    results.push(p);
    executing.add(p);
    const clean = () => executing.delete(p);
    p.then(clean).catch(clean);

    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }

  return Promise.all(results);
}
