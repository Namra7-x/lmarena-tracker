/**
 * ChatGPT Web App Reverse-Engineer Source Adapter
 * Tracks production build deployments and chunk assets on https://chatgpt.com/
 */

import { RADAR_CONFIG } from '../config.mjs';

/**
 * Fetches https://chatgpt.com/ and extracts the current manifest hash and chunk registry.
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

  // Pattern 1: Desktop React Router Manifest (Preferred)
  const manifestMatch = html.match(/\/cdn\/assets\/manifest-([a-f0-9]+)\.js/);
  if (manifestMatch) {
    const manifestHash = manifestMatch[1];
    return {
      manifestHash,
      manifestUrl: `https://chatgpt.com/cdn/assets/manifest-${manifestHash}.js`,
      buildType: 'desktop-manifest',
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
    };
  }

  // Pattern 3: Any asset chunk hash on /cdn/assets/ or /unauth-mweb/
  const anyChunkMatch = html.match(/\/(cdn|unauth-mweb)\/(assets|scripts)\/[a-zA-Z0-9_\-]+\.([a-f0-9]{8,12})\.js/);
  if (anyChunkMatch) {
    return {
      manifestHash: `chunk-${anyChunkMatch[3]}`,
      manifestUrl: url,
      buildType: 'asset-chunk',
    };
  }

  throw new Error('ChatGPT build/manifest hash not found in HTML response');
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
