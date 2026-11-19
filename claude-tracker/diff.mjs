/**
 * Claude Model Catalog Diff Engine
 * Detects catalog version increments, new models, removed models, spec upgrades,
 * surface default changes, and provider alias changes.
 */

/**
 * Computes deep structural diff between previous snapshot and current catalog data.
 */
export function computeCatalogDiff(current, previous = null) {
  if (!previous || typeof previous !== 'object') {
    return {
      isFirstRun: true,
      hasChanges: false,
      versionChanged: false,
      previousVersion: null,
      currentVersion: current.version,
      newModels: [],
      removedModels: [],
      specChanges: [],
      surfaceDefaultChanges: [],
      aliasTargetChanges: [],
      summaryText: `Initial baseline calibrated with ${current.totalModels} models at catalog v${current.version}.`,
    };
  }

  const previousVersion = previous.version || null;
  const currentVersion = current.version || null;
  const versionChanged = previousVersion !== null && currentVersion !== null && previousVersion !== currentVersion;

  const prevModelsMap = previous.modelsById || (Array.isArray(previous.models)
    ? Object.fromEntries(previous.models.map((m) => [m.id, m]))
    : {});

  const currModelsMap = current.modelsById || {};

  // 1. Detect New Models
  const newModels = [];
  for (const [id, model] of Object.entries(currModelsMap)) {
    if (!prevModelsMap[id]) {
      newModels.push(model);
    }
  }

  // 2. Detect Removed Models
  const removedModels = [];
  for (const [id, model] of Object.entries(prevModelsMap)) {
    if (!currModelsMap[id]) {
      removedModels.push(model);
    }
  }

  // 3. Detect Spec Upgrades and Property Changes
  const specChanges = [];
  for (const [id, currModel] of Object.entries(currModelsMap)) {
    const prevModel = prevModelsMap[id];
    if (!prevModel) continue;

    const changes = [];

    // Context Window: Output tokens
    if (currModel.maxOutputTokens && prevModel.maxOutputTokens && currModel.maxOutputTokens !== prevModel.maxOutputTokens) {
      changes.push(`Max output tokens changed: ${prevModel.maxOutputTokens.toLocaleString()} → ${currModel.maxOutputTokens.toLocaleString()}`);
    } else if (currModel.maxOutputTokens && !prevModel.maxOutputTokens) {
      changes.push(`Max output tokens defined: ${currModel.maxOutputTokens.toLocaleString()}`);
    }

    // Context Window: Input tokens
    if (currModel.maxInputTokens && prevModel.maxInputTokens && currModel.maxInputTokens !== prevModel.maxInputTokens) {
      changes.push(`Max input tokens changed: ${prevModel.maxInputTokens.toLocaleString()} → ${currModel.maxInputTokens.toLocaleString()}`);
    } else if (currModel.maxInputTokens && !prevModel.maxInputTokens) {
      changes.push(`Max input tokens defined: ${currModel.maxInputTokens.toLocaleString()}`);
    }

    // Thinking Effort Levels
    const prevEfforts = new Set(prevModel.effortLevels || []);
    const addedEfforts = (currModel.effortLevels || []).filter((e) => !prevEfforts.has(e));
    if (addedEfforts.length > 0) {
      changes.push(`New effort levels added: ${addedEfforts.join(', ')}`);
    }

    // Capabilities
    const prevCaps = new Set(prevModel.capabilities || []);
    const addedCaps = (currModel.capabilities || []).filter((c) => !prevCaps.has(c));
    if (addedCaps.length > 0) {
      changes.push(`New capabilities enabled: ${addedCaps.join(', ')}`);
    }

    // Surfaces
    const prevSurfs = new Set(prevModel.surfaces || []);
    const addedSurfs = (currModel.surfaces || []).filter((s) => !prevSurfs.has(s));
    if (addedSurfs.length > 0) {
      changes.push(`Deployed to new surface(s): ${addedSurfs.join(', ')}`);
    }

    // Cloud Providers (offered_on)
    const prevProviders = new Set(prevModel.offeredOn || []);
    const addedProviders = (currModel.offeredOn || []).filter((p) => !prevProviders.has(p));
    if (addedProviders.length > 0) {
      changes.push(`Offered on new cloud provider(s): ${addedProviders.join(', ')}`);
    }

    // Disabled status
    if (currModel.disabled !== Boolean(prevModel.disabled)) {
      changes.push(`Status changed: ${prevModel.disabled ? 'Disabled' : 'Active'} → ${currModel.disabled ? 'Disabled' : 'Active'}`);
    }

    // Early access or confidential
    if (currModel.earlyAccess !== Boolean(prevModel.earlyAccess)) {
      changes.push(`Early access flag: ${prevModel.earlyAccess} → ${currModel.earlyAccess}`);
    }
    if (currModel.confidential !== Boolean(prevModel.confidential)) {
      changes.push(`Confidential flag: ${prevModel.confidential} → ${currModel.confidential}`);
    }

    // Minimum Claude Code Version
    if (currModel.minClaudeCodeVersion && currModel.minClaudeCodeVersion !== prevModel.minClaudeCodeVersion) {
      changes.push(`Min Claude Code version: ${prevModel.minClaudeCodeVersion || 'None'} → ${currModel.minClaudeCodeVersion}`);
    }

    if (changes.length > 0) {
      specChanges.push({
        id,
        name: currModel.name,
        changes,
      });
    }
  }

  // 4. Detect Surface Default Model Changes
  const surfaceDefaultChanges = [];
  const allSurfaces = Array.from(new Set([
    ...Object.keys(current.surfaceDefaults || {}),
    ...Object.keys(previous.surfaceDefaults || {}),
  ]));

  for (const s of allSurfaces) {
    const prevDef = previous.surfaceDefaults?.[s] || null;
    const currDef = current.surfaceDefaults?.[s] || null;
    if (prevDef && currDef && prevDef !== currDef) {
      surfaceDefaultChanges.push({
        surface: s,
        previous: prevDef,
        current: currDef,
      });
    }
  }

  // 5. Detect Provider Alias Target Changes
  const aliasTargetChanges = [];
  const prevAliases = previous.providerAliases || {};
  const currAliases = current.providerAliases || {};
  const allAliasKeys = Array.from(new Set([...Object.keys(currAliases), ...Object.keys(prevAliases)]));

  for (const alias of allAliasKeys) {
    const prevA = prevAliases[alias] || {};
    const currA = currAliases[alias] || {};

    if (prevA.default && currA.default && prevA.default !== currA.default) {
      aliasTargetChanges.push({
        alias,
        provider: 'default',
        previous: prevA.default,
        current: currA.default,
      });
    }

    const allProviders = Array.from(new Set([
      ...Object.keys(prevA.per_provider || {}),
      ...Object.keys(currA.per_provider || {}),
    ]));

    for (const prov of allProviders) {
      const prevTarget = prevA.per_provider?.[prov];
      const currTarget = currA.per_provider?.[prov];
      if (prevTarget && currTarget && prevTarget !== currTarget) {
        aliasTargetChanges.push({
          alias,
          provider: prov,
          previous: prevTarget,
          current: currTarget,
        });
      }
    }
  }

  // Alert trigger condition: substantive model, spec, surface default, or provider alias changes ONLY.
  // Version bumps alone (e.g. 5410 -> 5411) without model changes are completely suppressed to eliminate noise.
  const hasChanges =
    newModels.length > 0 ||
    removedModels.length > 0 ||
    specChanges.length > 0 ||
    surfaceDefaultChanges.length > 0 ||
    aliasTargetChanges.length > 0;

  return {
    isFirstRun: false,
    hasChanges,
    versionChanged,
    previousVersion,
    currentVersion,
    newModels,
    removedModels,
    specChanges,
    surfaceDefaultChanges,
    aliasTargetChanges,
    totalModels: current.totalModels,
  };
}
