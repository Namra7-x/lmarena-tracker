/**
 * Advanced Noise Control & Signal Sieve
 * Purges hashes, base64 blobs, CSS/Tailwind classes, webpack boilerplates,
 * and standard third-party runtime noise using Shannon entropy and lexical heuristics.
 */

// UUID regex (standard v1-v5)
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Hex hash regex (MD5, SHA1, SHA256, Git SHA)
const HASH_REGEX = /^[0-9a-f]{32,64}$/i;

// ISO Timestamp
const TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)?$/;

// Minified 1-2 char identifier
const MINIFIED_IDENT_REGEX = /^[a-zA-Z_$][a-zA-Z0-9_$]{0,2}$/;

// CSS / Tailwind patterns
const CSS_TAILWIND_REGEX = /^(?:(?:hover|focus|active|disabled|dark|sm|md|lg|xl|2xl):)?(?:(?:bg|text|border|p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|grid|items|justify|w|h|min-w|min-h|max-w|max-h|rounded|shadow|z|opacity|cursor|font|leading|tracking|transition|duration|overflow)-[a-zA-Z0-9_#\-\/\[\]]+|flex|grid|block|inline|hidden|relative|absolute|fixed|sticky|truncate)$/;
const HEX_COLOR_REGEX = /^#[0-9a-fA-F]{3,8}$/;
const CSS_PROPERTY_REGEX = /^(?:display|margin|padding|color|background|font|border|width|height|position|opacity|visibility|z-index)\s*:/i;
const SVG_PATH_REGEX = /^M\d+[0-9.,\s-]*Z?$/i;

// Webpack / Bundler boilerplate tokens
const WEBPACK_BOILERPLATE = new Set([
  '__webpack_require__',
  '__esModule',
  '__webpack_exports__',
  'Object.defineProperty',
  'exports.__esModule',
  'use strict',
  'enumerable',
  'configurable',
  'writable',
  'prototype',
  'constructor',
  'toString',
  'valueOf',
]);

// Generic UI words that are not leaks
const GENERIC_UI_WORDS = new Set([
  'ok', 'cancel', 'submit', 'save', 'close', 'delete', 'edit', 'update',
  'confirm', 'yes', 'no', 'true', 'false', 'null', 'undefined', 'loading',
  'error', 'warning', 'info', 'success', 'search', 'filter', 'clear', 'done',
  'next', 'previous', 'back', 'help', 'settings', 'options', 'menu', 'default',
]);

// Standard web & DOM APIs
const STANDARD_WEB_APIS = new Set([
  'addEventListener', 'removeEventListener', 'preventDefault', 'stopPropagation',
  'querySelector', 'querySelectorAll', 'getElementById', 'getElementsByClassName',
  'createElement', 'appendChild', 'removeChild', 'setAttribute', 'getAttribute',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame',
  'JSON.parse', 'JSON.stringify', 'console.log', 'console.error', 'console.warn',
  'localStorage', 'sessionStorage', 'indexedDB', 'fetch', 'XMLHttpRequest',
]);

/**
 * Calculate Shannon Entropy: H = -sum(p * log2(p))
 * High entropy indicates random hashes, base64, or encrypted data.
 */
export function computeShannonEntropy(str) {
  if (!str || str.length === 0) return 0;
  const len = str.length;
  const frequencies = {};

  for (let i = 0; i < len; i++) {
    const char = str[i];
    frequencies[char] = (frequencies[char] || 0) + 1;
  }

  let entropy = 0;
  for (const char in frequencies) {
    const p = frequencies[char] / len;
    entropy -= p * Math.log2(p);
  }

  return entropy;
}

/**
 * Check if a file path belongs to third-party vendor code.
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
 * Evaluates whether a string is clean, printable, and genuinely human-readable.
 * Rejects binary garbage, control bytes, compiler symbols, high symbol noise, and CSS.
 */
export function isHumanReadableString(value) {
  if (!value || typeof value !== 'string') return false;

  const trimmed = value.trim();
  const len = trimmed.length;

  // 1. Length bounds: readable strings must be at least 4 chars and at most 1000 chars
  if (len < 4 || len > 1000) return false;

  // 2. Control characters & unprintable bytes: strictly rejected (\x00-\x1F, \x7F-\x9F, \uFFFD)
  if (/[\x00-\x1F\x7F-\x9F\uFFFD]/.test(trimmed)) return false;

  // 3. Must contain letters or digits
  if (!/[a-zA-Z0-9]/.test(trimmed)) return false;

  // 4. Alphanumeric density: at least 45% alphanumeric (or at least 3 letters/digits for short tokens)
  const alphanumericCount = (trimmed.match(/[a-zA-Z0-9]/g) || []).length;
  if (alphanumericCount < 3) return false;
  if (alphanumericCount / len < 0.45 && len >= 6) return false;

  // 5. Excessive repeated punctuation/symbols (e.g. "----", "////", "????", "@@@@", "****")
  if (/([^\w\s])\1{3,}/.test(trimmed)) return false;

  // 6. Compiler mangling & binary symbol noise
  if (/^(\?\?|\?_|\$|\.L|__imp_|__libc_|_ZTV|_ZTI|__gxx)/.test(trimmed)) return false;

  // 7. High entropy random hashes / base64 noise
  if (!trimmed.includes(' ') && len >= 24) {
    const entropy = computeShannonEntropy(trimmed);
    if (entropy > 4.65) return false;
  }

  // 8. UUIDs & raw hex hashes
  if (UUID_REGEX.test(trimmed) || HASH_REGEX.test(trimmed)) return false;

  // 9. CSS styles, colors, and SVG paths
  if (HEX_COLOR_REGEX.test(trimmed) || CSS_TAILWIND_REGEX.test(trimmed) || CSS_PROPERTY_REGEX.test(trimmed) || SVG_PATH_REGEX.test(trimmed)) {
    return false;
  }

  // 10. Multi-class CSS lists
  if (trimmed.includes(' ')) {
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    if (tokens.length >= 2 && tokens.every((t) => CSS_TAILWIND_REGEX.test(t) || HEX_COLOR_REGEX.test(t))) {
      return false;
    }
  }

  // 11. Webpack / Bundler boilerplate
  if (WEBPACK_BOILERPLATE.has(trimmed)) return false;

  return true;
}

/**
 * Comprehensive Noise Sieve.
 * Filters out hashes, UUIDs, CSS, Webpack boilerplate, and high-entropy noise.
 */
export function evaluateNoise(value) {
  if (!value || typeof value !== 'string') return { isNoise: true, reason: 'empty' };

  const trimmed = value.trim();
  const len = trimmed.length;

  // 1. Length bounds
  if (len < 3) {
    return { isNoise: true, isMinified: true, reason: 'too_short' };
  }
  if (len > 1000) {
    return { isNoise: true, reason: 'too_long' };
  }

  // 1b. Binary garbage rejection: reject unprintable chars, control bytes, or non-alphanumeric noise
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\uFFFD]/.test(trimmed)) {
    return { isNoise: true, reason: 'binary_non_printable' };
  }
  if (!/[a-zA-Z0-9]/.test(trimmed)) {
    return { isNoise: true, reason: 'no_alphanumeric' };
  }
  const alphanumericCount = (trimmed.match(/[a-zA-Z0-9]/g) || []).length;
  if (alphanumericCount / len < 0.40 && len >= 6) {
    return { isNoise: true, reason: 'high_symbol_density_binary_noise' };
  }

  // 2. Exact UUID / Hash
  if (UUID_REGEX.test(trimmed)) {
    return { isNoise: true, isHashOrUuid: true, reason: 'uuid' };
  }
  if (HASH_REGEX.test(trimmed)) {
    return { isNoise: true, isHashOrUuid: true, reason: 'hex_hash' };
  }
  if (TIMESTAMP_REGEX.test(trimmed)) {
    return { isNoise: true, reason: 'timestamp' };
  }
  if (MINIFIED_IDENT_REGEX.test(trimmed)) {
    return { isNoise: true, isMinified: true, reason: 'minified_ident' };
  }

  // 3. Webpack / Bundler boilerplate
  if (WEBPACK_BOILERPLATE.has(trimmed)) {
    return { isNoise: true, reason: 'webpack_boilerplate' };
  }

  // 4. Standard DOM and generic single words
  const lower = trimmed.toLowerCase();
  if (GENERIC_UI_WORDS.has(lower) || STANDARD_WEB_APIS.has(trimmed)) {
    return { isNoise: true, reason: 'standard_generic_word' };
  }

  // 5. CSS / Tailwind / Hex color / SVG
  if (HEX_COLOR_REGEX.test(trimmed) || CSS_TAILWIND_REGEX.test(trimmed) || CSS_PROPERTY_REGEX.test(trimmed) || SVG_PATH_REGEX.test(trimmed)) {
    return { isNoise: true, reason: 'css_style_or_svg' };
  }

  // Check multi-class Tailwind strings (e.g. "flex items-center px-4 bg-slate-900")
  if (trimmed.includes(' ')) {
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    if (tokens.length >= 2 && tokens.every((t) => CSS_TAILWIND_REGEX.test(t) || HEX_COLOR_REGEX.test(t))) {
      return { isNoise: true, reason: 'css_tailwind_class_list' };
    }
  }

  // 6. Base64 / Data URI
  if (trimmed.startsWith('data:image/') || trimmed.startsWith('data:font/') || trimmed.startsWith('data:application/')) {
    return { isNoise: true, reason: 'data_uri' };
  }

  // 7. Shannon Entropy Filter for random hashes / base64 strings
  // High character diversity with no spaces and length > 24 is almost always a hash or random token
  if (!trimmed.includes(' ') && len >= 24) {
    const entropy = computeShannonEntropy(trimmed);
    // Typical English/code strings have entropy between 2.5 and 4.2.
    // Random base64 and hashes have entropy > 4.7.
    if (entropy > 4.75) {
      return { isNoise: true, isHashOrUuid: true, reason: 'high_entropy_hash_or_base64' };
    }
  }

  // 8. License & Copyright boilerplate
  if (trimmed.includes('MIT License') || trimmed.includes('Apache License') || trimmed.includes('Copyright (c)')) {
    return { isNoise: true, reason: 'license' };
  }

  return { isNoise: false };
}
