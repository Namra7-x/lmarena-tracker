/**
 * Read-Only Electron ASAR Parser (Section 6)
 * Pure native JavaScript implementation. No external binaries required.
 */

import { isSafeRelativePath } from './archive.mjs';

/**
 * Extract files from an Electron ASAR Buffer.
 * Returns an array of { path, buffer, size }.
 */
export function extractAsar(buffer) {
  if (!buffer || buffer.length < 16) {
    throw new Error('Invalid ASAR archive: buffer too small');
  }

  // Header structure:
  // 0..3: UInt32LE (size header, usually 4)
  // 4..7: UInt32LE (header size + 8)
  // 8..11: UInt32LE (header size + 4)
  // 12..15: UInt32LE (header JSON length)
  const headerSize = buffer.readUInt32LE(12);
  const headerStart = 16;
  const headerEnd = headerStart + headerSize;

  if (headerEnd > buffer.length) {
    throw new Error('Invalid ASAR archive: header extends beyond buffer');
  }

  const headerJsonStr = buffer.subarray(headerStart, headerEnd).toString('utf8');
  let header;
  try {
    header = JSON.parse(headerJsonStr);
  } catch (err) {
    throw new Error(`Invalid ASAR JSON header: ${err.message}`);
  }

  const payloadBaseOffset = headerEnd;
  const files = [];

  function traverse(dirNode, currentPath) {
    if (!dirNode || !dirNode.files) return;

    for (const [name, node] of Object.entries(dirNode.files)) {
      const filePath = currentPath ? `${currentPath}/${name}` : name;

      if (node.files) {
        // Subdirectory
        traverse(node, filePath);
      } else if (typeof node.size === 'number' && typeof node.offset === 'string') {
        // File
        if (isSafeRelativePath(filePath)) {
          const fileOffset = parseInt(node.offset, 10);
          const start = payloadBaseOffset + fileOffset;
          const end = start + node.size;

          if (end <= buffer.length) {
            files.push({
              path: filePath,
              buffer: buffer.subarray(start, end),
              size: node.size,
            });
          }
        }
      }
    }
  }

  traverse(header, '');
  return files;
}

/**
 * Check if a buffer appears to be an Electron ASAR archive.
 */
export function isAsar(buffer) {
  if (!buffer || buffer.length < 16) return false;
  try {
    const magic = buffer.readUInt32LE(0);
    const headerSize = buffer.readUInt32LE(12);
    return magic === 4 && headerSize > 0 && 16 + headerSize <= buffer.length;
  } catch {
    return false;
  }
}
