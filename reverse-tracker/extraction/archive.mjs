/**
 * Safe Tar / TGZ / Zip Extractor (Section 6)
 * Built-in zip-slip protection, file count caps, and bomb guards.
 */

import zlib from 'node:zlib';
import path from 'node:path';

const MAX_FILE_COUNT = 10000;
const MAX_EXPANDED_BYTES = 1024 * 1024 * 1024; // 1GB safe expansion limit
const MAX_COMPRESSION_RATIO = 100; // Bomb guard: abort if uncompressed / compressed > 100

// Mach-O Universal & Single-arch signatures (including byte-swapped LE/BE)
export const MACHO_MAGICS = {
  MACHO_32_BE: 0xfeedface,
  MACHO_32_LE: 0xcefaedfe,
  MACHO_64_BE: 0xfeedfacf,
  MACHO_64_LE: 0xcffaedfe,
  FAT_32_BE: 0xcafebabe,
  FAT_32_LE: 0xbebafeca,
  FAT_64_BE: 0xcafebabf,
  FAT_64_LE: 0xbbfebeca,
};

/**
 * GZIP magic: 0x1F 0x8B
 */
export function isGzip(buffer) {
  return Boolean(buffer && buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b);
}

/**
 * Check if a GZIP buffer contains a POSIX tarball (inspects offset 257 for 'ustar').
 */
