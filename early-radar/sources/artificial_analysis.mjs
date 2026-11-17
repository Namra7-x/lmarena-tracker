/**
 * Artificial Analysis Reverse-Engineer Source Adapter
 * Discovers newly indexed models and evaluation benchmarks from https://artificialanalysis.ai
 * Recovers the deploy-ahead encrypted manifest (AES-GCM + gzip) containing unreleased model benchmarks.
 * Captures full rich JSON specs for any model and evaluation benchmark.
 * Resolves verified non-404 routes:
 *   - Models: https://artificialanalysis.ai/models/${releaseSlug || slug}
 *   - Benchmarks: https://artificialanalysis.ai/evaluations/${slug}
 */

import { webcrypto as crypto } from 'node:crypto';
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
 * Dynamically fetches and decrypts the deploy-ahead internal manifest from artificialanalysis.ai.
 * Recovers the internal dataset containing pre-release models and benchmark records.
 * Pipeline:
 *  1. Extract dynamic path (/data/<hash>.txt) and dynamic AES-256 key from homepage RSC HTML.
 *  2. Fetch binary ciphertext.
 *  3. Derive IV = first 12 bytes of SHA-256(keyBytes).
 *  4. Decrypt via WebCrypto AES-GCM (tagLength 128).
 *  5. Decompress via native gzip DecompressionStream.
 */
export async function fetchEncryptedManifest() {
  try {
    const res = await fetch('https://artificialanalysis.ai/', {
      headers: {
        'User-Agent': RADAR_CONFIG.userAgent,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(RADAR_CONFIG.timeouts.fetch),
    });
    if (!res.ok) return null;

    const html = await res.text();
    const u = html.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    const m = u.match(/"path"\s*:\s*"(\/data\/[^"]+\.txt)"\s*,\s*"key"\s*:\s*"([0-9a-f]+)"/);
    if (!m) return null;

    const path = m[1];
    const key = m[2];
    const binUrl = `https://artificialanalysis.ai${path}`;

    const binRes = await fetch(binUrl, {
      headers: { 'User-Agent': RADAR_CONFIG.userAgent },
      signal: AbortSignal.timeout(RADAR_CONFIG.timeouts.fetch),
    });
    if (!binRes.ok) return null;

    const ct = new Uint8Array(await binRes.arrayBuffer());
    const keyBytes = Uint8Array.from(key.match(/../g).map((x) => parseInt(x, 16)));
    const ivBuffer = await crypto.subtle.digest('SHA-256', keyBytes.buffer);
    const iv = new Uint8Array(ivBuffer).slice(0, 12);

    const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']);
    const plainBuffer = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, cryptoKey, ct);

    const ds = new DecompressionStream('gzip');
    const writer = ds.writable.getWriter();
    writer.write(new Uint8Array(plainBuffer));
    writer.close();

    const jsonText = await new Response(ds.readable).text();
    return JSON.parse(jsonText);
  } catch (err) {
    console.warn(`[AA Manifest] Manifest dynamic recovery note: ${err.message}`);
    return null;
  }
}

/**
 * Extracts all models and benchmarks from Artificial Analysis:
 *  1. Decrypts deploy-ahead internal manifest (399+ frontier models, including unreleased/preview models).
 *  2. Enriches with detailed specs from Next.js SSR /models catalog (pricing, speed, parameters, context).
 *  3. Ingests evaluation benchmarks from generalEvals.
 * Returns { models: Map<slug, modelData>, benchmarks: Map<slug, benchmarkData>, totalCount, benchmarksCount }
 */
export async function fetchArtificialAnalysisModels() {
  const models = new Map();
  const benchmarks = new Map();

  // 1. Recover internal deploy-ahead encrypted manifest
  try {
    const manifest = await fetchEncryptedManifest();
    if (Array.isArray(manifest)) {
      for (const record of manifest) {
        const slug = record.modelSlug || record.slug;
        if (!slug) continue;
        const targetSlug = record.modelSlug || record.slug;
        const creator = record.host?.name || null;
        models.set(slug, {
          slug,
          name: record.name || record.shortName || slug,
          releaseSlug: targetSlug,
          url: `https://artificialanalysis.ai/models/${targetSlug}`,
          creator,
          rawJson: {
            name: record.name || slug,
            slug,
            creator: creator || 'Unknown',
            costPerTask: record.intelligenceIndexCostPerTask?.total
              ? `$${record.intelligenceIndexCostPerTask.total.toFixed(4)}`
              : undefined,
            timePerTaskMs: record.intelligenceIndexTimePerTask
              ? `${Math.round(record.intelligenceIndexTimePerTask)} ms`
              : undefined,
            url: `https://artificialanalysis.ai/models/${targetSlug}`,
          },
        });
      }
    }
  } catch (err) {
    console.warn(`[AA] Deploy-ahead manifest probe fallback: ${err.message}`);
  }

  // 2. Fetch /models SSR page to enrich with detailed specs and evaluation benchmarks
  try {
    const url = RADAR_CONFIG.endpoints.artificialAnalysis;
    const res = await fetch(url, {
      headers: {
        'User-Agent': RADAR_CONFIG.userAgent,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(RADAR_CONFIG.timeouts.fetch),
    });

    if (res.ok) {
      const html = await res.text();

      // Extract structured modelsAndReleases
      const mAndR = extractEscapedJson(html, 'modelsAndReleases');
      const releasesMap = new Map();
      if (mAndR?.releases && Array.isArray(mAndR.releases)) {
        for (const rel of mAndR.releases) {
          if (rel.slug) releasesMap.set(rel.slug, rel);
        }
      }

      if (mAndR?.models && Array.isArray(mAndR.models)) {
        for (const m of mAndR.models) {
          if (!m.slug) continue;
          const targetSlug = m.releaseSlug || m.slug;
          const rel = releasesMap.get(targetSlug) || {};
          const existing = models.get(m.slug) || {};
          models.set(m.slug, {
            ...existing,
            slug: m.slug,
            name: existing.name || m.name || m.slug,
            releaseSlug: targetSlug,
            url: `https://artificialanalysis.ai/models/${targetSlug}`,
            creator: rel.creator?.name || existing.creator || null,
            releaseDate: rel.releaseDate || existing.releaseDate || null,
            deprecated: Boolean(rel.deprecated),
            rawJson: {
              ...(existing.rawJson || {}),
              name: existing.name || m.name || m.slug,
              slug: m.slug,
              releaseSlug: targetSlug,
              creator: rel.creator?.name || existing.creator || 'Unknown',
              releaseDate: rel.releaseDate || undefined,
              deprecated: rel.deprecated || undefined,
              url: `https://artificialanalysis.ai/models/${targetSlug}`,
            },
          });
        }
      }

      // Extract initialModels (featured frontier models with rich specs: pricing, speed, context)
      const initialModels = extractEscapedJson(html, 'initialModels');
      if (initialModels && Array.isArray(initialModels)) {
        for (const m of initialModels) {
          if (!m.slug) continue;
          const targetSlug = m.releaseSlug || m.slug;
          const existing = models.get(m.slug) || {};
          models.set(m.slug, {
            ...existing,
            slug: m.slug,
            name: existing.name || m.name || m.slug,
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
              ...(existing.rawJson || {}),
              name: existing.name || m.name || m.slug,
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
          });
        }
      }

      // Extract evaluation benchmarks from generalEvals
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
    }
  } catch (err) {
    console.warn(`[AA] SSR /models probe note: ${err.message}`);
  }

  return {
    models,
    benchmarks,
    totalCount: models.size,
    benchmarksCount: benchmarks.size,
  };
}
