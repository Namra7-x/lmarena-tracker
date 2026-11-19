/**
 * Claude Model Catalog Extractor
 * Fetches and normalizes Anthropic's official model catalog JSON.
 */

import { CLAUDE_CONFIG } from './config.mjs';

/**
 * Fetches the live catalog JSON from the given URL with graceful fallback.
 */
export async function fetchClaudeCatalog(primaryUrl = CLAUDE_CONFIG.endpoint) {
  const urls = [primaryUrl, CLAUDE_CONFIG.fallbackEndpoint].filter(Boolean);
  let lastErr = null;

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: {
          Accept: 'application/json, text/plain, */*',
          'User-Agent': CLAUDE_CONFIG.userAgent,
        },
        signal: AbortSignal.timeout(CLAUDE_CONFIG.timeout),
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} from ${url}`);
      }

      const data = await res.json();
      return { raw: data, resolvedUrl: url };
    } catch (err) {
      lastErr = err;
    }
  }

  throw new Error(`Failed to fetch Claude model catalog: ${lastErr?.message}`);
}

/**
 * Normalizes and aggregates raw catalog JSON into a clean, queryable structure.
 */
export function extractCatalogData(rawCatalog) {
  if (!rawCatalog || typeof rawCatalog !== 'object') {
    throw new Error('Invalid raw catalog payload: expected object');
  }

  const version = typeof rawCatalog.version === 'number' ? rawCatalog.version : null;
  const issuedAt = rawCatalog.issued_at || null;
  const expiresAt = rawCatalog.expires_at || null;
  const keyId = rawCatalog.key_id || null;
  const schemaVersion = rawCatalog.schema_version || 1;

  const surfaces = rawCatalog.surfaces && typeof rawCatalog.surfaces === 'object'
    ? Object.keys(rawCatalog.surfaces)
    : [];

  const surfaceDefaults = {};
  const surfaceThinkingDefaults = {};
  const modelsMap = new Map();
  let providerAliases = {};

  for (const surfaceName of surfaces) {
    const surfaceObj = rawCatalog.surfaces[surfaceName];
    if (!surfaceObj || typeof surfaceObj !== 'object') continue;

    // 1. Surface Defaults (model_selector_state)
    if (Array.isArray(surfaceObj.model_selector_state) && surfaceObj.model_selector_state.length > 0) {
      const firstState = surfaceObj.model_selector_state[0];
      if (firstState.model) {
        surfaceDefaults[surfaceName] = firstState.model;
      }
      if (firstState.thinking) {
        surfaceThinkingDefaults[surfaceName] = firstState.thinking;
      }
    }

    // 2. Model configs (model_selector_config)
    const configs = surfaceObj.model_selector_config;
    if (configs && typeof configs === 'object') {
      for (const cfg of Object.values(configs)) {
        if (!cfg || typeof cfg !== 'object') continue;

        // Capture provider alias targets if present
        if (cfg.provider_alias_targets && Object.keys(providerAliases).length === 0) {
          providerAliases = JSON.parse(JSON.stringify(cfg.provider_alias_targets));
        }

        // Process models list
        if (Array.isArray(cfg.models)) {
          for (const m of cfg.models) {
            if (!m || typeof m !== 'object' || !m.id) continue;

            const existing = modelsMap.get(m.id);
            if (!existing) {
              const entry = {
                id: m.id,
                name: m.name || m.short_name || m.id,
                shortName: m.short_name || null,
                description: m.description || null,
                family: m.runtime?.family || null,
                section: m.section || 'main',
                disabled: Boolean(m.disabled),
                disabledReason: m.disabled_reason || null,
                earlyAccess: Boolean(m.early_access),
                confidential: Boolean(m.confidential),
                voiceModel: m.voice_model || null,
                hardLimit: m.hard_limit || null,
                minClaudeCodeVersion: m.min_claude_code_version || null,
                maxInputTokens: typeof m.runtime?.max_input_tokens === 'number' ? m.runtime.max_input_tokens : null,
                maxOutputTokens: typeof m.runtime?.max_output_tokens === 'number' ? m.runtime.max_output_tokens : null,
                effortLevels: Array.isArray(m.runtime?.effort_levels)
                  ? [...m.runtime.effort_levels]
                  : Array.isArray(m.thinking?.effort_options)
                  ? m.thinking.effort_options.map((o) => o.id)
                  : [],
                defaultEffort: m.runtime?.default_effort || null,
                capabilities: Array.isArray(m.runtime?.capabilities)
                  ? [...m.runtime.capabilities]
                  : m.capabilities && typeof m.capabilities === 'object'
                  ? Object.keys(m.capabilities).filter((k) => m.capabilities[k])
                  : [],
                fastMode: Boolean(m.fast_mode || m.supports_fast_mode),
                offeredOn: Array.isArray(m.offered_on) ? [...m.offered_on] : [],
                surfaces: [surfaceName],
                rawSpecs: {
                  id: m.id,
                  name: m.name,
                  family: m.runtime?.family || null,
                  max_input_tokens: m.runtime?.max_input_tokens || null,
                  max_output_tokens: m.runtime?.max_output_tokens || null,
                  effort_levels: m.runtime?.effort_levels || null,
                  min_claude_code_version: m.min_claude_code_version || null,
                  offered_on: m.offered_on || null,
                },
              };
              modelsMap.set(m.id, entry);
            } else {
              // Merge additional surface information into existing model entry
              if (!existing.surfaces.includes(surfaceName)) {
                existing.surfaces.push(surfaceName);
              }
              if (!existing.family && m.runtime?.family) {
                existing.family = m.runtime.family;
              }
              if (existing.maxInputTokens === null && typeof m.runtime?.max_input_tokens === 'number') {
                existing.maxInputTokens = m.runtime.max_input_tokens;
              }
              if (existing.maxOutputTokens === null && typeof m.runtime?.max_output_tokens === 'number') {
                existing.maxOutputTokens = m.runtime.max_output_tokens;
              }
              if (!existing.minClaudeCodeVersion && m.min_claude_code_version) {
                existing.minClaudeCodeVersion = m.min_claude_code_version;
              }
              if (!existing.voiceModel && m.voice_model) {
                existing.voiceModel = m.voice_model;
              }
              if (m.disabled) existing.disabled = true;
              if (m.early_access) existing.earlyAccess = true;
              if (m.confidential) existing.confidential = true;
              if (Array.isArray(m.offered_on) && m.offered_on.length > existing.offeredOn.length) {
                existing.offeredOn = [...m.offered_on];
              }
              if (Array.isArray(m.runtime?.effort_levels) && m.runtime.effort_levels.length > existing.effortLevels.length) {
                existing.effortLevels = [...m.runtime.effort_levels];
              }
              if (m.capabilities && typeof m.capabilities === 'object') {
                for (const cap of Object.keys(m.capabilities)) {
                  if (m.capabilities[cap] && !existing.capabilities.includes(cap)) {
                    existing.capabilities.push(cap);
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  // Sort model IDs alphabetically for deterministic comparisons
  const sortedModels = Array.from(modelsMap.values()).sort((a, b) => a.id.localeCompare(b.id));

  return {
    version,
    issuedAt,
    expiresAt,
    keyId,
    schemaVersion,
    surfaces,
    surfaceDefaults,
    surfaceThinkingDefaults,
    providerAliases,
    models: sortedModels,
    modelsById: Object.fromEntries(sortedModels.map((m) => [m.id, m])),
    totalModels: sortedModels.length,
  };
}
