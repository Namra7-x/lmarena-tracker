/**
 * Artificial Analysis Reverse-Engineer Source Adapter
 * Discovers newly indexed models and evaluation benchmarks from https://artificialanalysis.ai/models
 * Captures full rich JSON specs for any model and evaluation benchmark.
 * Resolves verified non-404 routes:
 *   - Models: https://artificialanalysis.ai/models/${releaseSlug || slug}
 *   - Benchmarks: https://artificialanalysis.ai/evaluations/${slug}
 */

import { RADAR_CONFIG } from '../config.mjs';

/**
 * Robustly extracts a balanced JSON object or array matching a key in HTML / Next.js payload.
 * Handles unescaped and escaped JSON strings (e.g. \"key\" or \\\"key\\\").
 */
export function extractEscapedJson(html, key) {
  const regex = new RegExp(`["\\\\]*${key}["\\\\]*\\s*:\\s*([{\\[])`);
  const match = regex.exec(html);
  if (!match) return null;

  const openingChar = match[1];
  const closingChar = openingChar === '{' ? '}' : ']';
  const startIdx = match.index + match[0].length - 1;

  let depth = 0;
  let inString = false;
  let escape = false;
  let endIdx = -1;

  for (let i = startIdx; i < html.length; i++) {
    const ch = html[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (ch === openingChar) depth++;
      else if (ch === closingChar) {
        depth--;
        if (depth === 0) {
          endIdx = i + 1;
          break;
        }
      }
    }
  }

  if (endIdx === -1) return null;

  const raw = html.slice(startIdx, endIdx);
  try {
    return JSON.parse(raw);
  } catch {
    try {
      const unescaped = raw.replace(/\\\\"/g, '"').replace(/\\"/g, '"').replace(/\\\\\\\\/g, '\\');
      return JSON.parse(unescaped);
    } catch {
      try {
        const cleaned = raw.replace(/\\+"/g, '"');
        return JSON.parse(cleaned);
      } catch {
        return null;
      }
    }
  }
}

/**
 * Extracts all models and benchmarks from Artificial Analysis Next.js SSR payload.
 * Separates genuine AI models from evaluation benchmarks.
 * Resolves verified non-404 URLs for all items.
 * Returns { models: Map<slug, modelData>, benchmarks: Map<slug, benchmarkData>, totalCount, benchmarksCount }
 */
export async function fetchArtificialAnalysisModels() {
  const url = RADAR_CONFIG.endpoints.artificialAnalysis;
  const res = await fetch(url, {
    headers: {
      'User-Agent': RADAR_CONFIG.userAgent,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    signal: AbortSignal.timeout(RADAR_CONFIG.timeouts.fetch),
  });

  if (!res.ok) {
    throw new Error(`Artificial Analysis returned HTTP ${res.status}`);
  }

  const html = await res.text();
  const models = new Map();
  const benchmarks = new Map();

  // 1. Extract structured modelsAndReleases (complete master list of all models and releases)
  const mAndR = extractEscapedJson(html, 'modelsAndReleases');
  const releasesMap = new Map();
  if (mAndR?.releases && Array.isArray(mAndR.releases)) {
    for (const rel of mAndR.releases) {
      if (rel.slug) {
        releasesMap.set(rel.slug, rel);
      }
    }
  }

  if (mAndR?.models && Array.isArray(mAndR.models)) {
    for (const m of mAndR.models) {
      if (!m.slug) continue;
      const targetSlug = m.releaseSlug || m.slug;
      const rel = releasesMap.get(targetSlug) || {};
      const modelEntry = {
        slug: m.slug,
        name: m.name || m.slug,
        releaseSlug: targetSlug,
        url: `https://artificialanalysis.ai/models/${targetSlug}`,
        creator: rel.creator?.name || null,
        releaseDate: rel.releaseDate || null,
        deprecated: Boolean(rel.deprecated),
        rawJson: {
          name: m.name || m.slug,
          slug: m.slug,
          releaseSlug: targetSlug,
          creator: rel.creator?.name || 'Unknown',
          releaseDate: rel.releaseDate || undefined,
          deprecated: rel.deprecated || undefined,
          url: `https://artificialanalysis.ai/models/${targetSlug}`,
        },
      };
      models.set(m.slug, modelEntry);
    }
  }

  // 2. Extract initialModels (featured frontier models with rich specs: pricing, speed, context)
  const initialModels = extractEscapedJson(html, 'initialModels');
  if (initialModels && Array.isArray(initialModels)) {
    for (const m of initialModels) {
      if (!m.slug) continue;
      const targetSlug = m.releaseSlug || m.slug;
      const existing = models.get(m.slug) || {};
      const enriched = {
        ...existing,
        slug: m.slug,
        name: m.name || existing.name || m.slug,
        releaseSlug: targetSlug,
        url: `https://artificialanalysis.ai/models/${targetSlug}`,
        creator: m.creator?.name || existing.creator || null,
        parameters: m.parameters || existing.parameters || null,
        activeParameters: m.inferenceParametersActiveBillions || null,
        contextWindowTokens: m.contextWindowTokens || null,
        isReasoning: Boolean(m.isReasoning),
        releaseDate: m.releaseDate || existing.releaseDate || null,
        price1mInput: m.price1mInputTokens ?? null,
        price1mOutput: m.price1mOutputTokens ?? null,
        outputSpeed: m.headline?.outputSpeed ? Math.round(m.headline.outputSpeed) : null,
        weightsUrl: m.modelWeightsSourceUrl || null,
        license: m.licenseName || null,
        rawJson: {
          name: m.name || existing.name || m.slug,
          slug: m.slug,
          releaseSlug: targetSlug,
          creator: m.creator?.name || existing.creator || 'Unknown',
          parameters: m.parameters ? `${m.parameters}B` : undefined,
          contextWindow: m.contextWindowTokens ? `${m.contextWindowTokens.toLocaleString()} tokens` : undefined,
          isReasoning: m.isReasoning || undefined,
          pricing: m.price1mInputTokens ? `$${m.price1mInputTokens} in / $${m.price1mOutputTokens} out` : undefined,
          outputSpeed: m.headline?.outputSpeed ? `${Math.round(m.headline.outputSpeed)} tok/s` : undefined,
          releaseDate: m.releaseDate || existing.releaseDate || undefined,
          weightsUrl: m.modelWeightsSourceUrl || undefined,
          url: `https://artificialanalysis.ai/models/${targetSlug}`,
        },
      };
      models.set(m.slug, enriched);
    }
  }

  // 3. Extract evaluation benchmarks from generalEvals (never confuse benchmarks with models!)
  const generalEvals = extractEscapedJson(html, 'generalEvals');
  if (generalEvals && Array.isArray(generalEvals)) {
    for (const ev of generalEvals) {
      if (!ev.slug) continue;
      benchmarks.set(ev.slug, {
        slug: ev.slug,
        name: ev.name || ev.slug,
        url: `https://artificialanalysis.ai/evaluations/${ev.slug}`,
        type: 'benchmark',
        rawJson: {
          name: ev.name || ev.slug,
          slug: ev.slug,
          category: 'Evaluation Benchmark',
          url: `https://artificialanalysis.ai/evaluations/${ev.slug}`,
        },
      });
    }
  }

  return {
    models,
    benchmarks,
    totalCount: models.size,
    benchmarksCount: benchmarks.size,
  };
}
