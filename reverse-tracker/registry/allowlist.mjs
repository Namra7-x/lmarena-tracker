/**
 * Domain & Source Allowlist (Section 1.1)
 * Enforces strict domain and org boundaries. Rejects any untrusted host or aggregator.
 */

export const ALLOWED_DOMAINS = new Set([
  // npm
  'registry.npmjs.org',

  // GitHub
  'api.github.com',
  'raw.githubusercontent.com',
  'github.com',
  'objects.githubusercontent.com',

  // OpenAI
  'persistent.oaistatic.com',
  'learn.chatgpt.com',
  'openai.com',

  // Anthropic
  'downloads.claude.ai',
  'claude.ai',
  'claude.com',
  'anthropic.com',

  // Google
  'gemini.google',
  'antigravity.google',
  'dl.google.com',
  'storage.googleapis.com',
  'edgedl.me.gvt1.com',
  'antigravity-hub-auto-updater-974169037036.us-central1.run.app',
  'antigravity-cli-auto-updater-974169037036.us-central1.run.app',

  // Cursor
  'cursor.com',
  'downloads.cursor.com',
  'download.todesktop.com',

  // Devin / Windsurf
  'devin.ai',
  'cli.devin.ai',
  'static.devin.ai',
  'windsurf-stable.codeiumdata.com',
  'formulae.brew.sh',

  // Other (Factory / OpenCode)
  'app.factory.ai',
  'downloads.factory.ai',
  'opencode.ai',
]);

export const ALLOWED_GITHUB_ORGS = new Set([
  'openai',
  'anomalyco',
  'Homebrew',
]);

export const ALLOWED_NPM_PACKAGES = new Set([
  '@openai/codex',
  '@anthropic-ai/claude-code',
  '@opencode/cli',
  'droid',
]);

/**
 * Validate that a URL belongs to the official allowlist.
 * Throws an Error if the URL is not permitted.
 */
export function assertUrlAllowed(urlString) {
  try {
    const parsed = new URL(urlString);
    const hostname = parsed.hostname.toLowerCase();

    // Check exact domain or subdomain of allowed domains
    const isAllowedDomain = Array.from(ALLOWED_DOMAINS).some((domain) => {
      return hostname === domain || hostname.endsWith('.' + domain);
    });

    if (!isAllowedDomain) {
      throw new Error(`Domain '${hostname}' is not in the official allowlist.`);
    }

    // Specific check for GitHub repos
    if (hostname === 'api.github.com' && parsed.pathname.startsWith('/repos/')) {
      const parts = parsed.pathname.split('/').filter(Boolean);
      const org = parts[1];
      if (org && !ALLOWED_GITHUB_ORGS.has(org)) {
        throw new Error(`GitHub organization '${org}' is not in the official allowlist.`);
      }
    }

    return true;
  } catch (err) {
    throw new Error(`Source URL rejected: ${err.message}`);
  }
}

/**
 * Validate that an npm package name is allowlisted.
 */
export function assertNpmPackageAllowed(packageName) {
  if (!ALLOWED_NPM_PACKAGES.has(packageName)) {
    throw new Error(`npm package '${packageName}' is not in the official allowlist.`);
  }
  return true;
}
