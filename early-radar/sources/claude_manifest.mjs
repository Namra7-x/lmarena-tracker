/**
 * Claude Web App Reverse-Engineer Source Adapter
 * Tracks production build deployments and Vite/Rolldown chunks on https://claude.ai/
 * ZERO HARDCODED MODEL NAMES: dynamically harvests the full chunk graph and extracts all signals.
 */

import { RADAR_CONFIG } from '../config.mjs';

/**
 * Dynamically extracts model identifiers from Claude JS chunk text without hardcoded names.
 */
export function extractDynamicClaudeIdentifiers(jsText) {
  if (!jsText || typeof jsText !== 'string') return [];

  const extracted = new Set();
  const patterns = [
    /(?:modelId|model_id|defaultModel|modelName|default_model)\s*[:=]\s*['"]([a-zA-Z0-9_\-\.\:\/]+)['"]/gi,
    /"(?:modelId|model_id|defaultModel|default_model)"\s*:\s*"([a-zA-Z0-9_\-\.\:\/]+)"/gi,
    /\b((?:claude|opus|sonnet|haiku|fable|raven|yukon)[a-zA-Z0-9_\-\.]*)\b/gi,
  ];

  const IGNORED = new Set([
    'undefined', 'null', 'default', 'true', 'false', 'model', 'modelid',
    'claude-ai', 'claude.ai', 'claude-tag', 'claude-dot',
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
 * Fetches https://claude.ai/ and extracts the entry bundle hash and initial chunk links.
 */
export async function fetchClaudeManifest() {
  const url = RADAR_CONFIG.endpoints.claude;
  const res = await fetch(url, {
    headers: {
      'User-Agent': RADAR_CONFIG.userAgent,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    signal: AbortSignal.timeout(RADAR_CONFIG.timeouts.fetch),
  });

  if (!res.ok) {
    throw new Error(`Claude returned HTTP ${res.status}`);
  }

  const html = await res.text();
  const indexMatch = html.match(/index-([a-zA-Z0-9_\-]+)\.js/);

  if (!indexMatch) {
    throw new Error('Claude entry bundle hash not found in HTML');
  }

  const entryHash = indexMatch[1];
  const entryUrl = `https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/index-${entryHash}.js`;

  // Discover all script and modulepreload URLs from landing page HTML
  const initialUrls = new Set();
  const scriptRegex = /<script[^>]+src=["']([^"']+)["']/gi;
  const preloadRegex = /<link[^>]+rel=["']modulepreload["'][^>]+href=["']([^"']+)["']/gi;

  let m;
  while ((m = scriptRegex.exec(html)) !== null) initialUrls.add(m[1]);
  while ((m = preloadRegex.exec(html)) !== null) initialUrls.add(m[1]);

  return {
    entryHash,
    entryUrl,
    initialUrls: Array.from(initialUrls),
    html,
  };
}

/**
 * Concurrent queue helper to download assets with bounded concurrency.
 */
async function fetchInBatches(urls, concurrency = 10, headers = {}) {
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
        // Silently skip transient individual chunk fetch failures
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, urls.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Recursively harvests the ENTIRE Claude web chunk graph (all 80+ chunks).
 */
export async function harvestClaudeFullWebChunks(manifestData) {
  const { entryUrl, initialUrls = [] } = manifestData;
  const headers = { 'User-Agent': RADAR_CONFIG.userAgent };
  const cdnBase = 'https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/';

  const allChunkUrls = new Set([entryUrl, ...initialUrls]);

  // First fetch the entry bundle to extract dynamic imports
  let entryJs = '';
  try {
    const entryRes = await fetch(entryUrl, { headers, signal: AbortSignal.timeout(10000) });
    if (entryRes.ok) {
      entryJs = await entryRes.text();
      const dynImportRegex = /import\s*\(\s*["'](?:\.\/)?([^"']+\.js)["']\s*\)/g;
      let dm;
      while ((dm = dynImportRegex.exec(entryJs)) !== null) {
        const chunkFile = dm[1];
        const fullUrl = chunkFile.startsWith('http') ? chunkFile : `${cdnBase}${chunkFile}`;
        allChunkUrls.add(fullUrl);
      }
    }
  } catch {}

  // Download all chunks in concurrent batches
  const downloadedChunks = await fetchInBatches(Array.from(allChunkUrls), 10, headers);

  // Combine full text corpus for deep analysis
  const corpusParts = [];
  let totalBytes = 0;
  for (const item of downloadedChunks) {
    corpusParts.push(`/* CHUNK: ${item.url} */\n${item.text}`);
    totalBytes += item.size;
  }

  // Include entryJs if not already in downloadedChunks
  if (entryJs && !downloadedChunks.some((c) => c.url === entryUrl)) {
    corpusParts.push(`/* CHUNK: ${entryUrl} */\n${entryJs}`);
    totalBytes += entryJs.length;
  }

  return {
    totalChunks: downloadedChunks.length,
    totalBytes,
    corpus: corpusParts.join('\n\n'),
    chunkUrls: downloadedChunks.map((c) => c.url),
  };
}
