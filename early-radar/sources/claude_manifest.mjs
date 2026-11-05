/**
 * Claude Web App Reverse-Engineer Source Adapter
 * Tracks production build deployments and Vite chunks on https://claude.ai/
 * ZERO HARDCODED MODEL NAMES: dynamically parses imported chunk hashes and model identifiers.
 */

import { RADAR_CONFIG } from '../config.mjs';

/**
 * Dynamically extracts model identifiers from Claude JS chunks without hardcoded names.
 */
export function extractDynamicClaudeIdentifiers(jsText) {
  if (!jsText || typeof jsText !== 'string') return [];

  const extracted = new Set();
  const patterns = [
    /(?:modelId|model_id|defaultModel|modelName)\s*[:=]\s*['"]([a-zA-Z0-9_\-\.\:\/]+)['"]/gi,
    /"(?:modelId|model_id|defaultModel)"\s*:\s*"([a-zA-Z0-9_\-\.\:\/]+)"/gi,
  ];

  for (const regex of patterns) {
    for (const match of jsText.matchAll(regex)) {
      const val = match[1].trim();
      if (val.length > 2 && !['undefined', 'null', 'default', 'true', 'false'].includes(val.toLowerCase())) {
        extracted.add(val);
      }
    }
  }

  return Array.from(extracted);
}

/**
 * Fetches https://claude.ai/ and extracts the current Vite entry bundle hash.
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

  return {
    entryHash,
    entryUrl,
  };
}

/**
 * Downloads the Claude entry bundle and extracts imported chunk hashes.
 */
export async function fetchClaudeImportedChunks(entryHash) {
  const url = `https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/index-${entryHash}.js`;
  const res = await fetch(url, {
    headers: { 'User-Agent': RADAR_CONFIG.userAgent },
    signal: AbortSignal.timeout(RADAR_CONFIG.timeouts.fetch),
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch Claude entry bundle: HTTP ${res.status}`);
  }

  const text = await res.text();
  const imports = [...text.matchAll(/import\("\.\/([^"]+)"\)/g)].map((m) => m[1]);

  return {
    entryHash,
    importedChunks: imports,
    totalImports: imports.length,
  };
}
