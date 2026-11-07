/**
 * Application URL & Route Extractor
 * Discovers and categorizes all genuine public URLs, remote API routes,
 * model catalog endpoints, and auto-update feeds across binaries and source archives.
 * Strictly purges local file paths, schema XMLs, package manager URLs, and binary noise.
 */

// XML namespaces, standards, and static documentation hosts that are NOT app routes
const NOISE_HOST_DOMAINS = new Set([
  'w3.org',
  'whatwg.org',
  'ietf.org',
  'ecma-international.org',
  'schemas.microsoft.com',
  'schemas.openxmlformats.org',
  'schema.org',
  'xmlpull.org',
  'oasis-open.org',
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  'github.com',
  'gitlab.com',
  'npmjs.org',
  'npmjs.com',
  'registry.npmjs.org',
  'crates.io',
  'rust-lang.org',
  'pypi.org',
  'apache.org',
  'mozilla.org',
  'en.wikipedia.org',
  'wikipedia.org',
  'reactjs.org',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'twitter.com',
  'x.com',
  'unicode.org',
  'iso.org',
  'khronos.org',
  'apple.com',
]);

// Static assets and binary extensions that are not API endpoints
const STATIC_ASSET_EXTENSIONS = /\.(?:png|jpg|jpeg|gif|svg|ico|webp|woff|woff2|ttf|eot|css|map|dylib|dll|so|obj|o|node)$/i;

