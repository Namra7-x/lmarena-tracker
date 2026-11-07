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

// Standard W3C CSS Properties (negative universe barrier against CSS properties leaking as models/flags)
export const W3C_CSS_PROPERTIES = new Set([
  'accent-color', 'align-content', 'align-items', 'align-self', 'all', 'animation', 'animation-delay',
  'animation-direction', 'animation-duration', 'animation-fill-mode', 'animation-iteration-count',
  'animation-name', 'animation-play-state', 'animation-timing-function', 'aspect-ratio', 'backdrop-filter',
  'backface-visibility', 'background', 'background-attachment', 'background-blend-mode', 'background-clip',
  'background-color', 'background-image', 'background-origin', 'background-position', 'background-position-x',
  'background-position-y', 'background-repeat', 'background-size', 'block-size', 'border', 'border-block',
  'border-block-color', 'border-block-end', 'border-block-end-color', 'border-block-end-style', 'border-block-end-width',
  'border-block-start', 'border-block-start-color', 'border-block-start-style', 'border-block-start-width',
  'border-block-style', 'border-block-width', 'border-bottom', 'border-bottom-color', 'border-bottom-left-radius',
  'border-bottom-right-radius', 'border-bottom-style', 'border-bottom-width', 'border-collapse', 'border-color',
  'border-end-end-radius', 'border-end-start-radius', 'border-image', 'border-image-outset', 'border-image-repeat',
  'border-image-slice', 'border-image-source', 'border-image-width', 'border-inline', 'border-inline-color',
  'border-inline-end', 'border-inline-end-color', 'border-inline-end-style', 'border-inline-end-width',
  'border-inline-start', 'border-inline-start-color', 'border-inline-start-style', 'border-inline-start-width',
  'border-inline-style', 'border-inline-width', 'border-left', 'border-left-color', 'border-left-style',
  'border-left-width', 'border-radius', 'border-right', 'border-right-color', 'border-right-style',
  'border-right-width', 'border-spacing', 'border-start-end-radius', 'border-start-start-radius', 'border-style',
  'border-top', 'border-top-color', 'border-top-left-radius', 'border-top-right-radius', 'border-top-style',
  'border-top-width', 'border-width', 'bottom', 'box-decoration-break', 'box-shadow', 'box-sizing',
  'break-after', 'break-before', 'break-inside', 'caption-side', 'caret-color', 'clear', 'clip', 'clip-path',
  'color', 'color-scheme', 'column-count', 'column-fill', 'column-gap', 'column-rule', 'column-rule-color',
  'column-rule-style', 'column-rule-width', 'column-span', 'column-width', 'columns', 'contain',
  'contain-intrinsic-size', 'content', 'content-visibility', 'counter-increment', 'counter-reset', 'counter-set',
  'cursor', 'direction', 'display', 'empty-cells', 'filter', 'flex', 'flex-basis', 'flex-direction',
  'flex-flow', 'flex-grow', 'flex-shrink', 'flex-wrap', 'float', 'font', 'font-family', 'font-feature-settings',
  'font-kerning', 'font-language-override', 'font-optical-sizing', 'font-palette', 'font-size', 'font-size-adjust',
  'font-stretch', 'font-style', 'font-synthesis', 'font-variant', 'font-variant-alternates', 'font-variant-caps',
  'font-variant-east-asian', 'font-variant-ligatures', 'font-variant-numeric', 'font-variant-position',
  'font-variation-settings', 'font-weight', 'forced-color-adjust', 'gap', 'grid', 'grid-area', 'grid-auto-columns',
  'grid-auto-flow', 'grid-auto-rows', 'grid-column', 'grid-column-end', 'grid-column-gap', 'grid-column-start',
  'grid-gap', 'grid-row', 'grid-row-end', 'grid-row-gap', 'grid-row-start', 'grid-template', 'grid-template-areas',
  'grid-template-columns', 'grid-template-rows', 'hanging-punctuation', 'height', 'hyphenate-character',
  'hyphens', 'image-orientation', 'image-rendering', 'image-resolution', 'ime-mode', 'initial-letter',
  'initial-letter-align', 'inline-size', 'inset', 'inset-block', 'inset-block-end', 'inset-block-start',
  'inset-inline', 'inset-inline-end', 'inset-inline-start', 'isolation', 'justify-content', 'justify-items',
  'justify-self', 'left', 'letter-spacing', 'line-break', 'line-height', 'line-height-step', 'list-style',
  'list-style-image', 'list-style-position', 'list-style-type', 'margin', 'margin-block', 'margin-block-end',
  'margin-block-start', 'margin-bottom', 'margin-inline', 'margin-inline-end', 'margin-inline-start',
  'margin-left', 'margin-right', 'margin-top', 'margin-trim', 'mask', 'mask-border', 'mask-border-mode',
  'mask-border-outset', 'mask-border-repeat', 'mask-border-slice', 'mask-border-source', 'mask-border-width',
  'mask-clip', 'mask-composite', 'mask-image', 'mask-mode', 'mask-origin', 'mask-position', 'mask-repeat',
  'mask-size', 'mask-type', 'max-block-size', 'max-height', 'max-inline-size', 'max-width', 'min-block-size',
  'min-height', 'min-inline-size', 'min-width', 'mix-blend-mode', 'object-fit', 'object-position', 'offset',
  'offset-anchor', 'offset-distance', 'offset-path', 'offset-position', 'offset-rotate', 'opacity', 'order',
  'orphans', 'outline', 'outline-color', 'outline-offset', 'outline-style', 'outline-width', 'overflow',
  'overflow-anchor', 'overflow-block', 'overflow-clip-margin', 'overflow-inline', 'overflow-wrap', 'overflow-x',
  'overflow-y', 'overscroll-behavior', 'overscroll-behavior-block', 'overscroll-behavior-inline',
  'overscroll-behavior-x', 'overscroll-behavior-y', 'padding', 'padding-block', 'padding-block-end',
  'padding-block-start', 'padding-bottom', 'padding-inline', 'padding-inline-end', 'padding-inline-start',
  'padding-left', 'padding-right', 'padding-top', 'page-break-after', 'page-break-before', 'page-break-inside',
  'paint-order', 'perspective', 'perspective-origin', 'place-content', 'place-items', 'place-self',
  'pointer-events', 'position', 'print-color-adjust', 'quotes', 'resize', 'right', 'rotate', 'row-gap',
  'ruby-align', 'ruby-position', 'scale', 'scroll-behavior', 'scroll-margin', 'scroll-margin-block',
  'scroll-margin-block-end', 'scroll-margin-block-start', 'scroll-margin-bottom', 'scroll-margin-inline',
  'scroll-margin-inline-end', 'scroll-margin-inline-start', 'scroll-margin-left', 'scroll-margin-right',
  'scroll-margin-top', 'scroll-padding', 'scroll-padding-block', 'scroll-padding-block-end',
  'scroll-padding-block-start', 'scroll-padding-bottom', 'scroll-padding-inline', 'scroll-padding-inline-end',
  'scroll-padding-inline-start', 'scroll-padding-left', 'scroll-padding-right', 'scroll-padding-top',
  'scroll-snap-align', 'scroll-snap-stop', 'scroll-snap-type', 'scrollbar-color', 'scrollbar-gutter',
  'scrollbar-width', 'shape-image-threshold', 'shape-margin', 'shape-outside', 'tab-size', 'table-layout',
  'text-align', 'text-align-last', 'text-combine-upright', 'text-decoration', 'text-decoration-color',
  'text-decoration-line', 'text-decoration-skip-ink', 'text-decoration-style', 'text-decoration-thickness',
  'text-emphasis', 'text-emphasis-color', 'text-emphasis-position', 'text-emphasis-style', 'text-indent',
  'text-justify', 'text-orientation', 'text-overflow', 'text-rendering', 'text-shadow', 'text-size-adjust',
  'text-transform', 'text-underline-offset', 'text-underline-position', 'top', 'touch-action', 'transform',
  'transform-box', 'transform-origin', 'transform-style', 'transition', 'transition-delay', 'transition-duration',
  'transition-property', 'transition-timing-function', 'translate', 'unicode-bidi', 'user-select',
  'vertical-align', 'visibility', 'white-space', 'widows', 'width', 'will-change', 'word-break',
  'word-spacing', 'writing-mode', 'z-index'
]);

