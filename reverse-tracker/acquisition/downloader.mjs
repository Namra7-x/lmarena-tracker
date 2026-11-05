/**
 * Secure Downloader (Section 5)
 * Content-addressed dedup, allowlist enforcement, timeout & retry guards.
 */

import { assertUrlAllowed } from '../registry/allowlist.mjs';
import { verifyChecksum, computeSha256 } from './integrity.mjs';

const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_MAX_SIZE_BYTES = 1024 * 1024 * 1024; // 1GB
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// In-memory content-addressed cache (hash -> buffer)
const DEDUP_CACHE = new Map();

/**
 * Download an artifact with security, verification, and dedup.
 *
 * @param {Object} artifact { url, checksum, checksumUrl, target }
 * @param {Object} options { timeoutMs, maxSizeBytes, maxRetries }
 * @returns {Promise<Object>} { buffer, sha256, size, target, url, cached }
 */
export async function downloadArtifact(artifact, options = {}) {
  const { url, checksum, checksumUrl, target } = artifact;
  assertUrlAllowed(url);
  if (checksumUrl) assertUrlAllowed(checksumUrl);

  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const maxSizeBytes = options.maxSizeBytes || DEFAULT_MAX_SIZE_BYTES;
  const maxRetries = options.maxRetries || 3;

  // If a separate checksumUrl is provided (like Factory .sha256), fetch it first
  let expectedChecksum = checksum;
  if (!expectedChecksum && checksumUrl) {
    try {
      const cRes = await fetch(checksumUrl, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(10000),
      });
      if (cRes.ok) {
        const text = await cRes.text();
        expectedChecksum = text.trim().split(/\s+/)[0];
      }
    } catch (e) {
      // Continue if checksum url fails transiently
    }
  }

  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) {
        // Fast fail on client error (404, 403)
        if (res.status >= 400 && res.status < 500) {
          throw new Error(`HTTP ${res.status} client error downloading ${url}`);
        }
        throw new Error(`HTTP ${res.status} server error downloading ${url}`);
      }

      // Check Content-Length header against max size
      const cl = res.headers.get('content-length');
      if (cl && parseInt(cl, 10) > maxSizeBytes) {
        throw new Error(`Artifact exceeds max size limit: ${cl} > ${maxSizeBytes} bytes`);
      }

      const arrayBuffer = await res.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      if (buffer.length > maxSizeBytes) {
        throw new Error(`Downloaded bytes exceed max limit: ${buffer.length} > ${maxSizeBytes}`);
      }

      const sha256 = computeSha256(buffer);

      // Verify checksum if available
      if (expectedChecksum) {
        const check = verifyChecksum(buffer, expectedChecksum);
        if (!check.matched) {
          throw new Error(`Checksum mismatch! Expected: ${check.expected}, Got: ${check.computed}`);
        }
      }

      // Dedup check: if we already processed these exact bytes, mark as cached
      const isCached = DEDUP_CACHE.has(sha256);
      if (!isCached) {
        DEDUP_CACHE.set(sha256, buffer);
      }

      return {
        buffer,
        sha256,
        size: buffer.length,
        target,
        url,
        cached: isCached,
        verified: Boolean(expectedChecksum),
      };
    } catch (err) {
      lastError = err;
      if (err.message.includes('client error') || err.message.includes('Checksum mismatch')) {
        // Do not retry permanent errors
        break;
      }
      if (attempt < maxRetries) {
        const backoff = 1000 * Math.pow(2, attempt - 1) + Math.random() * 500;
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }

  throw new Error(`Failed to download ${url}: ${lastError?.message}`);
}
