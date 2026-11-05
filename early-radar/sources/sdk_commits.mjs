/**
 * GitHub SDK Model Enum Commits Source Adapter
 * Tracks ground-truth commits to model enums in openai-python and anthropic-sdk-typescript.
 * ZERO HARDCODED MODEL NAMES: dynamically parses any added string literal from diffs.
 */

import { RADAR_CONFIG } from '../config.mjs';

/**
 * Dynamically extracts string literals from git diff additions without hardcoding any model names.
 */
export function extractModelIdentifiersFromDiff(patch) {
  if (!patch) return [];

  const additions = patch
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1).trim())
    .filter((l) => l.length > 0 && !l.startsWith('//') && !l.startsWith('#'));

  const extracted = new Set();
  const ignoredKeywords = new Set([
    'type', 'export', 'import', 'true', 'false', 'null', 'undefined',
    'default', 'from', 'as', 'const', 'let', 'var', 'string', 'literal'
  ]);

  for (const line of additions) {
    // Dynamically match any quoted string literal: "any-model-name" or 'any-model-name'
    const matches = line.matchAll(/['"]([a-zA-Z0-9_\-\.\:\/]+)['"]/g);
    for (const m of matches) {
      const val = m[1].trim();
      if (val.length > 2 && !ignoredKeywords.has(val.toLowerCase())) {
        extracted.add(val);
      }
    }
  }

  return Array.from(extracted);
}

/**
 * Fetches the latest commit on a specific file in a GitHub repo.
 */
export async function fetchLatestSdkCommit(repo, filePath, token = null) {
  const url = `https://api.github.com/repos/${repo}/commits?path=${encodeURIComponent(filePath)}&per_page=1`;
  const headers = {
    'User-Agent': RADAR_CONFIG.userAgent,
    Accept: 'application/vnd.github.v3+json',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(RADAR_CONFIG.timeouts.fetch),
  });

  if (!res.ok) {
    throw new Error(`GitHub API returned HTTP ${res.status} for ${repo}:${filePath}`);
  }

  const commits = await res.json();
  if (!Array.isArray(commits) || commits.length === 0) {
    return null;
  }

  const c = commits[0];
  const sha = c.sha;
  const shortSha = sha.slice(0, 7);
  const message = c.commit?.message?.split('\n')[0] || '';
  const author = c.commit?.author?.name || c.author?.login || 'unknown';
  const timestamp = c.commit?.author?.date || c.commit?.committer?.date;
  const commitUrl = c.html_url;

  return {
    repo,
    filePath,
    sha,
    shortSha,
    message,
    author,
    timestamp,
    commitUrl,
  };
}

/**
 * Fetches the commit diff and dynamically extracts added model names.
 */
export async function fetchCommitModelDiff(repo, sha, filePath, token = null) {
  const url = `https://api.github.com/repos/${repo}/commits/${sha}`;
  const headers = {
    'User-Agent': RADAR_CONFIG.userAgent,
    Accept: 'application/vnd.github.v3+json',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  try {
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(RADAR_CONFIG.timeouts.fetch),
    });

    if (!res.ok) return [];

    const data = await res.json();
    const targetFile = data.files?.find((f) => f.filename === filePath);
    if (!targetFile || !targetFile.patch) return [];

    return extractModelIdentifiersFromDiff(targetFile.patch);
  } catch {
    return [];
  }
}