// SPDX Software License Identifiers
export const SPDX_LICENSES = new Set([
  'apache-1.0', 'apache-1.1', 'apache-2.0', 'mit', 'gpl-1.0', 'gpl-2.0', 'gpl-3.0',
  'lgpl-2.0', 'lgpl-2.1', 'lgpl-3.0', 'agpl-1.0', 'agpl-3.0', 'bsd-2-clause', 'bsd-3-clause',
  'bsd-4-clause', 'mpl-1.0', 'mpl-1.1', 'mpl-2.0', 'isc', 'unlicense', 'epl-1.0', 'epl-2.0',
  'cc0-1.0', 'cc-by-3.0', 'cc-by-4.0', 'cc-by-sa-3.0', 'cc-by-sa-4.0', 'artistic-2.0',
  'zlib', '0bsd', 'wtfpl'
]);

// Media, Font, Package & File Asset Extensions
export const MEDIA_FILE_REGEX = /\.(?:png|jpe?g|gif|svg|webp|ico|bmp|tiff|avif|mp3|wav|ogg|mp4|webm|woff2?|ttf|eot|otf|tar\.gz|tgz|zip|exe|dmg|pkg|deb|rpm|msi|lock|map|d\.ts)$/i;

// Standard UI Theme values that must not be classified as feature flags or models
export const COMMON_UI_THEMES = new Set([
  'dark', 'light', 'system', 'high-contrast', 'sepia', 'solarized', 'dracula', 'nord', 'monokai',
  'light-high-contrast', 'dark-high-contrast'
]);

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

  // 12. W3C CSS Properties, SPDX Licenses, and Media/Package Extensions
  const lower = trimmed.toLowerCase();
  if (W3C_CSS_PROPERTIES.has(lower)) return false;
  if (SPDX_LICENSES.has(lower)) return false;
  if (MEDIA_FILE_REGEX.test(trimmed)) return false;

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

  // 4b. W3C CSS Properties, SPDX Software Licenses, and Media/Archive Files
  if (W3C_CSS_PROPERTIES.has(lower)) {
    return { isNoise: true, reason: 'w3c_css_property' };
  }
  if (SPDX_LICENSES.has(lower)) {
    return { isNoise: true, reason: 'spdx_license' };
  }
  if (MEDIA_FILE_REGEX.test(trimmed)) {
    return { isNoise: true, reason: 'media_or_archive_extension' };
  }

  // 5. CSS / Tailwind / Hex color / SVG / Coordinates
  if (HEX_COLOR_REGEX.test(trimmed) || CSS_TAILWIND_REGEX.test(trimmed) || CSS_PROPERTY_REGEX.test(trimmed) || SVG_PATH_REGEX.test(trimmed)) {
    return { isNoise: true, reason: 'css_style_or_svg' };
  }
  if (/[0-9]+[hvlzsqta][0-9.-]/i.test(trimmed) || /^[0-9]+-[0-9.]+$/.test(trimmed)) {
    return { isNoise: true, reason: 'svg_coordinate' };
  }
  if (/^(?:o[1-9]|v[0-9]|col|row|flex|grid|p|m|px|py|bg|text|border|ring|shadow)-(?:card|btn|button|input|modal|badge|alert|text|bg|border|ring|muted|container|header|footer|row|col|flex|grid|icon|avatar|tooltip|switch|nav|sidebar|tab|label|select|checkbox|radio)/i.test(trimmed)) {
    return { isNoise: true, reason: 'css_component_class' };
  }

  // 5b. Date formats, calendar layouts, encodings, and cloud regions
  if (/^\d{2,4}[-_]\d{1,2}(?:[-_]\d{1,4})?$/.test(trimmed) || /^\d{1,2}[-_](?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(trimmed) || /^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[-_]\d+$/i.test(trimmed)) {
    return { isNoise: true, reason: 'date_layout' };
  }
  if (/^(?:utf|ucs|iso|windows|cp|koi8|ascii|ansi|ebcdic|shift[-_]jis|euc)[-_]/i.test(trimmed)) {
    return { isNoise: true, reason: 'encoding_standard' };
  }
  if (/^(?:us|eu|ap|sa|ca|me|af|cn|gov|asia)-(?:central|east|west|north|south|northeast|northwest|southeast|southwest)-\d+$/i.test(trimmed)) {
    return { isNoise: true, reason: 'cloud_region' };
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
