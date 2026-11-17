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
const SEVEN_ZIP_TIMEOUT_MS = Number.parseInt(process.env.SEVENZIP_TIMEOUT_MS || '180000', 10);
// Keep the full-extraction fallback bounded, but allow the ~200 MB Windows
// installers to recover when a selective pass does not match their layout.
const SEVEN_ZIP_FULL_FALLBACK_MAX_BYTES = 260 * 1024 * 1024;
// Large ZIP/TAR packages (desktop app bundles) can expand past the built-in
// safe memory limit. Prefer selective 7-Zip extraction, then fall back to the
// in-process readers when the tool is unavailable.
const SEVEN_ZIP_PREFERRED_BYTES = 100 * 1024 * 1024;

// Files that actually contain feature/model/endpoint evidence. Extracting only
// these from a 900 MB DMG is dramatically faster than unpacking the whole app.
const SEVEN_ZIP_INCLUDE_PATTERNS = [
  '*.asar',
  '*.asar.unpacked/*',
  '*.js',
  '*.mjs',
  '*.cjs',
  '*.json',
  '*.plist',
  '*.map',
  '*.wasm',
  '*.exe',
  '*.node',
  '*.yml',
  '*.yaml',
  '*.txt',
  '*.html',
  '*.css',
  '*.md',
];

/**
 * Check if 7z or 7za CLI is available on the host system.
 */
function findSevenZipCommand() {
  for (const cmd of ['7z', '7za', '7zz']) {
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

let gnuTarCommandCache;

/**
 * GNU tar is available on the Ubuntu runners and can stream a large .tar.gz
 * while extracting only the evidence patterns. 7-Zip handles .tar.gz as two
 * nested layers, so using it directly on a tarball can silently extract only
 * the inner .tar file.
 */
function findGnuTarCommand() {
  if (gnuTarCommandCache !== undefined) return gnuTarCommandCache;
  try {
    const res = spawnSync('tar', ['--version'], { encoding: 'utf8', timeout: 2000 });
    gnuTarCommandCache = res.status === 0 && /GNU tar/i.test(`${res.stdout || ''}${res.stderr || ''}`)
      ? 'tar'
      : null;
  } catch {
    gnuTarCommandCache = null;
  }
  return gnuTarCommandCache;
}

function extractWithGnuTar(buffer, filename, cmd, gzipped) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tar-extract-'));
  const tmpInput = path.join(tmpDir, filename || 'archive.tar.gz');
  const tmpOut = path.join(tmpDir, 'out');
  fs.mkdirSync(tmpOut, { recursive: true });

  try {
    fs.writeFileSync(tmpInput, buffer);
    const args = [
      gzipped ? '-xzf' : '-xf',
      tmpInput,
      '-C',
      tmpOut,
      '--wildcards',
      '--no-anchored',
      ...SEVEN_ZIP_INCLUDE_PATTERNS,
    ];
    const proc = spawnSync(cmd, args, {
      timeout: SEVEN_ZIP_TIMEOUT_MS,
      maxBuffer: 50 * 1024 * 1024,
    });

    // GNU tar exits non-zero when one of several patterns is absent, even
    // though the other patterns were extracted successfully. Trust the output
    // directory over the aggregate exit code.
    const walked = walkExtractedFiles(tmpOut);
    const interrupted = Boolean(proc.error || proc.signal);
    if (walked.files.length > 0) {
      return { success: true, files: walked.files, truncated: walked.truncated || interrupted };
    }
    if (proc.status !== 0 || interrupted) return { success: false, files: [], truncated: false };
    return { success: true, files: [], truncated: false };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
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
function evidencePriority(relPath) {
  const lower = String(relPath).toLowerCase();
  // Electron app bundles are the highest-value evidence and are often stored
  // next to hundreds of MB of native libraries. Read them first so a size cap
  // can never skip app.asar in favour of a vendor .dylib.
  if (lower.endsWith('.asar') || lower.includes('.asar.unpacked/')) return 0;
  return getFilePriority(lower) + 1;
}

function walkExtractedFiles(dir) {
  const entries = [];

  function collect(currentDir, prefix = '') {
    if (!fs.existsSync(currentDir)) return;
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, entry.name);
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        collect(fullPath, relPath);
      } else if (entry.isFile()) {
        try {
          entries.push({
            path: relPath,
            fullPath,
            size: fs.statSync(fullPath).size,
          });
        } catch {
          // A file can disappear if 7-Zip is still finishing; ignore it.
        }
      }
    }
  }

  collect(dir);
  entries.sort((a, b) => {
    const priority = evidencePriority(a.path) - evidencePriority(b.path);
    if (priority !== 0) return priority;
    if (a.size !== b.size) return a.size - b.size;
    return a.path.localeCompare(b.path);
  });

  const files = [];
  let totalBytes = 0;
  let truncated = false;
  for (const entry of entries) {
    if (files.length >= MAX_FILE_COUNT) {
      truncated = true;
      break;
    }
    if (totalBytes + entry.size > MAX_TOTAL_EXTRACTED_BYTES) {
      truncated = true;
      continue;
    }
    try {
      files.push({
        path: entry.path,
        buffer: fs.readFileSync(entry.fullPath),
        size: entry.size,
      });
      totalBytes += entry.size;
    } catch {
      truncated = true;
    }
  }

  return { files, truncated };
}

