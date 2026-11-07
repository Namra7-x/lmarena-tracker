/**
 * Source Map Parser (Section 6)
 * Extracts sourcesContent, original source paths, and unminified identifiers.
 * Robust against stripped production maps where sourcesContent is omitted.
 */

import { isSafeRelativePath } from './archive.mjs';

/**
 * Parse a source map JSON buffer or string.
 * Returns an array of { path, content, isFirstParty, names }.
 * Only creates file records when sourcesContent is non-empty.
 */
export function extractSourceMap(bufferOrString) {
  const meta = extractSourceMapMetadata(bufferOrString);
  return meta.files;
}

/**
 * Extract complete source map metadata: original source paths,
 * unminified symbol names, and reconstructed source files (if sourcesContent is present).
 */
export function extractSourceMapMetadata(bufferOrString) {
  const jsonStr = Buffer.isBuffer(bufferOrString)
    ? bufferOrString.toString('utf8')
    : String(bufferOrString);

  let map;
  try {
    map = JSON.parse(jsonStr);
  } catch (err) {
    return { files: [], names: [], sources: [], hasSourcesContent: false };
  }

  if (!map || typeof map !== 'object') {
    return { files: [], names: [], sources: [], hasSourcesContent: false };
  }

  const rawSources = Array.isArray(map.sources) ? map.sources : [];
  const rawNames = Array.isArray(map.names) ? map.names : [];
  const sourcesContent = Array.isArray(map.sourcesContent) ? map.sourcesContent : [];
  const hasSourcesContent = sourcesContent.some((c) => typeof c === 'string' && c.length > 0);

  const cleanSources = [];
  const files = [];

  for (let i = 0; i < rawSources.length; i++) {
    const rawPath = rawSources[i];
    if (typeof rawPath !== 'string') continue;

    // Clean webpack/vite prefixes like "webpack:///", "file:///", "turbopack:///"
    const cleanPath = rawPath.replace(/^[a-z0-9_-]+:\/\//i, '').replace(/^[\\\/]+/, '');
    const isFirstParty = !cleanPath.includes('node_modules') && !cleanPath.includes('vendor');

    if (isFirstParty && isSafeRelativePath(cleanPath)) {
      cleanSources.push(cleanPath);
    }

    const content = sourcesContent[i];
    // Only construct file representation when genuine sourcesContent is available
    if (typeof content === 'string' && content.trim().length > 0) {
      files.push({
        path: cleanPath,
        content,
        isFirstParty,
        names: rawNames,
      });
    }
  }

  // Filter unminified identifier names to clean human-readable strings
  const validNames = rawNames.filter(
    (name) => typeof name === 'string' && name.length >= 3 && name.length <= 120 && !name.includes(' ')
  );

  return {
    files,
    names: validNames,
    sources: cleanSources,
    hasSourcesContent,
  };
}

/**
 * Extract inline source maps from a JavaScript file buffer.
 * Looks for //# sourceMappingURL=data:application/json;base64,...
 */
export function extractInlineSourceMaps(jsBuffer) {
  if (!jsBuffer) return [];
  const text = Buffer.isBuffer(jsBuffer) ? jsBuffer.toString('utf8') : String(jsBuffer);
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
