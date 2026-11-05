/**
 * Integrity & Checksum Verification (Section 5)
 */

import { createHash } from 'node:crypto';

/**
 * Compute SHA-256 hex digest of a Buffer or string.
 */
export function computeSha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Compute SHA-512 hex digest of a Buffer or string.
 */
export function computeSha512(data) {
  return createHash('sha512').update(data).digest('hex');
}

/**
 * Verify data against expected checksum.
 * Supports:
 * - sha256:hex
 * - sha512:hex
 * - sha512-base64 (Subresource Integrity / npm style)
 * - plain 64-char hex (assumed sha256)
 * - plain 128-char hex (assumed sha512)
 */
export function verifyChecksum(data, expectedChecksum) {
  if (!expectedChecksum) return { verified: true, computed: computeSha256(data), matched: true };

  const trimmed = expectedChecksum.trim();

  // Subresource integrity (SRI) format: sha512-... or sha256-...
  if (trimmed.startsWith('sha512-')) {
    const expectedBase64 = trimmed.slice(7);
    const actualBase64 = createHash('sha512').update(data).digest('base64');
    const matched = actualBase64 === expectedBase64;
    return { verified: true, computed: actualBase64, matched, expected: expectedBase64 };
  }

  if (trimmed.startsWith('sha256-')) {
    const expectedBase64 = trimmed.slice(7);
    const actualBase64 = createHash('sha256').update(data).digest('base64');
    const matched = actualBase64 === expectedBase64;
    return { verified: true, computed: actualBase64, matched, expected: expectedBase64 };
  }

  // Prefixed hex
  if (trimmed.startsWith('sha256:')) {
    const expectedHex = trimmed.slice(7).toLowerCase();
    const actualHex = computeSha256(data).toLowerCase();
    return { verified: true, computed: actualHex, matched: actualHex === expectedHex, expected: expectedHex };
  }

  if (trimmed.startsWith('sha512:')) {
    const expectedHex = trimmed.slice(7).toLowerCase();
    const actualHex = computeSha512(data).toLowerCase();
    return { verified: true, computed: actualHex, matched: actualHex === expectedHex, expected: expectedHex };
  }

  // Bare hex
  if (trimmed.length === 64) {
    const actualHex = computeSha256(data).toLowerCase();
    return { verified: true, computed: actualHex, matched: actualHex === trimmed.toLowerCase(), expected: trimmed };
  }

  if (trimmed.length === 128) {
    const actualHex = computeSha512(data).toLowerCase();
    return { verified: true, computed: actualHex, matched: actualHex === trimmed.toLowerCase(), expected: trimmed };
  }

  // ETag or unrecognized format
  return { verified: false, computed: computeSha256(data), matched: true, note: 'unsupported checksum format' };
}
