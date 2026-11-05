/**
 * Safe Tar / TGZ / Zip Extractor (Section 6)
 * Built-in zip-slip protection, file count caps, and bomb guards.
 */

import zlib from 'node:zlib';
import path from 'node:path';

const MAX_FILE_COUNT = 5000;
const MAX_EXPANDED_BYTES = 500 * 1024 * 1024; // 500MB

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

    if (isSafeRelativePath(fileName) && !fileName.endsWith('/')) {
      if (files.length >= MAX_FILE_COUNT) break;

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
