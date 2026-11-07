/**
 * Extraction Dispatcher (Section 6)
 * Unpacks archives, handles nested ASARs/zips, and extracts multi-encoding strings.
 * Includes magic-byte format detection, 7-Zip fallback, and app.asar.unpacked processing.
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  extractTar,
  extractZip,
  isGzip,
  isTarGz,
  isZip,
  isPeExecutable,
  isNsisInstaller,
  isMachOBinary,
  isJavaClass,
} from './archive.mjs';
import { extractAsar, isAsar } from './asar.mjs';
import { extractStrings } from './strings.mjs';
import { extractSourceMap, extractInlineSourceMaps } from './sourcemap.mjs';

const MAX_TOTAL_EXTRACTED_BYTES = 1024 * 1024 * 1024; // 1 GB safe expansion cap
const MAX_FILE_COUNT = 10000;
const MAX_ARCHIVE_DEPTH = 3;
const MAX_SINGLE_FILE_BYTES = 100 * 1024 * 1024; // 100MB per file cap to protect V8 heap

/**
 * Check if 7z or 7za CLI is available on the host system.
 */
function findSevenZipCommand() {
  for (const cmd of ['7z', '7za']) {
    try {
      const res = spawnSync(cmd, ['-h'], { encoding: 'utf8', timeout: 2000 });
      if (res.status === 0 || res.stdout?.includes('7-Zip') || res.stderr?.includes('7-Zip')) {
        return cmd;
      }
    } catch {
      // not found
    }
  }
  return null;
}

/**
 * Priority classification (Section 6):
 * Priority 1: manifests, release notes, config/schema, installer scripts, source maps, code (JS/TS), i18n JSON
 * Priority 2: asar/app bundles, native binaries (ELF, Mach-O, PE), WASM, CLI executables
 * Priority 3: assets, fonts, media
 */
export function getFilePriority(filePath, buffer = null) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.json') || lower.endsWith('.plist') || lower.endsWith('.map') ||
      lower.includes('locale') || lower.includes('i18n') || lower.endsWith('.sh') ||
      lower.endsWith('.ps1') || lower.endsWith('.yml') || lower.endsWith('.yaml') ||
      lower.endsWith('manifest') || lower.endsWith('.md') || lower.endsWith('.txt') ||
      lower.endsWith('.env') || lower.endsWith('.toml') || lower.endsWith('.js') ||
      lower.endsWith('.mjs') || lower.endsWith('.cjs') || lower.endsWith('.ts') ||
      lower.endsWith('.html') || lower.endsWith('.htm')) {
    return 1;
  }
  if (lower.endsWith('.asar') || lower.endsWith('.exe') || lower.endsWith('.dll') ||
      lower.endsWith('.dylib') || lower.endsWith('.so') || lower.endsWith('.wasm') ||
      lower.endsWith('.node') || lower.endsWith('.dmg') || lower.endsWith('.pkg') ||
      lower.endsWith('.msi') || lower.endsWith('.bin') || lower.endsWith('.appimage') ||
      lower.endsWith('.deb') || lower.endsWith('.rpm') ||
      lower.startsWith('bin/') || lower.includes('/bin/') ||
      lower.startsWith('usr/bin/') || lower.includes('/usr/bin/')) {
    return 2;
  }

  // Check binary magic bytes if buffer is available
  if (buffer && buffer.length >= 4) {
    // ELF binary (\x7fELF)
    if (buffer[0] === 0x7f && buffer[1] === 0x45 && buffer[2] === 0x4c && buffer[3] === 0x46) return 2;
    // Mach-O binary (supports 32/64-bit LE/BE and universal/fat binaries, distinguishes Java class files)
    if (isMachOBinary(buffer)) return 2;
    // Windows PE (MZ)
    if (isPeExecutable(buffer)) return 2;
  }

  // Extensionless files in root or bin (typical Linux/macOS CLI binaries)
  const base = path.basename(filePath);
  if (!base.includes('.') && base.length >= 2) {
    return 2;
  }

  return 3;
}

/**
 * Extract an installer or complex archive using 7-Zip.
 */
