/**
 * Read-Only Electron ASAR Parser (Section 6)
 * Validates complete Chromium Pickle header, sizes, offsets, and directory structures.
 */

import { isSafeRelativePath } from './archive.mjs';

/**
 * Validates the complete 8-byte Pickle header and JSON bounds of an ASAR archive.
 * Returns { valid: boolean, headerSize, jsonLen, payloadBaseOffset, reason }
 */
export function validateAsarHeader(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length < 16) {
    return { valid: false, reason: 'Buffer too small for ASAR pickle header (< 16 bytes)' };
  }

  // 1. First 4 bytes must be Chromium Pickle payload size (always 4)
  const magic = buffer.readUInt32LE(0);
  if (magic !== 4) {
    return { valid: false, reason: `Invalid pickle payload magic: expected 4, got ${magic}` };
  }

  // 2. Bytes 4..7: Pickle header size (length of header pickle data in bytes)
  const pickleHeaderSize = buffer.readUInt32LE(4);
  // 3. Bytes 8..11: Pickle object size
  const pickleObjSize = buffer.readUInt32LE(8);
  // 4. Bytes 12..15: Length of JSON header UTF-8 string
  const jsonLen = buffer.readUInt32LE(12);

  if (pickleHeaderSize === 0 || pickleObjSize === 0 || jsonLen === 0) {
    return { valid: false, reason: 'Pickle header size or JSON length is 0' };
  }

  // Validate Pickle internal consistency
  if (pickleHeaderSize < pickleObjSize || pickleObjSize < jsonLen) {
    return { valid: false, reason: 'Pickle size mismatch: header < objSize or objSize < jsonLen' };
  }

  const headerStart = 16;
  const headerEnd = headerStart + jsonLen;

  // Header bounds check
  if (headerEnd > buffer.length) {
    return { valid: false, reason: `ASAR header extends beyond buffer (${headerEnd} > ${buffer.length})` };
  }

  // 5. Pickle padding consistency: payloadBaseOffset must not exceed 8 + pickleHeaderSize
  if (headerEnd > 8 + pickleHeaderSize + 8) {
    return { valid: false, reason: 'JSON header exceeds Pickle envelope size' };
  }

  // 6. Fast byte check: JSON must begin with '{' (0x7B) and end with '}' (0x7D)
  if (buffer[headerStart] !== 0x7B || buffer[headerEnd - 1] !== 0x7D) {
    return { valid: false, reason: 'Header payload is not a JSON object (missing { or })' };
  }

  return {
    valid: true,
    pickleHeaderSize,
    pickleObjSize,
    jsonLen,
    headerStart,
    headerEnd,
    payloadBaseOffset: headerEnd,
  };
}

/**
 * Check if a buffer appears to be a genuine Electron ASAR archive.
 * Performs complete 8-byte Pickle validation and verifies valid JSON with a `files` root.
 */
export function isAsar(buffer) {
  const check = validateAsarHeader(buffer);
  if (!check.valid) return false;

  try {
    const jsonStr = buffer.subarray(check.headerStart, check.headerEnd).toString('utf8');
    const parsed = JSON.parse(jsonStr);
    return typeof parsed === 'object' && parsed !== null && typeof parsed.files === 'object' && parsed.files !== null;
  } catch {
    return false;
  }
}

/**
 * Extract files from an Electron ASAR Buffer.
 * Returns an array of { path, buffer, size, unpacked }.
 */
export function extractAsar(buffer, options = {}) {
  const check = validateAsarHeader(buffer);
  if (!check.valid) {
    throw new Error(`Invalid ASAR archive: ${check.reason}`);
  }

  const headerJsonStr = buffer.subarray(check.headerStart, check.headerEnd).toString('utf8');
  let header;
  try {
    header = JSON.parse(headerJsonStr);
  } catch (err) {
    throw new Error(`Invalid ASAR JSON header: ${err.message}`);
  }

  if (typeof header !== 'object' || header === null || typeof header.files !== 'object') {
    throw new Error('Invalid ASAR archive: header missing files dictionary');
  }

  const payloadBaseOffset = check.payloadBaseOffset;
  const files = [];
  const maxFiles = options.maxFiles || 20000;
  let totalExtractedBytes = 0;
  const maxBytes = options.maxBytes || 1024 * 1024 * 1024; // 1 GB cap

  function traverse(dirNode, currentPath) {
    if (!dirNode || !dirNode.files || files.length >= maxFiles) return;

    for (const [name, node] of Object.entries(dirNode.files)) {
      if (files.length >= maxFiles) break;
      const filePath = currentPath ? `${currentPath}/${name}` : name;

      if (node.files) {
        // Subdirectory
        traverse(node, filePath);
      } else if (typeof node.size === 'number' && node.size >= 0) {
        // File entry
        if (!isSafeRelativePath(filePath)) continue;

        const isUnpacked = Boolean(node.unpacked);
        let fileBuffer = Buffer.alloc(0);

        if (!isUnpacked && typeof node.offset === 'string') {
          const fileOffset = parseInt(node.offset, 10);
          if (Number.isFinite(fileOffset) && fileOffset >= 0) {
            const start = payloadBaseOffset + fileOffset;
            const end = start + node.size;

            // Strict bounds and overflow validation
            if (start >= payloadBaseOffset && end >= start && end <= buffer.length) {
              if (totalExtractedBytes + node.size > maxBytes) {
                throw new Error(`ASAR extraction exceeds total size limit (${maxBytes} bytes)`);
              }
              fileBuffer = buffer.subarray(start, end);
              totalExtractedBytes += node.size;
            }
          }
        }

        files.push({
          path: filePath,
          buffer: fileBuffer,
          size: node.size,
          unpacked: isUnpacked,
        });
      }
    }
  }

  traverse(header, '');
  return files;
}