function runSevenZip(buffer, filename, cmd, args) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), '7z-extract-'));
  const tmpInput = path.join(tmpDir, filename || 'archive.bin');
  const tmpOut = path.join(tmpDir, 'out');
  fs.mkdirSync(tmpOut, { recursive: true });

  try {
    fs.writeFileSync(tmpInput, buffer);
    const proc = spawnSync(cmd, [...args, `-o${tmpOut}`, tmpInput], {
      timeout: SEVEN_ZIP_TIMEOUT_MS,
      maxBuffer: 50 * 1024 * 1024,
    });

    if (proc.status !== 0) {
      return { success: false, files: [], truncated: false };
    }

    const walked = walkExtractedFiles(tmpOut);
    return { success: true, files: walked.files, truncated: walked.truncated };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

/**
 * Extract an installer or complex archive using 7-Zip.
 * First pass uses an include list so DMGs do not unpack their entire payload.
 * A full extraction is only attempted for smaller installers if the selective
 * pass finds nothing.
 */
function extractWithSevenZip(buffer, filename, cmd) {
  const includeArgs = [
    'x',
    '-y',
    '-bso0',
    '-bsp0',
    ...SEVEN_ZIP_INCLUDE_PATTERNS.map((pattern) => `-ir!${pattern}`),
  ];

  let result = runSevenZip(buffer, filename, cmd, includeArgs);
  if (result.success && result.files.length > 0) {
    return result;
  }

  if (buffer.length <= SEVEN_ZIP_FULL_FALLBACK_MAX_BYTES) {
    result = runSevenZip(buffer, filename, cmd, ['x', '-y', '-bso0', '-bsp0']);
    if (result.success && result.files.length > 0) {
      return result;
    }
  }

  return { success: false, files: [], truncated: false };
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
    const filename = artifactUrl.split('/').pop() || `artifact-${target}.${format}`;

    // 1. Genuine format detection using magic bytes & format strings
    if (isAsar(buffer) || format === 'asar') {
      rawFiles = extractAsar(buffer);
      status.analyzers.asar = rawFiles.length > 0 ? 'completed' : 'failed';
    } else if (isTarGz(buffer) || format === 'tgz' || format === 'tar' || format === 'tar.gz') {
      let tarError = null;
      const gzipped = isGzip(buffer) || format === 'tgz' || format === 'tar.gz';
      const gnuTarCmd = findGnuTarCommand();

      // Large tarballs are streamed with GNU tar so the vendor runtime is
      // never fully materialized in memory. The built-in reader remains the
      // portable fallback for small packages and Windows development.
      if (gnuTarCmd && buffer.length > SEVEN_ZIP_PREFERRED_BYTES) {
        const res = extractWithGnuTar(buffer, filename, gnuTarCmd, gzipped);
        if (res.success && res.files.length > 0) {
          status.analyzers.tar = 'completed';
          rawFiles = res.files;
          if (res.truncated) {
            status.coverageState = 'PARTIAL';
            status.error = 'tar extraction exceeded safety caps; some files were not analyzed';
          }
        }
      }

      if (rawFiles.length === 0) {
        try {
          rawFiles = extractTar(buffer);
          status.analyzers.tar = rawFiles.length > 0 ? 'completed' : 'failed';
        } catch (err) {
          tarError = err;
          status.analyzers.tar = 'failed';
        }
      }
      if (rawFiles.length === 0 && tarError) {
        status.coverageState = 'PARTIAL';
        status.error = `TAR extraction failed: ${tarError.message}`;
      }
    } else if (isZip(buffer) || format === 'zip' || format === 'nupkg' || format === 'appx') {
      let usedSevenZip = false;
      let zipError = null;

      // Desktop ZIP bundles are often >100 MB compressed and expand past the
      // built-in reader's 1 GB guard. Selective 7-Zip avoids decoding the whole
      // vendor runtime and still recovers app.asar/JS/config evidence.
      if (sevenZipCmd && buffer.length > SEVEN_ZIP_PREFERRED_BYTES) {
        const res = extractWithSevenZip(buffer, filename, sevenZipCmd);
        if (res.success && res.files.length > 0) {
          usedSevenZip = true;
          status.analyzers.zip = 'completed';
          status.analyzers.sevenZip = 'completed';
          rawFiles = res.files;
          if (res.truncated) {
            status.coverageState = 'PARTIAL';
            status.error = '7-Zip extraction exceeded safety caps; some files were not analyzed';
          }
        }
      }

      if (rawFiles.length === 0) {
        try {
          rawFiles = extractZip(buffer);
          status.analyzers.zip = rawFiles.length > 0 ? 'completed' : 'failed';
        } catch (err) {
          zipError = err;
          status.analyzers.zip = 'failed';
        }
      }

      // The built-in ZIP reader does not support every streaming/data-descriptor
      // archive. Fall back to 7-Zip rather than silently believing an empty ZIP.
      if (rawFiles.length === 0 && sevenZipCmd && !usedSevenZip) {
        const res = extractWithSevenZip(buffer, filename, sevenZipCmd);
        if (res.success && res.files.length > 0) {
          status.analyzers.zip = 'completed';
          status.analyzers.sevenZip = 'completed';
          rawFiles = res.files;
          if (res.truncated) {
            status.coverageState = 'PARTIAL';
            status.error = '7-Zip extraction exceeded safety caps; some files were not analyzed';
          }
        }
      }
      if (rawFiles.length === 0 && zipError) {
        status.coverageState = 'PARTIAL';
        status.error = `ZIP extraction failed: ${zipError.message}`;
      }
    } else if (isNsisInstaller(buffer) || format === 'exe' || format === 'dmg' || format === 'pkg' || format === 'msi' || format === 'appimage') {
      if (!sevenZipCmd) {
        // A DMG/NSIS installer cannot be meaningfully unpacked by the raw
        // fallback. Treat it as partial rather than falsely claiming COMPLETE.
        status.analyzers.sevenZip = 'failed';
        status.coverageState = 'PARTIAL';
        status.error = '7-Zip is required for this installer format but was not found';
        rawFiles = [{ path: filename, buffer, size: buffer.length }];
      } else {
        // Use 7-Zip for complex installers and DMGs
        const res = extractWithSevenZip(buffer, filename, sevenZipCmd);
        if (res.success && res.files.length > 0) {
          status.analyzers.sevenZip = 'completed';
          rawFiles = res.files;
          if (res.truncated) {
            status.coverageState = 'PARTIAL';
            status.error = '7-Zip extraction exceeded safety caps; some files were not analyzed';
          }
        } else {
          status.analyzers.sevenZip = 'failed';
          status.coverageState = 'PARTIAL';
          rawFiles = [{ path: filename, buffer, size: buffer.length }];
        }
      }
    } else {
      // Single binary / raw file
      rawFiles = [{ path: filename, buffer, size: buffer.length }];
    }

    if (rawFiles.length === 0 && !isAsar(buffer) && format !== 'binary') {
      status.coverageState = 'PARTIAL';
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

    // The app.asar.unpacked files can be reached both from the raw archive
    // listing and from the nested ASAR branch. Deduplicate by path so every
    // file is scanned exactly once.
    const uniqueFiles = new Map();
    for (const file of extractedFiles) {
      const key = `${file.path}:${file.buffer?.length || 0}`;
      if (!uniqueFiles.has(key)) uniqueFiles.set(key, file);
    }
    extractedFiles.length = 0;
    extractedFiles.push(...uniqueFiles.values());

    status.analyzedFiles = extractedFiles.length;

    // Coverage is not "we downloaded the artifact". It is "we actually
    // recovered analyzable files from it". An ASAR/DMG that yields nothing is
    // a partial extraction even though the HTTP download succeeded.
    if (extractedFiles.length === 0) {
      status.coverageState = 'PARTIAL';
    }
    if (Object.values(status.analyzers).includes('failed')) {
      status.coverageState = 'PARTIAL';
    }
  } catch (err) {
    status.coverageState = 'PARTIAL';
    status.error = err.message;
    if (format === 'asar' || isAsar(buffer)) status.analyzers.asar = 'failed';
    else if (format === 'tgz' || format === 'tar' || format === 'tar.gz') status.analyzers.tar = 'failed';
    else if (format === 'zip' || format === 'nupkg' || format === 'appx') status.analyzers.zip = 'failed';

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
