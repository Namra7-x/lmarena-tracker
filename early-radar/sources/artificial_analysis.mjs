/**
 * Artificial Analysis Reverse-Engineer Source Adapter
 * Discovers newly indexed models from https://artificialanalysis.ai/models
 */

import { RADAR_CONFIG } from '../config.mjs';

/**
 * Extracts all models and slugs from Artificial Analysis Next.js SSR payload.
 * Returns Map<slug, { slug, name, url }>
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
  const unescaped = html.replace(/\\"/g, '"');

  const models = new Map();

  // Pattern 1: "slug":"...", "name":"..."
  const p1 = /"slug":"([^"]+)","name":"([^"]+)"/g;
  for (const m of unescaped.matchAll(p1)) {
    const slug = m[1].trim();
    const name = m[2].trim();
    if (slug && name && !models.has(slug)) {
      models.set(slug, {
        slug,
        name,
        url: `https://artificialanalysis.ai/models/${slug}`,
      });
    }
  }

  // Pattern 2: "name":"...", "slug":"..."
  const p2 = /"name":"([^"]+)","slug":"([^"]+)"/g;
  for (const m of unescaped.matchAll(p2)) {
    const name = m[1].trim();
    const slug = m[2].trim();
    if (slug && name && !models.has(slug)) {
      models.set(slug, {
        slug,
        name,
        url: `https://artificialanalysis.ai/models/${slug}`,
      });
    }
  }

  // Also check for data manifest hash in HTML: /data/([a-f0-9]+)\.txt
  const dataManifestMatch = html.match(/\/data\/([a-f0-9]{16,})\.txt/);
  const dataManifestHash = dataManifestMatch ? dataManifestMatch[1] : null;

  return {
    models,
    dataManifestHash,
    totalCount: models.size,
  };
}
