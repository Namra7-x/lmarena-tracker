/**
 * Hugging Face Change Detector
 * Compares current remote state of tracked labs against previous snapshot.
 */

import { HF_API_BASE } from './config.mjs';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; HFSignalTracker/1.0; +https://github.com/Namra7-x/lmarena-tracker)'
};

/**
 * Fetches the latest models, spaces, and collections for a single organization.
 */
export async function fetchOrgState(org) {
  const [modelsRes, spacesRes, collectionsRes] = await Promise.allSettled([
    fetch(`${HF_API_BASE}/models?author=${org}&sort=lastModified&direction=-1&limit=25`, { headers: HEADERS }),
    fetch(`${HF_API_BASE}/spaces?author=${org}&sort=lastModified&direction=-1&limit=20`, { headers: HEADERS }),
    fetch(`${HF_API_BASE}/collections?owner=${org}&limit=15`, { headers: HEADERS })
  ]);

  let models = [];
  let spaces = [];
  let collections = [];

  if (modelsRes.status === 'fulfilled' && modelsRes.value.ok) {
    try { models = await modelsRes.value.json(); } catch {}
  }
  if (spacesRes.status === 'fulfilled' && spacesRes.value.ok) {
    try { spaces = await spacesRes.value.json(); } catch {}
  }
  if (collectionsRes.status === 'fulfilled' && collectionsRes.value.ok) {
    try { collections = await collectionsRes.value.json(); } catch {}
  }

  return { models, spaces, collections };
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
      lastModified: m.lastModified || null,
      gated: Boolean(m.gated),
      pipeline_tag: m.pipeline_tag || null,
      likes: m.likes || 0,
      downloads: m.downloads || 0
    };
  }

  for (const s of state.spaces || []) {
    index.spaces[s.id] = {
      lastModified: s.lastModified || null,
      sdk: s.sdk || null,
      likes: s.likes || 0
    };
  }

  for (const c of state.collections || []) {
    index.collections[c.slug] = {
      title: c.title || c.slug,
      lastUpdated: c.lastUpdated || null,
      itemCount: Array.isArray(c.items) ? c.items.length : 0
    };
  }

  return index;
}

/**
 * Diffs current remote state against previous baseline snapshot for one org.
 */
export function diffOrgState(org, currentState, previousIndex) {
  const events = [];
  if (!previousIndex) {
    // If no previous baseline for this org, no events emitted (silent calibration)
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
        details: { summary: `Brand new model **${model.id}** uploaded by ${org}.` }
      });
    } else {
      // Check for gating change (e.g. form opened or unlocked)
      if (Boolean(model.gated) !== Boolean(prev.gated)) {
        events.push({
          type: 'GATING_CHANGED',
          org,
          item: model,
          details: {
            change: model.gated ? 'Changed to Gated (Form Required)' : 'Unlocked / Public Open Weights'
          }
        });
      }

      // Check for weights / commit bump (within last 45 days only to avoid legacy doc touch noise)
      if (model.lastModified && prev.lastModified && model.lastModified !== prev.lastModified) {
        const modDate = new Date(model.lastModified);
        const ageInDays = (Date.now() - modDate.getTime()) / (1000 * 60 * 60 * 24);
        if (ageInDays <= 45) {
          events.push({
            type: 'WEIGHTS_UPDATED',
            org,
            item: model,
            details: { summary: `Model weights / files updated for **${model.id}**.` }
          });
        }
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
        details: { summary: `New curated collection **${col.title || col.slug}** created.` }
      });
    } else if (
      Array.isArray(col.items) &&
      prev.itemCount !== undefined &&
      col.items.length > prev.itemCount
    ) {
      events.push({
        type: 'COLLECTION_UPDATED',
        org,
        item: col,
        details: {
          summary: `Collection **${col.title}** expanded from ${prev.itemCount} to ${col.items.length} items.`
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
