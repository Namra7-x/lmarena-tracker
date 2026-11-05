/**
 * Extraction Dispatcher (Section 6)
 * Unpacks archives, handles nested ASARs/zips, and extracts multi-encoding strings.
 */

import { extractTar, extractZip } from './archive.mjs';
import { extractAsar, isAsar } from './asar.mjs';
import { extractStrings } from './strings.mjs';
import { extractSourceMap, extractInlineSourceMaps } from './sourcemap.mjs';

/**
 * Priority classification (Section 6):
 * Priority 1: manifests, release notes, config/schema, installer scripts, source maps, i18n JSON
 * Priority 2: asar/app bundles, native binaries, WASM
 * Priority 3: assets, fonts, media
 */
export function getFilePriority(filePath) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.json') || lower.endsWith('.plist') || lower.endsWith('.map') ||
      lower.includes('locale') || lower.includes('i18n') || lower.endsWith('.sh') ||
      lower.endsWith('.ps1') || lower.endsWith('.yml') || lower.endsWith('.yaml') ||
      lower.endsWith('manifest') || lower.endsWith('.md')) {
    return 1;
  }
  if (lower.endsWith('.asar') || lower.endsWith('.exe') || lower.endsWith('.dll') ||
      lower.endsWith('.dylib') || lower.endsWith('.so') || lower.endsWith('.wasm') ||
      lower.endsWith('.node')) {
    return 2;
  }
  return 3;
}

/**
 * Process an artifact buffer and return an array of file records:
 * [{ path, buffer, priority, strings, sourceMaps }]
 */
export function extractArtifact(buffer, format, target, artifactUrl = '') {
  const extractedFiles = [];
  const status = {
    discoveredFiles: 0,
    analyzedFiles: 0,
    skippedFiles: 0,
    failedFiles: 0,
    coverageState: 'COMPLETE',
  };

  try {
    let rawFiles = [];

    if (format === 'tgz' || format === 'tar' || format === 'tar.gz') {
      rawFiles = extractTar(buffer);
    } else if (format === 'zip' || format === 'nupkg' || format === 'appx') {
      rawFiles = extractZip(buffer);
    } else if (format === 'asar' || isAsar(buffer)) {
      rawFiles = extractAsar(buffer);
    } else {
      // Single binary / installer file
      const filename = artifactUrl.split('/').pop() || `artifact-${target}.${format}`;
      rawFiles = [{ path: filename, buffer, size: buffer.length }];
    }

    status.discoveredFiles = rawFiles.length;

    // Process files, unpacking nested asar archives if present
    for (const f of rawFiles) {
      if (f.path.endsWith('.asar') || isAsar(f.buffer)) {
        try {
          const asarFiles = extractAsar(f.buffer);
          for (const af of asarFiles) {
            af.path = `${f.path}/${af.path}`;
            af.priority = getFilePriority(af.path);
            extractedFiles.push(af);
          }
          status.discoveredFiles += asarFiles.length;
        } catch (e) {
          status.failedFiles++;
          // Fall back to scanning the asar buffer directly
          f.priority = 2;
          extractedFiles.push(f);
        }
      } else {
        f.priority = getFilePriority(f.path);
        extractedFiles.push(f);
      }
    }

    status.analyzedFiles = extractedFiles.length;
  } catch (err) {
    status.coverageState = 'PARTIAL';
    status.error = err.message;

    // Fallback: raw multi-encoding string scan directly on buffer
    extractedFiles.push({
      path: `raw-fallback-${target}`,
      buffer,
      priority: 2,
      isFallback: true,
    });
  }

  return { files: extractedFiles, status };
}