export function isTarGz(buffer) {
  if (!isGzip(buffer)) return false;
  try {
    const chunk = zlib.gunzipSync(buffer.subarray(0, Math.min(buffer.length, 65536)), { maxOutputLength: 65536 });
    if (chunk.length >= 512) {
      const ustar = chunk.subarray(257, 262).toString('ascii');
      return ustar === 'ustar';
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * ZIP magic: "PK\x03\x04" (0x04034b50 LE)
 */
export function isZip(buffer) {
  return Boolean(buffer && buffer.length >= 4 && buffer.readUInt32LE(0) === 0x04034b50);
}

/**
 * Windows PE Executable: "MZ" (0x4D, 0x5A)
 */
export function isPeExecutable(buffer) {
  return Boolean(buffer && buffer.length >= 2 && buffer[0] === 0x4d && buffer[1] === 0x5a);
}

/**
 * NSIS Installer check: Scans for 'NullsoftInst' signature inside PE.
 */
export function isNsisInstaller(buffer) {
  if (!isPeExecutable(buffer) || buffer.length < 1024) return false;
  const scanSlice = buffer.subarray(0, Math.min(buffer.length, 32768)).toString('latin1');
  return scanSlice.includes('NullsoftInst');
}

/**
 * Distinguish Java class files (0xCAFEBABE with minor/major version) from Mach-O universal fat binaries.
 */
export function isJavaClass(buffer) {
  if (!buffer || buffer.length < 8) return false;
  if (buffer.readUInt32BE(0) !== 0xcafebabe) return false;
  const majorVersion = buffer.readUInt16BE(6);
  const nfatArch = buffer.readUInt32BE(4);
  // Mach-O fat binary has nfat_arch between 1 and 32, followed by a valid CPU type at offset 8
  if (nfatArch >= 1 && nfatArch <= 32 && buffer.length >= 12) {
    const cputype = buffer.readUInt32BE(8);
    // Known CPU types: X86_64 (0x01000007), ARM64 (0x0100000c), I386 (7), ARM (12), PPC (18)
    if ([0x01000007, 0x0100000c, 7, 12, 18].includes(cputype)) {
      return false; // It is Mach-O!
    }
  }
  return majorVersion >= 45 && majorVersion <= 100;
}

/**
 * Mach-O detection supporting single-arch 32/64-bit, universal/fat binaries, and byte-swapped variants.
 */
export function isMachOBinary(buffer) {
  if (!buffer || buffer.length < 4) return false;
  const magicBE = buffer.readUInt32BE(0);
  if (magicBE === MACHO_MAGICS.MACHO_32_BE || magicBE === MACHO_MAGICS.MACHO_64_BE ||
      magicBE === MACHO_MAGICS.FAT_64_BE || magicBE === MACHO_MAGICS.FAT_64_LE ||
      magicBE === MACHO_MAGICS.FAT_32_LE) {
    return true;
  }
  const magicLE = buffer.readUInt32LE(0);
  if (magicLE === MACHO_MAGICS.MACHO_32_LE || magicLE === MACHO_MAGICS.MACHO_64_LE) {
    return true;
  }
  if (magicBE === MACHO_MAGICS.FAT_32_BE) {
    return !isJavaClass(buffer);
  }
  return false;
}

/**
 * Filter out pure media/font assets that do not contain leak signals to optimize memory.
 */
export function isIgnoredAsset(filePath) {
  if (!filePath) return false;
  const lower = filePath.toLowerCase();
  return lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg') ||
         lower.endsWith('.gif') || lower.endsWith('.ico') || lower.endsWith('.icns') ||
         lower.endsWith('.svg') || lower.endsWith('.ttf') || lower.endsWith('.woff') ||
         lower.endsWith('.woff2') || lower.endsWith('.eot') || lower.endsWith('.mp3') ||
         lower.endsWith('.wav') || lower.endsWith('.mp4') || lower.endsWith('.mov') ||
         lower.endsWith('.pdf') || lower.endsWith('.psd');
}

/**
 * Validate path against zip-slip vulnerabilities.
 */
export function isSafeRelativePath(relPath) {
  if (!relPath || typeof relPath !== 'string') return false;
  // Disallow leading slashes (POSIX absolute) or drive letters (Windows absolute)
  if (relPath.startsWith('/') || relPath.startsWith('\\') || /^[a-zA-Z]:[\\\/]/.test(relPath)) {
    return false;
  }
  const normalized = path.normalize(relPath);
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) return false;
  // Disallow hidden directory escapes
  const segments = normalized.split(/[\\\/]/);
  return !segments.includes('..');
}

/**
 * Extract files from a tar or .tar.gz / .tgz Buffer.
 * Returns an array of { path, buffer, size }.
 */
export function extractTar(buffer) {
  let tarBuf = buffer;

  // Check if gzipped (magic 0x1F 0x8B)
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    try {
      tarBuf = zlib.gunzipSync(buffer, { maxOutputLength: MAX_EXPANDED_BYTES });
      if (tarBuf.length / Math.max(buffer.length, 1) > MAX_COMPRESSION_RATIO && tarBuf.length > 50 * 1024 * 1024) {
        throw new Error(`Suspicious compression ratio (${(tarBuf.length / buffer.length).toFixed(1)}x) exceeds limit of ${MAX_COMPRESSION_RATIO}x`);
      }
    } catch (err) {
      throw new Error(`Failed to gunzip tarball: ${err.message}`);
    }
  }

  const files = [];
  let offset = 0;
  let totalBytes = 0;

  while (offset + 512 <= tarBuf.length) {
    const headerBlock = tarBuf.subarray(offset, offset + 512);

    // Two zero blocks signify end of archive
    if (headerBlock.every((b) => b === 0)) break;

    // Filename: bytes 0-100 (ASCII, null-terminated)
    const nameEnd = headerBlock.indexOf(0, 0);
    const rawName = headerBlock.subarray(0, nameEnd === -1 ? 100 : Math.min(nameEnd, 100)).toString('utf8').trim();

    // Size: bytes 124-136 (octal string)
    const sizeStr = headerBlock.subarray(124, 136).toString('ascii').trim().replace(/\0.*$/, '');
    const size = parseInt(sizeStr, 8) || 0;

    // Type flag: byte 156 ('0' or '\0' for normal file, '5' for directory)
    const typeFlag = String.fromCharCode(headerBlock[156]);

    offset += 512;

    if (rawName && (typeFlag === '0' || typeFlag === '\0')) {
      if (isIgnoredAsset(rawName)) {
        offset += Math.ceil(size / 512) * 512;
        continue;
      }

      if (!isSafeRelativePath(rawName)) {
        console.warn(`Skipping potentially unsafe path in tar: ${rawName}`);
        offset += Math.ceil(size / 512) * 512;
        continue;
      }

      if (files.length >= MAX_FILE_COUNT) {
        console.warn(`Max file count (${MAX_FILE_COUNT}) reached. Stopping tar extraction.`);
        break;
      }

      totalBytes += size;
      if (totalBytes > MAX_EXPANDED_BYTES) {
        throw new Error(`Tar extraction exceeded max safe expansion limit (${MAX_EXPANDED_BYTES} bytes).`);
      }

      const fileData = tarBuf.subarray(offset, offset + size);
      files.push({
        path: rawName,
        buffer: Buffer.from(fileData),
        size,
      });
    }

    offset += Math.ceil(size / 512) * 512;
  }

  return files;
}

/**
 * Extract files from a basic standard ZIP Buffer.
 * Reads central directory or local headers safely.
 */
export function extractZip(buffer) {
  const files = [];
  let offset = 0;
  let totalBytes = 0;

  // Scan local file headers: signature 0x04034b50 ("PK\x03\x04")
  while (offset + 30 <= buffer.length) {
    if (buffer.readUInt32LE(offset) !== 0x04034b50) {
      break;
    }

    const compressionMethod = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const uncompressedSize = buffer.readUInt32LE(offset + 22);
    const fileNameLength = buffer.readUInt16LE(offset + 26);
    const extraFieldLength = buffer.readUInt16LE(offset + 28);

    const fileNameStart = offset + 30;
    const fileName = buffer.subarray(fileNameStart, fileNameStart + fileNameLength).toString('utf8');

    const dataStart = fileNameStart + fileNameLength + extraFieldLength;
    const dataEnd = dataStart + compressedSize;

    if (dataEnd > buffer.length) break;

    if (isSafeRelativePath(fileName) && !fileName.endsWith('/') && !isIgnoredAsset(fileName)) {
      if (files.length >= MAX_FILE_COUNT) break;

      // Check compression ratio bomb guard for non-trivial file entries
      if (compressedSize > 0 && (uncompressedSize / compressedSize) > MAX_COMPRESSION_RATIO && uncompressedSize > 10 * 1024 * 1024) {
        console.warn(`Skipping zip bomb entry ${fileName}: compression ratio ${(uncompressedSize / compressedSize).toFixed(1)}x`);
        offset = dataEnd;
        continue;
      }

      totalBytes += uncompressedSize;
      if (totalBytes > MAX_EXPANDED_BYTES) {
        throw new Error(`Zip extraction exceeded max safe expansion limit (${MAX_EXPANDED_BYTES} bytes).`);
      }

      const compressedData = buffer.subarray(dataStart, dataEnd);
      let uncompressedData;

      if (compressionMethod === 0) {
        // Stored (no compression)
        uncompressedData = Buffer.from(compressedData);
      } else if (compressionMethod === 8) {
        // Deflated
        try {
          uncompressedData = zlib.inflateRawSync(compressedData, { maxOutputLength: MAX_EXPANDED_BYTES });
        } catch (err) {
          uncompressedData = null;
        }
      }

      if (uncompressedData) {
        files.push({
          path: fileName,
          buffer: uncompressedData,
          size: uncompressedData.length,
        });
      }
    }

    offset = dataEnd;
  }

  return files;
}
