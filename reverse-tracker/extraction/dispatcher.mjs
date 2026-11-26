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

const MAX_TOTAL_EXTRACTED_BYTES = 2048 * 1024 * 1024; // 2 GB comprehensive safety limit
const MAX_SINGLE_FILE_BYTES = 1024 * 1024 * 1024; // 1 GB max per single file
const MAX_FILE_COUNT = 50000;
const MAX_ARCHIVE_DEPTH = 5;
const SEVEN_ZIP_TIMEOUT_MS = Number.parseInt(process.env.SEVENZIP_TIMEOUT_MS || '60000', 10);
// Small installer limit for uncompressed fallback: full uncompressed fallback
// is capped at 500MB to allow complete extraction of desktop packages.
const SEVEN_ZIP_FULL_FALLBACK_MAX_BYTES = 500 * 1024 * 1024;
// Large ZIP/TAR packages (desktop app bundles) can expand past the built-in
// safe memory limit. Prefer selective 7-Zip extraction, then fall back to the
// in-process readers when the tool is unavailable.
const SEVEN_ZIP_PREFERRED_BYTES = 100 * 1024 * 1024;

const IGNORED_EXT_REGEX = /\.(?:png|jpe?g|gif|svg|webp|ico|bmp|tiff|avif|mp3|wav|ogg|mp4|webm|woff2?|ttf|eot|otf|car|nib|icns)$/i;
const RAW_DISK_IMAGE_REGEX = /\.(?:hfs|dd|iso|raw|img)$/i;

// Comprehensive patterns capturing 100% of code, config, strings, and binary chunks across the entire bundle.
const SEVEN_ZIP_INCLUDE_PATTERNS = [
  '*.asar',
  '*.asar.unpacked/*',
  '*/MacOS/*',
  '*MacOS*',
  '*.plist',
  '*.hfs',
  '*.pkg',
  '*.tar',
  '*.tar.gz',
  '*.tgz',
  '*.js',
  '*.mjs',
  '*.cjs',
  '*.ts',
  '*.tsx',
  '*.jsx',
  '*.json',
  '*.map',
  '*.wasm',
  '*.exe',
  '*.dylib',
  '*.so',
  '*.bin',
  '*.node',
  '*.yml',
  '*.yaml',
  '*.toml',
  '*.ini',
  '*.xml',
  '*.txt',
  '*.html',
  '*.htm',
  '*.css',
  '*.md',
  '*.sh',
  '*.env*',
  '*app*',
  '*config*',
  '*model*',
  '*catalog*',
  '*setting*',
  '*preference*',
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

function extractWithGnuTar(buffer, filename, cmd, gzipped, options = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tar-extract-'));
  const tmpInput = path.join(tmpDir, filename || 'archive.tar.gz');
  const tmpOut = path.join(tmpDir, 'out');
  fs.mkdirSync(tmpOut, { recursive: true });
  let preserveTmpDir = false;

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

    const walked = walkExtractedFiles(tmpOut, { lazyDisk: Boolean(options.streamFromDisk) });
    const interrupted = Boolean(proc.error || proc.signal);
    if (walked.files.length > 0) {
      if (options.streamFromDisk) {
        preserveTmpDir = true;
        try { fs.unlinkSync(tmpInput); } catch {}
      }
      return {
        success: true,
        files: walked.files,
        truncated: walked.truncated || interrupted,
        tmpDir: preserveTmpDir ? tmpDir : null,
      };
    }
    if (proc.status !== 0 || interrupted) return { success: false, files: [], truncated: false, tmpDir: null };
    return { success: true, files: [], truncated: false, tmpDir: null };
  } finally {
    if (!preserveTmpDir) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
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

function walkExtractedFiles(dir, options = {}) {
  const lazyDisk = Boolean(options.lazyDisk);
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
    if (IGNORED_EXT_REGEX.test(entry.path) || RAW_DISK_IMAGE_REGEX.test(entry.path)) {
      continue;
    }
    if (entry.size > MAX_SINGLE_FILE_BYTES) {
      truncated = true;
      continue;
    }
    if (files.length >= MAX_FILE_COUNT) {
      truncated = true;
      break;
    }
    if (totalBytes + entry.size > MAX_TOTAL_EXTRACTED_BYTES) {
      truncated = true;
      continue;
    }
    try {
      // Container files (.asar, .hfs) are unpacked in the next phase; load lazily for regular files
      const lower = entry.path.toLowerCase();
      const needsImmediateBuffer = !lazyDisk || lower.endsWith('.asar') || RAW_DISK_IMAGE_REGEX.test(lower);
      if (needsImmediateBuffer) {
        files.push({
          path: entry.path,
          fullPath: entry.fullPath,
          buffer: fs.readFileSync(entry.fullPath),
          size: entry.size,
        });
      } else {
        files.push({
          path: entry.path,
          fullPath: entry.fullPath,
          buffer: null,
          size: entry.size,
          lazyDisk: true,
        });
      }
      totalBytes += entry.size;
    } catch {
      truncated = true;
    }
  }

  return { files, truncated };
}

/**
 * Automatically unpacks nested .hfs or raw disk partition images directly on disk
 * using 7-Zip, then purges the multi-gigabyte raw image so it is never loaded into
 * Node.js heap memory.
 */
function unpackNestedDiskImagesOnDisk(dir, cmd) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isFile() && RAW_DISK_IMAGE_REGEX.test(entry.name)) {
      const safeName = entry.name.replace(/[^a-zA-Z0-9]/g, '_');
      const nestedOut = path.join(dir, `extracted_disk_${safeName}`);
      fs.mkdirSync(nestedOut, { recursive: true });
      const includeArgs = [
        'x',
        '-y',
        '-bso0',
        '-bsp0',
        ...SEVEN_ZIP_INCLUDE_PATTERNS.map((pattern) => `-ir!${pattern}`),
      ];
      spawnSync(cmd, [...includeArgs, `-o${nestedOut}`, fullPath], {
        timeout: SEVEN_ZIP_TIMEOUT_MS,
        maxBuffer: 50 * 1024 * 1024,
      });
      try {
        fs.unlinkSync(fullPath);
      } catch {
        // ignore
      }
      unpackNestedDiskImagesOnDisk(nestedOut, cmd);
    } else if (entry.isDirectory()) {
      unpackNestedDiskImagesOnDisk(fullPath, cmd);
    }
  }
}