// Regex for full HTTP/HTTPS/WSS URLs
const FULL_URL_REGEX = /\b(?:https?|wss?):\/\/[a-zA-Z0-9][-a-zA-Z0-9_.]*\.[a-zA-Z]{2,}(?::[0-9]+)?(?:\/[a-zA-Z0-9_.~!*';:@&=+$,/?%#\-\[\]]*)?/gi;

// Regex for root relative API routes (e.g., "/v1/models", "/model-catalogue/v1/catalog.json")
const RELATIVE_ROUTE_REGEX = /(?:^|[\"'`\s\(\[\{])(\/(?:api|v[0-9]+|v[0-9]+[a-z]+|model-catalogue|models|catalog|catalogue|updates?|releases?|rpc|graphql|internal|staging|preview|canary|dogfood|config|features?|experiments?)\/[a-zA-Z0-9_.~!*';:@&=+$,/?%#\-\[\]]+)/gi;

/**
 * Clean trailing punctuation, delimiters, and escaped slashes from raw URL.
 */
export function cleanAndValidateUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;

  let cleaned = rawUrl
    .trim()
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\\//g, '/');

  // Strip leading quotes or brackets
  cleaned = cleaned.replace(/^['"`\(\[\{]+/, '');

  // Strip trailing punctuation and quotes (e.g. "https://api.com/v1',")
  cleaned = cleaned.replace(/['"`\(\)\[\]\{\};,<>]+$/, '');

  // Strip trailing periods or commas
  cleaned = cleaned.replace(/[\.,]+$/, '');

  if (cleaned.length < 5 || cleaned.length > 500) return null;

  // Reject unprintable characters or control bytes
  if (/[\x00-\x1F\x7F-\x9F\uFFFD\s]/.test(cleaned)) return null;

  // Reject static assets
  if (STATIC_ASSET_EXTENSIONS.test(cleaned.split('?')[0])) return null;

  // Validate host for full URLs
  if (/^(?:https?|wss?):\/\//i.test(cleaned)) {
    try {
      const parsed = new URL(cleaned);
      const host = parsed.hostname.toLowerCase();
      for (const d of NOISE_HOST_DOMAINS) {
        if (host === d || host.endsWith('.' + d)) return null;
      }
      if (host.endsWith('.github.io')) return null;
      if (/^\d+\.\d+\.\d+\.\d+$/.test(host) && (host.startsWith('127.') || host.startsWith('10.') || host.startsWith('192.168.'))) {
        return null;
      }
      return cleaned;
    } catch {
      return null;
    }
  }

  // Validate relative route
  if (cleaned.startsWith('/')) {
    // Must have at least two segments: /namespace/endpoint
    const parts = cleaned.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    // Reject local file paths that happen to start with /
    if (/^\/(?:Users|home|var|etc|usr|tmp|opt|node_modules|dist|build|src|out)\//i.test(cleaned)) {
      return null;
    }
    return cleaned;
  }

  return null;
}

/**
 * Categorize a validated URL into structured operational categories.
 */
export function categorizeUrl(url) {
  const lower = url.toLowerCase();

  // 1. Catalog & Auto-Update feeds (Highest Signal)
  if (
    lower.includes('model-catalogue') ||
    lower.includes('model-catalog') ||
    lower.includes('catalog.json') ||
    lower.includes('catalogue.json') ||
    lower.includes('appcast.xml') ||
    lower.includes('latest.yml') ||
    lower.includes('latest-mac.yml') ||
    lower.includes('releases') ||
    lower.includes('downloads.claude.ai') ||
    lower.includes('persistent.oaistatic.com/sidecar') ||
    lower.includes('cursor.com/api/download') ||
    lower.includes('download_specs')
  ) {
    return 'CATALOG_AND_UPDATES';
  }

  // 2. Model & AI Inference APIs
  if (
    lower.includes('/models') ||
    lower.includes('/v1/models') ||
    lower.includes('/chat/completions') ||
    lower.includes('/completion') ||
    lower.includes('/messages') ||
    lower.includes('anthropic.com/v1') ||
    lower.includes('api.openai.com/v1') ||
    lower.includes('generativelanguage.googleapis.com') ||
    lower.includes('devin.ai/v1') ||
    lower.includes('cursor.sh/api') ||
    lower.includes('reasoning')
  ) {
    return 'MODEL_AND_AI_APIS';
  }

  // 3. Internal, Staging & Preview Endpoints
  if (
    lower.includes('.internal.') ||
    lower.includes('.staging.') ||
    lower.includes('.canary.') ||
    lower.includes('.dogfood.') ||
    lower.includes('.preview.') ||
    lower.includes('/internal/') ||
    lower.includes('/staging/') ||
    lower.includes('/preview/') ||
    lower.includes('/dogfood/')
  ) {
    return 'INTERNAL_AND_STAGING';
  }

  // 4. Remote Feature Flag & Configuration Endpoints
  if (
    lower.includes('statsig') ||
    lower.includes('launchdarkly') ||
    lower.includes('featuregates') ||
    lower.includes('remote-config') ||
    lower.includes('config_specs') ||
    lower.includes('/experiments') ||
    lower.includes('/feature_flags')
  ) {
    return 'REMOTE_CONFIG_AND_FLAGS';
  }

  // 5. Storage & CDN Distribution Buckets
  if (
    lower.includes('storage.googleapis.com') ||
    lower.includes('s3.amazonaws.com') ||
    lower.includes('.oaistatic.com') ||
    lower.includes('.blob.core.windows.net') ||
    lower.includes('.cloudfront.net')
  ) {
    return 'STORAGE_AND_CDN';
  }

  // 6. Generic Backend Service RPCs
  return 'SERVICE_AND_RPCS';
}

/**
 * Extract all unique, validated, and categorized URLs from text or buffer content.
 */
export function extractApplicationUrls(content) {
  if (!content) return [];

  const text = Buffer.isBuffer(content) ? content.toString('latin1') : String(content);
  const foundUrls = new Map();

  // 1. Scan for full URLs (http://, https://, ws://, wss://)
  FULL_URL_REGEX.lastIndex = 0;
  let match;
  while ((match = FULL_URL_REGEX.exec(text)) !== null) {
    const valid = cleanAndValidateUrl(match[0]);
    if (valid && !foundUrls.has(valid)) {
      foundUrls.set(valid, {
        url: valid,
        category: categorizeUrl(valid),
        isRelative: false,
      });
    }
  }

  // 2. Scan for relative API routes
  RELATIVE_ROUTE_REGEX.lastIndex = 0;
  while ((match = RELATIVE_ROUTE_REGEX.exec(text)) !== null) {
    const valid = cleanAndValidateUrl(match[1]);
    if (valid && !foundUrls.has(valid)) {
      foundUrls.set(valid, {
        url: valid,
        category: categorizeUrl(valid),
        isRelative: true,
      });
    }
  }

  return Array.from(foundUrls.values());
}
