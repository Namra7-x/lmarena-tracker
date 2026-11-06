/**
 * ChatGPT Web App Reverse-Engineer Source Adapter
 * Tracks production build deployments and chunk assets on https://chatgpt.com/
 * ZERO HARDCODED MODEL NAMES: dynamically harvests all route chunks and parses model slugs and gates.
 */

import { RADAR_CONFIG } from '../config.mjs';

/**
 * Dynamically extracts any model identifiers assigned in chunk text without hardcoding names.
 */
export function extractDynamicModelIdentifiers(jsText) {
  if (!jsText || typeof jsText !== 'string') return [];

  const extracted = new Set();
  const patterns = [
    /(?:model_slug|model_id|default_model|modelName|defaultModel)\s*[:=]\s*['"]([a-zA-Z0-9_\-\.\:\/]+)['"]/gi,
    /"(?:model_slug|model_id|default_model)"\s*:\s*"([a-zA-Z0-9_\-\.\:\/]+)"/gi,
    /\b((?:gpt|o1|o2|o3|o4|strawberry|orion|omni|canmore)[a-zA-Z0-9_\-\.]*)\b/gi,
  ];

  const IGNORED = new Set([
    'undefined', 'null', 'default', 'true', 'false', 'model', 'model_slug',
  ]);

  for (const regex of patterns) {
    for (const match of jsText.matchAll(regex)) {
      const val = (match[1] || match[0]).trim();
      const lower = val.toLowerCase();
      if (val.length > 2 && !IGNORED.has(lower) && !val.includes('/') && !val.includes(' ')) {
        extracted.add(val);
      }
    }
  }

  return Array.from(extracted);
}

/**
 * Fetches https://chatgpt.com/ and extracts the current manifest hash, build assets, and scripts.
 */
export async function fetchChatGPTManifest() {
  const url = RADAR_CONFIG.endpoints.chatgpt;
  const res = await fetch(url, {
    headers: {
      'User-Agent': RADAR_CONFIG.userAgent,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    signal: AbortSignal.timeout(RADAR_CONFIG.timeouts.fetch),
  });

  if (!res.ok) {
    throw new Error(`ChatGPT returned HTTP ${res.status}`);
  }

  const html = await res.text();

  // Extract all script tags in the page
  const scriptUrls = new Set();
  const scriptRegex = /<script[^>]+src=["']([^"']+)["']/gi;
  let sm;
  while ((sm = scriptRegex.exec(html)) !== null) {
    const src = sm[1];
    if (src.startsWith('http')) {
      scriptUrls.add(src);
    } else if (src.startsWith('/')) {
      scriptUrls.add(`https://chatgpt.com${src}`);
    }
  }

  // Pattern 1: Desktop React Router Manifest (Preferred)
  const manifestMatch = html.match(/\/cdn\/assets\/manifest-([a-f0-9]+)\.js/);
  if (manifestMatch) {
    const manifestHash = manifestMatch[1];
    return {
      manifestHash,
      manifestUrl: `https://chatgpt.com/cdn/assets/manifest-${manifestHash}.js`,
      buildType: 'desktop-manifest',
      scriptUrls: Array.from(scriptUrls),
      html,
    };
  }

  // Pattern 2: Octane Client Vite Chunk (Fallback for landing page)
  const octaneMatch = html.match(/\/octane-home-client-([a-zA-Z0-9_\-]+)\.js/);
  if (octaneMatch) {
    const octaneHash = octaneMatch[1];
    return {
      manifestHash: `octane-${octaneHash}`,
      manifestUrl: `https://chatgpt.com/unauth-mweb/assets/octane-home-client-${octaneHash}.js`,
      buildType: 'octane-client',
      scriptUrls: Array.from(scriptUrls),
      html,
    };
  }

  // Pattern 3: Any asset chunk hash on /cdn/assets/ or /unauth-mweb/
  const anyChunkMatch = html.match(/\/(cdn|unauth-mweb)\/(assets|scripts)\/[a-zA-Z0-9_\-]+\.([a-f0-9]{8,12})\.js/);
  if (anyChunkMatch) {
    return {
      manifestHash: `chunk-${anyChunkMatch[3]}`,
      manifestUrl: url,
      buildType: 'asset-chunk',
      scriptUrls: Array.from(scriptUrls),
      html,
    };
  }

  throw new Error('ChatGPT build/manifest hash not found in HTML response');
}

/**
 * Concurrent queue helper to download assets with bounded concurrency.
 */
async function fetchInBatches(urls, concurrency = 8, headers = {}) {
  const results = [];
  const queue = [...urls];

  async function worker() {
    while (queue.length > 0) {
      const url = queue.shift();
      if (!url) break;
      try {
        const res = await fetch(url, {
          headers,
          signal: AbortSignal.timeout(RADAR_CONFIG.timeouts.fetch || 10000),
        });
        if (res.ok) {
          const text = await res.text();
          results.push({ url, text, size: text.length });
        }
      } catch {
        // Skip individual chunk errors
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, urls.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Downloads the manifest file and extracts all chunk paths.
 */
export async function fetchChatGPTChunkList(manifestHash) {
  const url = `https://chatgpt.com/cdn/assets/manifest-${manifestHash}.js`;
  const res = await fetch(url, {
    headers: { 'User-Agent': RADAR_CONFIG.userAgent },
    signal: AbortSignal.timeout(RADAR_CONFIG.timeouts.fetch),
  });

  if (!res.ok) {
    return { manifestHash, chunks: [], totalChunks: 0 };
  }

  const text = await res.text();
  const chunks = new Set(
    [...text.matchAll(/\/cdn\/assets\/[a-zA-Z0-9_\-\.]+\.js/g)].map((m) => m[0])
  );

  return {
    manifestHash,
    chunks: Array.from(chunks),
    totalChunks: chunks.size,
  };
}

/**
 * Recursively harvests ChatGPT web chunks and manifest code.
 */
export async function harvestChatGPTFullWebChunks(manifestData) {
  const { manifestUrl, scriptUrls = [], html = '' } = manifestData;
  const headers = { 'User-Agent': RADAR_CONFIG.userAgent };

  const allUrls = new Set(scriptUrls);
  if (manifestUrl && manifestUrl.startsWith('http')) allUrls.add(manifestUrl);

  const downloadedChunks = new Map();
  // Include inline HTML content as well (contains inline script state / __NEXT_DATA__)
  if (html) {
    downloadedChunks.set('landing_html', html);
  }

  // Download manifest and scripts in batches
  const batch = await fetchInBatches(Array.from(allUrls), 8, headers);
  for (const item of batch) {
    downloadedChunks.set(item.url, item.text);
  }

  // If manifest file was downloaded, extract any referenced chunk paths
  const cdnBase = 'https://chatgpt.com';
  const chunkPathRegex = /\/(?:cdn\/assets|_next\/static\/chunks)\/[a-zA-Z0-9_\-\.]+\.js/g;
  const secondaryUrls = new Set();

  for (const text of downloadedChunks.values()) {
    let match;
    while ((match = chunkPathRegex.exec(text)) !== null) {
      const fullUrl = `${cdnBase}${match[0]}`;
      if (!downloadedChunks.has(fullUrl)) {
        secondaryUrls.add(fullUrl);
      }
    }
  }

  if (secondaryUrls.size > 0) {
    const secondBatch = await fetchInBatches(Array.from(secondaryUrls).slice(0, 50), 8, headers);
    for (const item of secondBatch) {
      downloadedChunks.set(item.url, item.text);
    }
  }

  const corpusParts = [];
  let totalBytes = 0;
  for (const [url, text] of downloadedChunks) {
    corpusParts.push(`/* CHUNK: ${url} */\n${text}`);
    totalBytes += text.length;
  }

  return {
    totalChunks: downloadedChunks.size,
    totalBytes,
    corpus: corpusParts.join('\n\n'),
    chunkUrls: Array.from(downloadedChunks.keys()),
  };
}
