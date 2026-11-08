/**
 * Qwen Cloud Markdown Parser & Enricher
 * Extracts pricing rows, rate limits, and context windows from per-model Markdown pages.
 */

import { QWEN_CONFIG } from './config.mjs';

/**
 * Parses markdown text to extract Pricing, Rate Limits, and Overview sections.
 */
export function parseModelMarkdown(text) {
  const result = {
    pricing: {},
    limits: {},
    overview: '',
  };

  if (!text || typeof text !== 'string') return result;

  // 1. Extract Overview
  const ovMatch = text.match(/##\s+Overview\s+([\s\S]*?)(?=\n##|\n#[^#]|$)/i);
  if (ovMatch) {
    result.overview = ovMatch[1].trim();
  }

  // 2. Extract Pricing
  const pMatch = text.match(/##\s+Pricing\s+([\s\S]*?)(?=\n##|\n#[^#]|$)/i);
  if (pMatch) {
    const rawPricing = pMatch[1];
    // Matches: *   Item Name \n\n    $Value Description
    const listItems = rawPricing.match(/\*\s+([^\n]+)\s*\n+([^\n*]+)/g);
    if (listItems) {
      for (const item of listItems) {
        const m = item.match(/\*\s+([^\n]+)\s*\n+([^\n*]+)/);
        if (m) {
          const k = m[1].trim();
          const v = m[2].trim().replace(/\s+/g, ' ');
          if (k && v && !k.toLowerCase().includes('built-in')) {
            result.pricing[k] = v;
          }
        }
      }
    }
  }

  // 3. Extract Rate Limits & Context
  const lMatch = text.match(/##\s+Rate Limits & Context\s+([\s\S]*?)(?=\n##|\n#[^#]|$)/i);
  if (lMatch) {
    const rawLimits = lMatch[1];
    const listItems = rawLimits.match(/\*\s+([^\n]+)\s*\n+([^\n*]+)/g);
    if (listItems) {
      for (const item of listItems) {
        const m = item.match(/\*\s+([^\n]+)\s*\n+([^\n*]+)/);
        if (m) {
          const k = m[1].trim();
          const v = m[2].trim().replace(/\s+/g, ' ');
          if (k && v) {
            result.limits[k] = v;
          }
        }
      }
    }
  }

  return result;
}

/**
 * Fetches and parses a single model's markdown page.
 */
export async function fetchModelMarkdown(markdownUrl) {
  try {
    const res = await fetch(markdownUrl, {
      headers: {
        'User-Agent': QWEN_CONFIG.userAgent,
        Accept: 'text/markdown,text/plain,*/*',
      },
      signal: AbortSignal.timeout(QWEN_CONFIG.timeouts.markdown),
    });

    if (res.status === 404) {
      // Documented edge case: 6 models do not have pricing/markdown pages
      return { pricing: {}, limits: {}, overview: '', notFound: true };
    }

    if (!res.ok) {
      return { pricing: {}, limits: {}, overview: '', error: `HTTP ${res.status}` };
    }

    const text = await res.text();
    return parseModelMarkdown(text);
  } catch (err) {
    return { pricing: {}, limits: {}, overview: '', error: err.message };
  }
}

/**
 * Concurrently enriches model objects with Markdown details (Pricing & Limits).
 * Implements intelligent warm-run caching: only fetches markdown for NEW models or when updateAt changes.
 */
export async function enrichModels(modelsMap, previousSnapshot = null, concurrency = 10) {
  const prevModels = previousSnapshot?.models || {};
  const entries = Array.from(modelsMap.entries());
  let cacheHits = 0;
  let networkFetches = 0;

  // Identify which models can be served from cache vs need fetching
  const tasks = entries.map(([modelId, modelSpec]) => {
    const prev = prevModels[modelId];
    const isUnchanged = prev && prev.updateAt && prev.updateAt === modelSpec.updateAt && prev.pricing;

    if (isUnchanged) {
      cacheHits++;
      modelSpec.pricing = prev.pricing || {};
      modelSpec.limits = prev.limits || {};
      if (!modelSpec.description && prev.overview) {
        modelSpec.overview = prev.overview;
      }
      return null;
    }

    networkFetches++;
    return async () => {
      const details = await fetchModelMarkdown(modelSpec.markdownUrl);
      modelSpec.pricing = details.pricing || {};
      modelSpec.limits = details.limits || {};
      if (details.overview) {
        modelSpec.markdownOverview = details.overview;
      }
    };
  }).filter(Boolean);

  console.log(`[Qwen Markdown] Cache hits: ${cacheHits}, Network fetches required: ${networkFetches}`);

  // Run pending fetches through a bounded concurrency pool
  let index = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (index < tasks.length) {
      const task = tasks[index++];
      if (task) {
        await task();
      }
    }
  });

  await Promise.all(workers);
  return modelsMap;
}
