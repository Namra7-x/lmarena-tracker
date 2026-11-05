/**
 * Noise Control & Third-Party Attribution (Section 4.5)
 * Identifies boilerplate, UUIDs, build hashes, and third-party node_modules.
 */

// UUID v4 regex
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Hex hash regex (MD5, SHA1, SHA256)
const HASH_REGEX = /^[0-9a-f]{32,64}$/i;

// Timestamp / ISO string regex
const TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)?$/;

// Common JS/Webpack minified identifiers
const MINIFIED_REGEX = /^[a-zA-Z_$][a-zA-Z0-9_$]{0,2}$/;

/**
 * Check if a finding is attributed to a third-party dependency.
 */
export function isThirdPartyPath(filePath) {
  if (!filePath) return false;
  const lower = filePath.toLowerCase();
  return (
    lower.includes('node_modules') ||
    lower.includes('vendor/') ||
    lower.includes('third_party/') ||
    lower.includes('lib/extern') ||
    lower.includes('webpack/bootstrap')
  );
}

/**
 * Check if a string value looks like noise/junk.
 * Noise penalty is applied rather than hard deletion (Section 4.5).
 */
export function evaluateNoise(value) {
  if (!value || typeof value !== 'string') return { isNoise: true, reason: 'empty' };

  const trimmed = value.trim();

  if (UUID_REGEX.test(trimmed)) {
    return { isNoise: true, isHashOrUuid: true, reason: 'uuid' };
  }

  if (HASH_REGEX.test(trimmed)) {
    return { isNoise: true, isHashOrUuid: true, reason: 'hex_hash' };
  }

  if (TIMESTAMP_REGEX.test(trimmed)) {
    return { isNoise: true, reason: 'timestamp' };
  }

  if (MINIFIED_REGEX.test(trimmed)) {
    return { isNoise: true, isMinified: true, reason: 'minified_ident' };
  }

  // License headers boilerplate
  if (trimmed.includes('MIT License') || trimmed.includes('Apache License') || trimmed.includes('Copyright (c)')) {
    return { isNoise: true, reason: 'license' };
  }

  return { isNoise: false };
}
