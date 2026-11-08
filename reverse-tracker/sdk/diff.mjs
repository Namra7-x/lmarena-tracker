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
  const prevTools = new Set(prevSnapshotPkg?.toolDefinitions || []);

  const addedModels = (newReversed.models || []).filter((m) => !prevModels.has(m));
  const removedModels = Array.from(prevModels).filter((m) => !(newReversed.models || []).includes(m));

  const addedBetaHeaders = (newReversed.betaHeaders || []).filter((b) => !prevBetas.has(b));
  const removedBetaHeaders = Array.from(prevBetas).filter((b) => !(newReversed.betaHeaders || []).includes(b));

  const addedEfforts = (newReversed.reasoningEfforts || []).filter((e) => !prevEfforts.has(e));
  const addedTools = (newReversed.toolDefinitions || []).filter((t) => !prevTools.has(t));

  const isFirstBaseline = !prevSnapshotPkg;
  const isVersionBump = prevSnapshotPkg && prevSnapshotPkg.version !== newVersion;
  const hasChanges =
    isFirstBaseline ||
    isVersionBump ||
    addedModels.length > 0 ||
    removedModels.length > 0 ||
    addedBetaHeaders.length > 0 ||
    addedTools.length > 0;

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
    addedTools,
    totalModels: newReversed.models.length,
    totalBetaHeaders: newReversed.betaHeaders.length,
    currentSnapshot: {
      version: newVersion,
      models: newReversed.models,
      betaHeaders: newReversed.betaHeaders,
      reasoningEfforts: newReversed.reasoningEfforts,
      toolDefinitions: newReversed.toolDefinitions,
      lastUpdated: new Date().toISOString(),
    },
  };
}

/**
 * Formats a clean executive summary message for Telegram (strictly capped under 3,000 characters).
 */
export function formatSdkTelegramSummary(diff, labDisplayName = '') {
  const lines = [
    `📦 <b>Official SDK Release &amp; Deep Reverse</b>`,
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
  lines.push(`[2] NEW BETA HEADERS & GATES (${diff.addedBetaHeaders.length})`);
  subSep;
  if (diff.addedBetaHeaders.length > 0) {
    diff.addedBetaHeaders.forEach((b) => lines.push(`+ ${b}`));
  } else {
    lines.push('  None');
  }

  lines.push('');
  lines.push(`[3] CURRENT COMPLETE MODEL ENUM CATALOG (${diff.totalModels})`);
  lines.push(subSep);
  diff.currentSnapshot.models.forEach((m) => lines.push(`  • ${m}`));

  lines.push('');
  lines.push(`[4] CURRENT BETA HEADERS CATALOG (${diff.totalBetaHeaders})`);
  lines.push(subSep);
  diff.currentSnapshot.betaHeaders.forEach((b) => lines.push(`  • ${b}`));

  if (diff.currentSnapshot.reasoningEfforts.length > 0) {
    lines.push('');
    lines.push(`[5] REASONING EFFORT LEVELS`);
    lines.push(subSep);
    diff.currentSnapshot.reasoningEfforts.forEach((e) => lines.push(`  • ${e}`));
  }

  lines.push('');
  lines.push(sep);
  lines.push('END OF REPORT');
  lines.push(sep);

  return lines.join('\n');
}
