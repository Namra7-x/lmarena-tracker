/**
 * Artificial Analysis Reverse-Engineer Source Adapter
 * Discovers newly indexed models from https://artificialanalysis.ai/models
 * Captures full rich JSON specs for any model.
 */

import { RADAR_CONFIG } from '../config.mjs';

/**
 * Extracts all models and slugs from Artificial Analysis Next.js SSR payload.
 * Returns Map<slug, modelData>
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

  // 1. First, attempt to extract full JSON objects from `initialModels` array
  const idx = html.indexOf('initialModels');
  if (idx !== -1) {
    try {
      const bracketStart = html.indexOf('[', idx);
      let depth = 0;
      let end = -1;
      for (let i = bracketStart; i < html.length; i++) {
        if (html[i] === '[') depth++;
        else if (html[i] === ']') {
          depth--;
          if (depth === 0) {
            end = i + 1;
            break;
          }
        }
      }

      if (end !== -1) {
        const rawJson = html.slice(bracketStart, end).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        const parsedModels = JSON.parse(rawJson);
        for (const m of parsedModels) {
          if (m.slug) {
            models.set(m.slug, {
              slug: m.slug,
              name: m.name || m.slug,
              url: `https://artificialanalysis.ai/models/${m.slug}`,
              creator: m.creator?.name || null,
              parameters: m.parameters || null,
              activeParameters: m.inferenceParametersActiveBillions || null,
              contextWindowTokens: m.contextWindowTokens || null,
              isReasoning: Boolean(m.isReasoning),
              releaseDate: m.releaseDate || null,
              price1mInput: m.price1mInputTokens ?? null,
              price1mOutput: m.price1mOutputTokens ?? null,
              outputSpeed: m.headline?.outputSpeed ? Math.round(m.headline.outputSpeed) : null,
              weightsUrl: m.modelWeightsSourceUrl || null,
              license: m.licenseName || null,
              rawJson: {
                name: m.name,
                slug: m.slug,
                creator: m.creator?.name,
                parameters: m.parameters ? `${m.parameters}B` : undefined,
                contextWindow: m.contextWindowTokens ? `${m.contextWindowTokens.toLocaleString()} tokens` : undefined,
                isReasoning: m.isReasoning || undefined,
                pricing: m.price1mInputTokens ? `$${m.price1mInputTokens} in / $${m.price1mOutputTokens} out` : undefined,
                outputSpeed: m.headline?.outputSpeed ? `${Math.round(m.headline.outputSpeed)} tok/s` : undefined,
                releaseDate: m.releaseDate || undefined,
                weightsUrl: m.modelWeightsSourceUrl || undefined,
              },
            });
          }
        }
      }
    } catch {}
  }

  // 2. Fallback / supplementary scanner for any additional models in SSR stream
  const unescaped = html.replace(/\\"/g, '"');
  const p1 = /"slug":"([^"]+)","name":"([^"]+)"/g;
  for (const m of unescaped.matchAll(p1)) {
    const slug = m[1].trim();
    const name = m[2].trim();
    if (slug && name && !models.has(slug)) {
      models.set(slug, {
        slug,
        name,
        url: `https://artificialanalysis.ai/models/${slug}`,
        rawJson: { name, slug, url: `https://artificialanalysis.ai/models/${slug}` },
      });
    }
  }

  const p2 = /"name":"([^"]+)","slug":"([^"]+)"/g;
  for (const m of unescaped.matchAll(p2)) {
    const name = m[1].trim();
    const slug = m[2].trim();
    if (slug && name && !models.has(slug)) {
      models.set(slug, {
        slug,
        name,
        url: `https://artificialanalysis.ai/models/${slug}`,
        rawJson: { name, slug, url: `https://artificialanalysis.ai/models/${slug}` },
      });
    }
  }

  return {
    models,
    totalCount: models.size,
  };
}