function runSevenZip(buffer, filename, cmd, args, options = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), '7z-extract-'));
  const tmpInput = path.join(tmpDir, filename || 'archive.bin');
  const tmpOut = path.join(tmpDir, 'out');
  fs.mkdirSync(tmpOut, { recursive: true });
  let preserveTmpDir = false;

  try {
    fs.writeFileSync(tmpInput, buffer);
    const proc = spawnSync(cmd, [...args, `-o${tmpOut}`, tmpInput], {
      timeout: SEVEN_ZIP_TIMEOUT_MS,
      maxBuffer: 50 * 1024 * 1024,
    });

    if (proc.status !== 0 && proc.status !== 1 && proc.status !== 2) {
      return { success: false, files: [], truncated: false, tmpDir: null };
    }

    unpackNestedDiskImagesOnDisk(tmpOut, cmd);

    const walked = walkExtractedFiles(tmpOut, { lazyDisk: Boolean(options.streamFromDisk) });
    if (walked.files.length === 0) {
      return { success: false, files: [], truncated: false, tmpDir: null };
    }
    if (options.streamFromDisk && walked.files.length > 0) {
      preserveTmpDir = true;
      try { fs.unlinkSync(tmpInput); } catch {}
    }
    return {
      success: true,
      files: walked.files,
      truncated: walked.truncated,
      tmpDir: preserveTmpDir ? tmpDir : null,
    };
  } finally {
    if (!preserveTmpDir) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

/**
 * Extract an installer or complex archive using 7-Zip.
 * First pass uses an include list so DMGs do not unpack their entire payload.
 * A full extraction is only attempted for smaller installers if the selective
 * pass finds nothing.
 */
function extractWithSevenZip(buffer, filename, cmd, options = {}) {
  const includeArgs = [
    'x',
    '-y',
    '-bso0',
    '-bsp0',
    ...SEVEN_ZIP_INCLUDE_PATTERNS.map((pattern) => `-ir!${pattern}`),
  ];

  let result = runSevenZip(buffer, filename, cmd, includeArgs, options);
  if (result.success && result.files.length > 0) {
    return result;
  }

  if (buffer.length <= SEVEN_ZIP_FULL_FALLBACK_MAX_BYTES) {
    result = runSevenZip(buffer, filename, cmd, ['x', '-y', '-bso0', '-bsp0'], options);
    if (result.success && result.files.length > 0) {
      return result;
    }
  }

  return { success: false, files: [], truncated: false, tmpDir: null };
}

function hasBinary(cmd) {
  try {
    const res = spawnSync('which', [cmd], { encoding: 'utf8', timeout: 2000 });
    return res.status === 0;
  } catch {
    return false;
  }
}

/**
 * Native macOS DMG extraction via Apple's built-in `hdiutil` (handles 100% of APFS DMGs
 * such as Gemini.dmg and Codex.dmg cleanly on `macos-latest` GitHub Actions runners).
 */
function extractHdiutilDmg(buffer, filename, options = {}) {
  if (process.platform !== 'darwin') {
    return { success: false, files: [], truncated: false, tmpDir: null };
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hdiutil-extract-'));
  const tmpDmg = path.join(tmpDir, filename || 'disk.dmg');
  const mntDir = path.join(tmpDir, 'mnt');
  const outCopy = path.join(tmpDir, 'out');
  fs.mkdirSync(mntDir, { recursive: true });
  fs.mkdirSync(outCopy, { recursive: true });
  let mounted = false;
  let preserveTmpDir = false;

  try {
    fs.writeFileSync(tmpDmg, buffer);
    const attach = spawnSync('hdiutil', ['attach', tmpDmg, '-readonly', '-nobrowse', '-mountpoint', mntDir], {
      timeout: 90000,
    });
    if (attach.status !== 0) {
      return { success: false, files: [], truncated: false, tmpDir: null };
    }
    mounted = true;

    // Copy analyzable files from mounted .app bundle (asar, JS, JSON, plists, main Mach-O binaries)
    spawnSync('bash', ['-c', `find "${mntDir}" -maxdepth 7 \\( -name "*.asar" -o -name "*.asar.unpacked" -o -name "*.js" -o -name "*.mjs" -o -name "*.cjs" -o -name "*.json" -o -name "*.plist" -o -path "*/Contents/MacOS/*" \\) ! -path "*/_CodeSignature/*" -type f -print0 | rsync -a --from0 --files-from=- / "${outCopy}/" 2>/dev/null || find "${mntDir}" -maxdepth 7 \\( -name "*.asar" -o -name "*.js" -o -name "*.json" -o -name "*.plist" -o -path "*/Contents/MacOS/*" \\) ! -path "*/_CodeSignature/*" -type f -exec ditto {} "${outCopy}/{}" \\;`], {
      timeout: 120000,
    });

    // If nested path copy didn't match, fall back cleanly to copying top-level .app bundles excluding large assets
    let walked = walkExtractedFiles(outCopy, { lazyDisk: Boolean(options.streamFromDisk) });
    if (walked.files.length === 0) {
      spawnSync('rsync', ['-a', '--exclude', '*.car', '--exclude', '*.icns', '--exclude', '*.png', '--exclude', '*.jpg', '--exclude', '*/_CodeSignature/*', `${mntDir}/`, `${outCopy}/`], {
        timeout: 120000,
      });
      walked = walkExtractedFiles(outCopy, { lazyDisk: Boolean(options.streamFromDisk) });
    }

    for (let i = 0; i < 4; i++) {
      const det = spawnSync('hdiutil', ['detach', mntDir, '-force'], { timeout: 15000 });
      if (det.status === 0) {
        mounted = false;
        break;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    }
    try { fs.unlinkSync(tmpDmg); } catch {}

    if (walked.files.length > 0) {
      if (options.streamFromDisk) preserveTmpDir = true;
      return {
        success: true,
        files: walked.files,
        truncated: walked.truncated,
        tmpDir: preserveTmpDir ? tmpDir : null,
      };
    }
    return { success: false, files: [], truncated: false, tmpDir: null };
  } catch {
    return { success: false, files: [], truncated: false, tmpDir: null };
  } finally {
    if (mounted) {
      try { spawnSync('hdiutil', ['detach', mntDir, '-force'], { timeout: 10000 }); } catch {}
    }
    if (!preserveTmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  }
}

/**
 * Lazy-extract modern macOS APFS DMGs on Linux using dmg2img + fsapfsmount.
 * Installs tools only if a DMG actually fails 7-Zip during a new release, keeping
 * idle 1-minute GitHub Actions checks at zero overhead.
 */
function extractApfsDmg(buffer, filename, options = {}) {
  if (process.platform !== 'linux') {
    return { success: false, files: [], truncated: false, tmpDir: null };
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apfs-extract-'));
  const tmpDmg = path.join(tmpDir, filename || 'disk.dmg');
  const tmpImg = path.join(tmpDir, 'disk.img');
  const mntDir = path.join(tmpDir, 'mnt');
  const outCopy = path.join(tmpDir, 'out');
  fs.mkdirSync(mntDir, { recursive: true });
  fs.mkdirSync(outCopy, { recursive: true });
  let mounted = false;
  let preserveTmpDir = false;

  try {
    if (!hasBinary('dmg2img') || !hasBinary('fsapfsmount')) {
      spawnSync('sudo', ['apt-get', 'update', '-qq'], { timeout: 60000 });
      spawnSync('sudo', ['apt-get', 'install', '-qq', '-y', '--no-install-recommends', 'dmg2img', 'libfsapfs-utils'], {
        timeout: 120000,
      });
    }
    if (!hasBinary('dmg2img') || !hasBinary('fsapfsmount')) {
      return { success: false, files: [], truncated: false, tmpDir: null };
    }

    fs.writeFileSync(tmpDmg, buffer);
    const conv = spawnSync('dmg2img', ['-s', tmpDmg, tmpImg], { timeout: 90000 });
    if (conv.status !== 0 || !fs.existsSync(tmpImg)) {
      return { success: false, files: [], truncated: false, tmpDir: null };
    }
    try { fs.unlinkSync(tmpDmg); } catch {}

    const mnt = spawnSync('fsapfsmount', [tmpImg, mntDir], { timeout: 60000 });
    if (mnt.status === 0) {
      mounted = true;
      // Copy selective analyzable directories (.app Contents / Resources / MacOS)
      spawnSync('bash', ['-c', `shopt -s globstar nullglob; find "${mntDir}" -maxdepth 6 \\( -name "*.asar" -o -name "*.js" -o -name "*.json" -o -name "*.plist" -o -path "*/Contents/MacOS/*" \\) -type f -exec cp --parents {} "${outCopy}/" \\;`], {
        timeout: 90000,
      });
    }

    if (mounted) {
      spawnSync('fusermount', ['-u', mntDir], { timeout: 15000 });
      mounted = false;
    }
    try { fs.unlinkSync(tmpImg); } catch {}

    const walked = walkExtractedFiles(outCopy, { lazyDisk: Boolean(options.streamFromDisk) });
    if (walked.files.length > 0) {
      if (options.streamFromDisk) preserveTmpDir = true;
      return {
        success: true,
        files: walked.files,
        truncated: walked.truncated,
        tmpDir: preserveTmpDir ? tmpDir : null,
      };
    }
    return { success: false, files: [], truncated: false, tmpDir: null };
  } catch {
    return { success: false, files: [], truncated: false, tmpDir: null };
  } finally {
    if (mounted) {
      try { spawnSync('fusermount', ['-u', mntDir], { timeout: 10000 }); } catch {}
    }
    if (!preserveTmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  }
}

/**
 * Process an artifact buffer and return an array of file records:
 * [{ path, buffer, priority, strings, sourceMaps }]
 */
export function extractArtifact(buffer, format, target, artifactUrl = '', options = {}) {
  const extractedFiles = [];
  const tempDirsToCleanup = [];
  const cleanup = () => {
    while (tempDirsToCleanup.length > 0) {
      const dir = tempDirsToCleanup.pop();
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
  };

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

      if (gnuTarCmd && buffer.length > SEVEN_ZIP_PREFERRED_BYTES) {
        const res = extractWithGnuTar(buffer, filename, gnuTarCmd, gzipped, options);
        if (res.success && res.files.length > 0) {
          if (res.tmpDir) tempDirsToCleanup.push(res.tmpDir);
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

      if (sevenZipCmd && buffer.length > SEVEN_ZIP_PREFERRED_BYTES) {
        const res = extractWithSevenZip(buffer, filename, sevenZipCmd, options);
        if (res.success && res.files.length > 0) {
          if (res.tmpDir) tempDirsToCleanup.push(res.tmpDir);
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

      if (rawFiles.length === 0 && sevenZipCmd && !usedSevenZip) {
        const res = extractWithSevenZip(buffer, filename, sevenZipCmd, options);
        if (res.success && res.files.length > 0) {
          if (res.tmpDir) tempDirsToCleanup.push(res.tmpDir);
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
      let installerFiles = [];
      if (process.platform === 'darwin' && format === 'dmg') {
        const hdiRes = extractHdiutilDmg(buffer, filename, options);
        if (hdiRes.success && hdiRes.files.length > 0) {
          if (hdiRes.tmpDir) tempDirsToCleanup.push(hdiRes.tmpDir);
          status.analyzers.sevenZip = 'completed';
          installerFiles = hdiRes.files;
          if (hdiRes.truncated) {
            status.coverageState = 'PARTIAL';
            status.error = 'hdiutil extraction exceeded safety caps; some files were not analyzed';
          }
        }
      }

      if (installerFiles.length === 0 && sevenZipCmd) {
        const res = extractWithSevenZip(buffer, filename, sevenZipCmd, options);
        if (res.success && res.files.length > 0) {
          if (res.tmpDir) tempDirsToCleanup.push(res.tmpDir);
          status.analyzers.sevenZip = 'completed';
          installerFiles = res.files;
          if (res.truncated) {
            status.coverageState = 'PARTIAL';
            status.error = '7-Zip extraction exceeded safety caps; some files were not analyzed';
          }
        }
      }

      // Modern macOS APFS DMGs (e.g. Codex.dmg, Gemini.dmg) fail in older 7z; try native dmg2img + fsapfsmount.
      if (installerFiles.length === 0 && format === 'dmg') {
        const apfsRes = extractApfsDmg(buffer, filename, options);
        if (apfsRes.success && apfsRes.files.length > 0) {
          if (apfsRes.tmpDir) tempDirsToCleanup.push(apfsRes.tmpDir);
          status.analyzers.sevenZip = 'completed';
          installerFiles = apfsRes.files;
          if (apfsRes.truncated) {
            status.coverageState = 'PARTIAL';
            status.error = 'APFS DMG extraction exceeded safety caps; some files were not analyzed';
          }
        }
      }

      if (installerFiles.length > 0) {
        rawFiles = installerFiles;
      } else {
        status.analyzers.sevenZip = 'failed';
        status.coverageState = 'PARTIAL';
        status.error = status.error || `${format.toUpperCase()} extraction failed`;
        // Never feed compressed DMG container bytes into string extraction (produces binary/protobuf garbage).
        rawFiles = format === 'dmg' ? [] : [{ path: filename, buffer, size: buffer.length }];
      }
    } else {
      rawFiles = [{ path: filename, buffer, size: buffer.length }];
    }

    if (rawFiles.length === 0 && !isAsar(buffer) && format !== 'binary' && format !== 'dmg') {
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
      const depthMatches = (f.path.match(/\.(?:asar|zip|tar|tgz|gz|nupkg|hfs)/gi) || []).length;
      const isNestedAsar = f.path.endsWith('.asar') || (f.buffer && isAsar(f.buffer));
      const isNestedHfs = RAW_DISK_IMAGE_REGEX.test(path.basename(f.path)) && sevenZipCmd;

      if (isNestedAsar && depthMatches <= MAX_ARCHIVE_DEPTH) {
        try {
          const asarBuf = f.buffer || (f.fullPath ? fs.readFileSync(f.fullPath) : null);
          const asarFiles = extractAsar(asarBuf);
          status.analyzers.asar = 'completed';
          for (const af of asarFiles) {
            af.path = `${f.path}/${af.path}`;
            af.priority = getFilePriority(af.path, af.buffer);
            extractedFiles.push(af);
          }
          status.discoveredFiles += asarFiles.length;

          const unpackedPrefix = f.path.replace(/\.asar$/, '.asar.unpacked/');
          for (const [upath, ufile] of unpackedFilesMap.entries()) {
            if (upath.startsWith(unpackedPrefix) && !extractedFiles.some((ef) => ef.path === ufile.path)) {
              ufile.priority = getFilePriority(ufile.path, ufile.buffer);
              extractedFiles.push(ufile);
            }
          }
        } catch {
          status.failedFiles++;
          status.analyzers.asar = 'failed';
          f.priority = 2;
          extractedFiles.push(f);
        }
      } else if (isNestedHfs && depthMatches <= MAX_ARCHIVE_DEPTH) {
        const hfsBuf = f.buffer || (f.fullPath ? fs.readFileSync(f.fullPath) : null);
        if (!hfsBuf) continue;
        try {
          const hfsRes = extractWithSevenZip(hfsBuf, path.basename(f.path), sevenZipCmd, options);
          if (hfsRes.success && hfsRes.files.length > 0) {
            if (hfsRes.tmpDir) tempDirsToCleanup.push(hfsRes.tmpDir);
            for (const hf of hfsRes.files) {
              hf.path = `${f.path}/${hf.path}`;
              if (hf.path.endsWith('.asar') || (hf.buffer && isAsar(hf.buffer))) {
                try {
                  const nestedAsarBuf = hf.buffer || (hf.fullPath ? fs.readFileSync(hf.fullPath) : null);
                  const nestedAsar = extractAsar(nestedAsarBuf);
                  status.analyzers.asar = 'completed';
                  for (const naf of nestedAsar) {
                    naf.path = `${hf.path}/${naf.path}`;
                    naf.priority = getFilePriority(naf.path, naf.buffer);
                    extractedFiles.push(naf);
                  }
                  status.discoveredFiles += nestedAsar.length;
                } catch {
                  extractedFiles.push(hf);
                }
              } else {
                hf.priority = getFilePriority(hf.path, hf.buffer);
                extractedFiles.push(hf);
              }
            }
            status.discoveredFiles += hfsRes.files.length;
          } else {
            f.priority = getFilePriority(f.path, f.buffer);
            extractedFiles.push(f);
          }
        } catch {
          f.priority = getFilePriority(f.path, f.buffer);
          extractedFiles.push(f);
        }
      } else {
        f.priority = getFilePriority(f.path, f.buffer);
        extractedFiles.push(f);
      }
    }

    const uniqueFiles = new Map();
    for (const file of extractedFiles) {
      const len = file.size ?? file.buffer?.length ?? 0;
      const key = `${file.path}:${len}`;
      if (!uniqueFiles.has(key)) uniqueFiles.set(key, file);
    }
    extractedFiles.length = 0;
    extractedFiles.push(...uniqueFiles.values());

    status.analyzedFiles = extractedFiles.length;

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

    extractedFiles.push({
      path: `raw-fallback-${target}`,
      buffer,
      priority: 2,
      isFallback: true,
    });
  }

  return { files: extractedFiles, status, cleanup };
}
