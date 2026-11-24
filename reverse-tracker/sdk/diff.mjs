/**
 * Official SDK Differ & Report Formatter
 * Compares SDK extraction state between versions and generates clean summaries & full diff files.
 */

/**
 * Calculates diffs between previous SDK version state and newly reversed state.
 */
export function computeSdkDiff(pkgName, newVersion, newReversed, prevSnapshotPkg = null) {
  const prevModels = new Set(prevSnapshotPkg?.models || []);
  const prevBetas = new Set(prevSnapshotPkg?.betaHeaders || []);
  const prevEfforts = new Set(prevSnapshotPkg?.reasoningEfforts || []);
  const prevTiers = new Set(prevSnapshotPkg?.serviceTiers || []);
  const prevTools = new Set(prevSnapshotPkg?.toolDefinitions || []);
  const prevParams = new Set(prevSnapshotPkg?.requestParams || []);
  const prevEndpoints = new Set(prevSnapshotPkg?.apiEndpoints || []);

  const addedModels = (newReversed.models || []).filter((m) => !prevModels.has(m));
  const removedModels = Array.from(prevModels).filter((m) => !(newReversed.models || []).includes(m));

  const addedBetaHeaders = (newReversed.betaHeaders || []).filter((b) => !prevBetas.has(b));
  const removedBetaHeaders = Array.from(prevBetas).filter((b) => !(newReversed.betaHeaders || []).includes(b));

  const addedEfforts = (newReversed.reasoningEfforts || []).filter((e) => !prevEfforts.has(e));
  const addedServiceTiers = (newReversed.serviceTiers || []).filter((s) => !prevTiers.has(s));
  const addedTools = (newReversed.toolDefinitions || []).filter((t) => !prevTools.has(t));
  const addedRequestParams = (newReversed.requestParams || []).filter((p) => !prevParams.has(p));
  const addedEndpoints = (newReversed.apiEndpoints || []).filter((e) => !prevEndpoints.has(e));

  const isFirstBaseline = !prevSnapshotPkg;
  const isVersionBump = prevSnapshotPkg && prevSnapshotPkg.version !== newVersion;
  const hasChanges =
    isFirstBaseline ||
    isVersionBump ||
    addedModels.length > 0 ||
    removedModels.length > 0 ||
    addedBetaHeaders.length > 0 ||
    addedServiceTiers.length > 0 ||
    addedTools.length > 0 ||
    addedRequestParams.length > 0 ||
    addedEndpoints.length > 0;

  return {
    packageName: pkgName,
    oldVersion: prevSnapshotPkg?.version || null,
    newVersion,
    isFirstBaseline,
    hasChanges,
    addedModels,
    removedModels,
    addedBetaHeaders,
    removedBetaHeaders,
    addedEfforts,
    addedServiceTiers,
    addedTools,
    addedRequestParams,
    addedEndpoints,
    totalModels: (newReversed.models || []).length,
    totalBetaHeaders: (newReversed.betaHeaders || []).length,
    totalEndpoints: (newReversed.apiEndpoints || []).length,
    currentSnapshot: {
      version: newVersion,
      models: newReversed.models || [],
      betaHeaders: newReversed.betaHeaders || [],
      reasoningEfforts: newReversed.reasoningEfforts || [],
      serviceTiers: newReversed.serviceTiers || [],
      toolDefinitions: newReversed.toolDefinitions || [],
      requestParams: newReversed.requestParams || [],
      apiEndpoints: newReversed.apiEndpoints || [],
      lastUpdated: new Date().toISOString(),
    },
  };
}

/**
 * Formats a clean executive summary message for Telegram (strictly capped under 3,500 characters).
 */
