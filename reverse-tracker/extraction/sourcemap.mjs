/**
 * Source Map Parser (Section 6)
 * Extracts sourcesContent, original source paths, and unminified identifiers.
 */

import { isSafeRelativePath } from './archive.mjs';

/**
 * Parse a source map JSON buffer or string.
 * Returns an array of { path, content, isFirstParty }.
 */
export function extractSourceMap(bufferOrString) {
  const jsonStr = Buffer.isBuffer(bufferOrString)
    ? bufferOrString.toString('utf8')
    : String(bufferOrString);

  let map;
  try {
    map = JSON.parse(jsonStr);
  } catch (err) {
    return [];
  }

  if (!map || !Array.isArray(map.sources)) return [];

  const sources = map.sources;
  const sourcesContent = Array.isArray(map.sourcesContent) ? map.sourcesContent : [];
  const results = [];

  for (let i = 0; i < sources.length; i++) {
    const rawPath = sources[i];
    const content = sourcesContent[i] || '';

    // Clean webpack/vite prefixes like "webpack:///", "file:///"
    const cleanPath = rawPath.replace(/^[a-z0-9_-]+:\/\//i, '').replace(/^[\\\/]+/, '');
    const isFirstParty = !cleanPath.includes('node_modules') && !cleanPath.includes('vendor');

    if (content && typeof content === 'string') {
      results.push({
        path: cleanPath,
        content,
        isFirstParty,
        names: Array.isArray(map.names) ? map.names : [],
      });
    }
  }

  return results;
}

/**
 * Extract inline source maps from a JavaScript file buffer.
 * Looks for //# sourceMappingURL=data:application/json;base64,...
 */
export function extractInlineSourceMaps(jsBuffer) {
  const text = jsBuffer.toString('utf8');
  const inlineRegex = /\/\/#\s*sourceMappingURL=data:application\/json;base64,([A-Za-z0-9+/=]+)/g;
  const results = [];

  let match;
  while ((match = inlineRegex.exec(text)) !== null) {
    try {
      const decodedJson = Buffer.from(match[1], 'base64').toString('utf8');
      const files = extractSourceMap(decodedJson);
      results.push(...files);
    } catch {
      // Ignore corrupt inline map
    }
  }

  return results;
}
