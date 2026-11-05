/**
 * Source Discovery Dispatcher
 * Maps each component ID to its authoritative fetcher.
 */

import { fetchCodexCli, fetchCodexDesktop } from './openai.mjs';
import { fetchClaudeCode, fetchClaudeDesktop } from './anthropic.mjs';
import { fetchGeminiDesktop, fetchAntigravityDesktop, fetchAntigravityCli } from './google.mjs';
import { fetchCursorDesktop, fetchCursorCli } from './cursor.mjs';
import { fetchDevinDesktop, fetchDevinCli } from './devin.mjs';
import { fetchOpenCodeCli, fetchDroidCli } from './other.mjs';

export const FETCHERS = {
  'codex-cli': fetchCodexCli,
  'codex-desktop': fetchCodexDesktop,
  'claude-code': fetchClaudeCode,
  'claude-desktop': fetchClaudeDesktop,
  'gemini-desktop': fetchGeminiDesktop,
  'antigravity-desktop': fetchAntigravityDesktop,
  'antigravity-cli': fetchAntigravityCli,
  'cursor-desktop': fetchCursorDesktop,
  'cursor-cli': fetchCursorCli,
  'devin-desktop': fetchDevinDesktop,
  'devin-cli': fetchDevinCli,
  'opencode-cli': fetchOpenCodeCli,
  'droid-cli': fetchDroidCli,
};

/**
 * Fetch candidate release data for a component.
 */
export async function discoverComponent(componentId) {
  const fetcher = FETCHERS[componentId];
  if (!fetcher) {
    throw new Error(`Unknown component ID '${componentId}'`);
  }
  return await fetcher();
}

/**
 * Fetch all components in a family.
 */
export async function discoverFamily(familyId) {
  const { FAMILIES } = await import('../registry/components.mjs');
  const family = FAMILIES[familyId];
  if (!family) throw new Error(`Unknown family ID '${familyId}'`);

  const results = {};
  await Promise.all(
    family.components.map(async (compId) => {
      try {
        results[compId] = await discoverComponent(compId);
      } catch (err) {
        results[compId] = { error: err.message, componentId: compId };
      }
    })
  );
  return results;
}