export function formatSdkTelegramSummary(diff, labDisplayName = '', distTag = 'latest') {
  const tagBadge = distTag && distTag !== 'latest' ? ` [${distTag.toUpperCase()} PRE-RELEASE]` : '';
  const lines = [
    `📦 <b>Official SDK Release &amp; Deep Reverse${tagBadge}</b>`,
    `🏷️ <b>Package:</b> <code>${diff.packageName}</code> (v${diff.newVersion})`,
  ];

  if (diff.oldVersion) {
    lines.push(`🔄 <b>Version Bump:</b> <code>${diff.oldVersion}</code> ➔ <code>${diff.newVersion}</code>`);
  }
  if (labDisplayName) {
    lines.push(`🏢 <b>Lab:</b> ${labDisplayName}`);
  }
  lines.push('');

  if (diff.addedModels.length > 0) {
    lines.push(`🆕 <b>Newly Added Models (${diff.addedModels.length}):</b>`);
    for (const m of diff.addedModels.slice(0, 15)) {
      lines.push(`• <code>${m}</code>`);
    }
    if (diff.addedModels.length > 15) {
      lines.push(`<i>...and ${diff.addedModels.length - 15} more in attached diff</i>`);
    }
    lines.push('');
  }

  if (diff.addedEndpoints && diff.addedEndpoints.length > 0) {
    lines.push(`🌐 <b>New API Endpoints (${diff.addedEndpoints.length}):</b>`);
    for (const ep of diff.addedEndpoints.slice(0, 10)) {
      lines.push(`• <code>${ep}</code>`);
    }
    if (diff.addedEndpoints.length > 10) {
      lines.push(`<i>...and ${diff.addedEndpoints.length - 10} more in attached diff</i>`);
    }
    lines.push('');
  }

  if (diff.addedBetaHeaders.length > 0) {
    lines.push(`⚡ <b>New Beta Headers &amp; Feature Flags (${diff.addedBetaHeaders.length}):</b>`);
    for (const b of diff.addedBetaHeaders.slice(0, 12)) {
      lines.push(`• <code>${b}</code>`);
    }
    if (diff.addedBetaHeaders.length > 12) {
      lines.push(`<i>...and ${diff.addedBetaHeaders.length - 12} more in attached diff</i>`);
    }
    lines.push('');
  }

  if (diff.addedRequestParams && diff.addedRequestParams.length > 0) {
    lines.push(`⚙️ <b>New Request Parameters (${diff.addedRequestParams.length}):</b>`);
    for (const p of diff.addedRequestParams.slice(0, 10)) {
      lines.push(`• <code>${p}</code>`);
    }
    lines.push('');
  }

  if (diff.addedServiceTiers && diff.addedServiceTiers.length > 0) {
    lines.push(`🚀 <b>New Service Tiers:</b> <code>${diff.addedServiceTiers.join(', ')}</code>\n`);
  }

  if (diff.addedEfforts && diff.addedEfforts.length > 0) {
    lines.push(`🧠 <b>Reasoning Effort Levels:</b> <code>${diff.addedEfforts.join(', ')}</code>\n`);
  }

  if (diff.addedTools && diff.addedTools.length > 0) {
    lines.push(`🛠️ <b>New Tool Schemas (${diff.addedTools.length}):</b>`);
    for (const t of diff.addedTools.slice(0, 8)) {
      lines.push(`• <code>${t}</code>`);
    }
    lines.push('');
  }

  if (diff.removedModels.length > 0) {
    lines.push(`❌ <b>Removed / Deprecated Models (${diff.removedModels.length}):</b>`);
    for (const m of diff.removedModels.slice(0, 5)) {
      lines.push(`• <code>${m}</code>`);
    }
    lines.push('');
  }

  lines.push(`📎 <i>Detailed technical type diff attached as document below.</i>`);
  lines.push(`🔗 <a href="https://www.npmjs.com/package/${diff.packageName}">NPM Package Link</a>`);

  return lines.join('\n');
}

/**
 * Formats full technical diff document content to attach as a file.
 */
export function formatSdkDiffDocument(diff) {
  const sep = '='.repeat(70);
  const subSep = '-'.repeat(70);
  const now = new Date().toISOString();

  const lines = [
    sep,
    `OFFICIAL SDK DEEP REVERSE DIFF REPORT`,
    sep,
    `Package:         ${diff.packageName}`,
    `Previous Ver:    ${diff.oldVersion || 'Initial Baseline'}`,
    `Current Ver:     ${diff.newVersion}`,
    `Generated At:    ${now}`,
    sep,
    '',
    `[1] NEWLY ADDED MODEL ENUMS (${diff.addedModels.length})`,
    subSep,
  ];

  if (diff.addedModels.length > 0) {
    diff.addedModels.forEach((m) => lines.push(`+ ${m}`));
  } else {
    lines.push('  None');
  }

  lines.push('');
  lines.push(`[2] NEW API ENDPOINTS & ROUTES (${(diff.addedEndpoints || []).length})`);
  lines.push(subSep);
  if (diff.addedEndpoints?.length > 0) {
    diff.addedEndpoints.forEach((e) => lines.push(`+ ${e}`));
  } else {
    lines.push('  None');
  }

  lines.push('');
  lines.push(`[3] NEW BETA HEADERS & GATES (${diff.addedBetaHeaders.length})`);
  lines.push(subSep);
  if (diff.addedBetaHeaders.length > 0) {
    diff.addedBetaHeaders.forEach((b) => lines.push(`+ ${b}`));
  } else {
    lines.push('  None');
  }

  lines.push('');
  lines.push(`[4] NEW REQUEST PARAMETERS & SERVICE TIERS (${(diff.addedRequestParams || []).length})`);
  lines.push(subSep);
  if (diff.addedRequestParams?.length > 0) {
    diff.addedRequestParams.forEach((p) => lines.push(`+ param: ${p}`));
  }
  if (diff.addedServiceTiers?.length > 0) {
    diff.addedServiceTiers.forEach((s) => lines.push(`+ tier: ${s}`));
  }
  if (!diff.addedRequestParams?.length && !diff.addedServiceTiers?.length) {
    lines.push('  None');
  }

  lines.push('');
  lines.push(`[5] CURRENT COMPLETE MODEL ENUM CATALOG (${diff.totalModels})`);
  lines.push(subSep);
  diff.currentSnapshot.models.forEach((m) => lines.push(`  • ${m}`));

  lines.push('');
  lines.push(`[6] CURRENT API ENDPOINTS CATALOG (${diff.totalEndpoints || 0})`);
  lines.push(subSep);
  (diff.currentSnapshot.apiEndpoints || []).forEach((e) => lines.push(`  • ${e}`));

  lines.push('');
  lines.push(`[7] CURRENT BETA HEADERS CATALOG (${diff.totalBetaHeaders})`);
  lines.push(subSep);
  diff.currentSnapshot.betaHeaders.forEach((b) => lines.push(`  • ${b}`));

  if (diff.currentSnapshot.reasoningEfforts.length > 0) {
    lines.push('');
    lines.push(`[8] REASONING EFFORT LEVELS`);
    lines.push(subSep);
    diff.currentSnapshot.reasoningEfforts.forEach((e) => lines.push(`  • ${e}`));
  }

  lines.push('');
  lines.push(sep);
  lines.push('END OF REPORT');
  lines.push(sep);

  return lines.join('\n');
}