function extractWithSevenZip(buffer, filename, cmd) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), '7z-extract-'));
  const tmpInput = path.join(tmpDir, filename || 'archive.bin');
  const tmpOut = path.join(tmpDir, 'out');
  fs.mkdirSync(tmpOut, { recursive: true });

  try {
    fs.writeFileSync(tmpInput, buffer);
    const proc = spawnSync(cmd, ['x', '-y', `-o${tmpOut}`, tmpInput], {
      timeout: 30000,
      maxBuffer: 50 * 1024 * 1024,
    });

    if (proc.status !== 0) {
      return { success: false, files: [] };
    }

    const files = [];
    let totalBytes = 0;

    function walkDir(dir, prefix = '') {
      if (!fs.existsSync(dir) || files.length >= MAX_FILE_COUNT) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (files.length >= MAX_FILE_COUNT) break;
        const fullPath = path.join(dir, entry.name);
        const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walkDir(fullPath, relPath);
        } else if (entry.isFile()) {
          const stat = fs.statSync(fullPath);
          if (totalBytes + stat.size <= MAX_TOTAL_EXTRACTED_BYTES) {
            files.push({
              path: relPath,
              buffer: fs.readFileSync(fullPath),
              size: stat.size,
            });
            totalBytes += stat.size;
          }
        }
      }
    }

    walkDir(tmpOut);
    return { success: true, files };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
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
    analyzers: {
      sevenZip: 'skipped',
      asar: 'skipped',
      tar: 'skipped',
      zip: 'skipped',
    },
  };

  try {
    let rawFiles = [];
    const sevenZipCmd = findSevenZipCommand();

    // 1. Genuine format detection using magic bytes & format strings
    if (isAsar(buffer) || format === 'asar') {
      status.analyzers.asar = 'completed';
      rawFiles = extractAsar(buffer);
    } else if (isTarGz(buffer) || format === 'tgz' || format === 'tar' || format === 'tar.gz') {
      status.analyzers.tar = 'completed';
      rawFiles = extractTar(buffer);
    } else if (isZip(buffer) || format === 'zip' || format === 'nupkg' || format === 'appx') {
      status.analyzers.zip = 'completed';
      rawFiles = extractZip(buffer);
    } else if ((isNsisInstaller(buffer) || format === 'exe' || format === 'dmg') && sevenZipCmd) {
      // Use 7-Zip for complex installers and DMGs
      const filename = artifactUrl.split('/').pop() || `artifact-${target}.${format}`;
      const res = extractWithSevenZip(buffer, filename, sevenZipCmd);
      if (res.success && res.files.length > 0) {
        status.analyzers.sevenZip = 'completed';
        rawFiles = res.files;
      } else {
        status.analyzers.sevenZip = 'failed';
        rawFiles = [{ path: filename, buffer, size: buffer.length }];
      }
    } else {
      // Single binary / raw file
      const filename = artifactUrl.split('/').pop() || `artifact-${target}.${format}`;
      rawFiles = [{ path: filename, buffer, size: buffer.length }];
    }

    status.discoveredFiles = rawFiles.length;

    // 2. Identify app.asar and corresponding app.asar.unpacked files
    const unpackedFilesMap = new Map();
    for (const f of rawFiles) {
      if (f.path.includes('.asar.unpacked/')) {
        unpackedFilesMap.set(f.path, f);
      }
    }

    // 3. Process files, unpacking nested asar archives if present
    for (const f of rawFiles) {
      // Archive depth check: count occurrences of archive extensions in path
      const depthMatches = (f.path.match(/\.(?:asar|zip|tar|tgz|gz|nupkg)/gi) || []).length;
      const isNestedArchive = f.path.endsWith('.asar') || isAsar(f.buffer);

      if (isNestedArchive && depthMatches <= MAX_ARCHIVE_DEPTH) {
        try {
          const asarFiles = extractAsar(f.buffer);
          status.analyzers.asar = 'completed';
          for (const af of asarFiles) {
            af.path = `${f.path}/${af.path}`;
            af.priority = getFilePriority(af.path, af.buffer);
            extractedFiles.push(af);
          }
          status.discoveredFiles += asarFiles.length;

          // Check for matching app.asar.unpacked files alongside this asar
          const unpackedPrefix = f.path.replace(/\.asar$/, '.asar.unpacked/');
          for (const [upath, ufile] of unpackedFilesMap.entries()) {
            if (upath.startsWith(unpackedPrefix) && !extractedFiles.some((ef) => ef.path === ufile.path)) {
              ufile.priority = getFilePriority(ufile.path, ufile.buffer);
              extractedFiles.push(ufile);
            }
          }
        } catch (e) {
          status.failedFiles++;
          status.analyzers.asar = 'failed';
          f.priority = 2;
          extractedFiles.push(f);
        }
      } else {
        f.priority = getFilePriority(f.path, f.buffer);
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
