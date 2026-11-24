/**
 * Telegram Message Formatter (Section 8)
 * HTML escaping, message templates, expandable blockquotes, and length truncation.
 */

/**
 * Escape HTML special characters for Telegram HTML mode.
 */
export function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Format UTC timestamp as YYYY-MM-DD HH:MM:SS UTC.
 */
export function formatPlatformLabels(platforms = []) {
  const map = {
    darwin: 'macOS',
    macos: 'macOS',
    win32: 'Windows',
    windows: 'Windows',
    linux: 'Linux',
    all: 'all',
  };
  const labels = [];
  for (const platform of platforms || []) {
    const label = map[String(platform).toLowerCase()] || platform;
    if (label && !labels.includes(label)) labels.push(label);
  }
  return labels.length > 0 ? labels.join('+') : 'all';
}

export function formatUtcDateTime(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  const y = d.getUTCFullYear();
  const m = pad(d.getUTCMonth() + 1);
  const day = pad(d.getUTCDate());
  const h = pad(d.getUTCHours());
  const min = pad(d.getUTCMinutes());
  const s = pad(d.getUTCSeconds());
  return `${y}-${m}-${day} ${h}:${min}:${s} UTC`;
}

/**
 * Format the Initial Baseline Calibration Message (sent once on FIRST_RUN)
 */
export function formatBaselineCalibrationMessage({
  family = '',
  components = [],
  timestamp = new Date(),
}) {
  const famBadge = family ? `[${escapeHtml(family.toUpperCase())}] ` : '';
  const timeStr = escapeHtml(formatUtcDateTime(timestamp));

  let msg = `🚀 <b>${famBadge}BASELINE CALIBRATED & ACTIVE</b>\n`;
  msg += `📅 <i>${timeStr}</i>\n\n`;
  msg += `✅ <b>Current Tracked Versions:</b>\n`;

  for (const comp of components) {
    const name = escapeHtml(comp.name || comp.componentId);
    const ver = escapeHtml(comp.version || 'latest');
    msg += `• <b>${name}:</b> <code>v${ver}</code>\n`;
  }

  msg += `\n📡 <i>Baseline stored. Monitoring is active. Future updates will perform deep diff analysis and deliver leaks.txt, diff.txt, and strings.txt on new releases.</i>`;
  return msg.slice(0, 4096);
}

/**
 * Format the Immediate Alert (sent BEFORE downloading/scanning)
 */
export function formatImmediateAlert({
  componentName,
  family = '',
  oldVersion,
  newVersion,
  scanId,
  targets = [],
  releaseUrl,
  timestamp = new Date(),
  isTestRun = false,
}) {
  const testBadge = isTestRun ? '🧪 <b>[ONE-TIME PIPELINE TEST · LATEST VERSION]</b>\n' : '';
  const familyBadge = family ? `[${escapeHtml(family.toUpperCase())}] ` : '';
  const comp = escapeHtml(componentName.toUpperCase());
  const oldV = escapeHtml(oldVersion || 'none');
  const newV = escapeHtml(newVersion);
  const sId = escapeHtml(scanId);
  const timeStr = escapeHtml(formatUtcDateTime(timestamp));

  // Only list platforms the release actually publishes. "macOS ✗ | Windows ✗"
  // on a CLI package is misleading; it was never a multi-platform desktop app.
  const hasAll = targets.some((t) => !t || t === 'all' || t === 'universal');
  const platformLabels = [];
  if (hasAll) platformLabels.push('all platforms');
  if (targets.some((t) => String(t).includes('darwin'))) platformLabels.push('macOS ✓');
  if (targets.some((t) => String(t).includes('win32'))) platformLabels.push('Windows ✓');
  if (targets.some((t) => String(t).includes('linux'))) platformLabels.push('Linux ✓');
  const targetStr = platformLabels.length > 0 ? platformLabels.join(' | ') : 'unknown';

  let msg = `${testBadge}🤖 <b>${familyBadge}${comp}</b>\n`;
  if (isTestRun && oldV === newV) {
    msg += `📦 <b>Test Scan Version:</b> <code>${newV}</code>\n`;
  } else {
    msg += `🚨 <b>Version Change:</b> <code>${oldV}</code> → <b>${newV}</b>\n`;
  }
  msg += `📅 <i>${timeStr}</i>\n`;
  msg += `🎯 <b>Targets:</b> ${targetStr}\n`;
  msg += `🏷️ <b>Scan ID:</b> <code>${sId}</code>\n`;
  if (releaseUrl) {
    msg += `🔗 <a href="${escapeHtml(releaseUrl)}">[Official Release]</a>`;
  }
  return msg;
}

/**
 * Format Completion Message (edit or reply to alert)
 */
export function formatCompletionMessage({
  componentName = '',
  family = '',
  oldVersion = '',
  newVersion = '',
  scanId,
  counts = {},
  majorSignals = [],
  highSignals = [],
  moreFindings = [],
  changedSignals = [],
  coverage = {},
  countCheckText = '',
  leakCount = 0,
  newStringsCount = 0,
  urlsCount = 0,
  newUrls = [],
  attachedFiles = [],
  deliveryStatus = null,
  analyzerStatus = null,
  pricingSignals = [],
  modelCount = 0,
  pricingCount = 0,
  timestamp = new Date(),
  isTestRun = false,
}) {
  const testBadge = isTestRun ? '🧪 <b>[ONE-TIME PIPELINE TEST COMPLETE]</b>\n' : '';
  const familyBadge = family ? `[${escapeHtml(family.toUpperCase())}] ` : '';
  const comp = componentName ? `${escapeHtml(componentName.toUpperCase())} · ` : '';
  const sId = escapeHtml(scanId);
  const timeStr = escapeHtml(formatUtcDateTime(timestamp));
  const totalLeaks = leakCount || (majorSignals.length + highSignals.length + moreFindings.length);
  const analysisLabel = coverage?.coverageState && coverage.coverageState !== 'COMPLETE'
    ? 'ANALYSIS INCOMPLETE'
    : 'ANALYSIS COMPLETE';

  let msg = `${testBadge}🤖 <b>${familyBadge}${comp}${analysisLabel}</b>\n`;
  if (oldVersion && newVersion) {
    msg += `📦 <b>Version:</b> <code>${escapeHtml(oldVersion)}</code> ➔ <b><code>${escapeHtml(newVersion)}</code></b>\n`;
  }
  msg += `🏷️ <b>Scan:</b> <code>${sId}</code> · 📅 <i>${timeStr}</i>\n`;
  if (coverage?.coverageState) {
    msg += `🧭 <b>Coverage:</b> ${escapeHtml(coverage.coverageState)}`;
    if (coverage.downloadedArtifacts !== undefined && coverage.expectedArtifacts !== undefined) {
      msg += ` · artifacts ${coverage.downloadedArtifacts}/${coverage.expectedArtifacts}`;
    }
    if (coverage.analyzedFiles !== undefined) msg += ` · files ${coverage.analyzedFiles}`;
    msg += '\n';
  }
  if (analyzerStatus) {
    const parts = Object.entries(analyzerStatus)
      .map(([name, value]) => `${name}:${value}`)
      .join(' · ');
    if (parts) msg += `🧪 <b>Analyzers:</b> <code>${escapeHtml(parts)}</code>\n`;
  }
  msg += '\n';

  // Major Early Signals
  if (majorSignals.length > 0) {
    msg += `🔥 <b>MAJOR EARLY SIGNALS</b>\n`;
    for (const sig of majorSignals.slice(0, 10)) {
      const plat = formatPlatformLabels(sig.platforms || []);
      msg += `• <b>${escapeHtml(sig.category)}:</b> <code>${escapeHtml(sig.value)}</code> (${escapeHtml(plat)})\n`;
    }
    msg += '\n';
  }

  // High Signals
  if (highSignals.length > 0) {
    msg += `⭐ <b>HIGH-CONFIDENCE SIGNALS</b>\n`;
    for (const sig of highSignals.slice(0, 5)) {
      msg += `• <b>${escapeHtml(sig.category)}:</b> <code>${escapeHtml(sig.value)}</code> (${sig.score} pts)\n`;
    }
    msg += '\n';
  }

  // Modified / Activated Signals
  if (changedSignals.length > 0) {
    msg += `🔄 <b>MODIFIED / ACTIVATED SIGNALS (${changedSignals.length})</b>\n`;
    for (const sig of changedSignals.slice(0, 8)) {
      const statusShift = sig.previousStatus && sig.activationStatus && sig.previousStatus !== sig.activationStatus
        ? ` (<code>${escapeHtml(sig.previousStatus)}</code> ➔ <b>${escapeHtml(sig.activationStatus)}</b>)`
        : '';
      msg += `• <b>${escapeHtml(sig.category)}:</b> <code>${escapeHtml(sig.value)}</code>${statusShift}\n`;
    }
    if (changedSignals.length > 8) {
      msg += `<i>…plus ${changedSignals.length - 8} more modified signals in leaks.txt</i>\n`;
    }
    msg += '\n';
  } else if (majorSignals.length === 0 && highSignals.length === 0 && totalLeaks === 0 && pricingSignals.length === 0) {
    msg += `ℹ️ <i>Routine update: No early leak signals detected in this release.</i>\n\n`;
  }

  // Model / pricing tables
  if (pricingSignals.length > 0) {
    msg += `💵 <b>MODEL &amp; PRICING TABLE</b> (${modelCount} models · ${pricingCount} rates)\n`;
    for (const sig of pricingSignals.slice(0, 6)) {
      msg += `• <code>${escapeHtml(sig.value)}</code>\n`;
    }
    msg += '\n';
  }

  // Files summary badge. Only list files that were actually uploaded.
  const attachedNames = Array.isArray(attachedFiles) && attachedFiles.length > 0
    ? attachedFiles.map((file) => (typeof file === 'string' ? file : file.name)).filter(Boolean)
    : [];
  const attachedCode = attachedNames.length > 0
    ? attachedNames.map((n) => `<code>${escapeHtml(n)}</code>`).join(', ')
    : '<i>none delivered yet</i>';
  msg += `📁 <b>Attached Files:</b> ${attachedCode}\n`;
  if (deliveryStatus) {
    const delivered = deliveryStatus.deliveredFiles?.length || 0;
    const failed = deliveryStatus.failedFiles?.length || 0;
    const statusText = failed === 0
      ? `✅ all ${delivered} files delivered`
      : `⚠️ ${delivered} delivered · ${failed} failed (will retry on next run)`;
    msg += `🚚 <b>Delivery:</b> ${escapeHtml(statusText)}\n`;
    if (failed > 0) {
      msg += `❌ <b>Failed:</b> ${escapeHtml((deliveryStatus.failedFiles || []).map((f) => f.name || f).join(', '))}\n`;
    }
  }
  if (newUrls && newUrls.length > 0) {
    msg += `🌐 <b>New Application Routes (${newUrls.length}):</b>\n`;
    for (const u of newUrls.slice(0, 5)) {
      const uStr = typeof u === 'string' ? u : u.url;
      const cat = typeof u === 'string' ? '' : `[${u.category?.replace(/_/g, ' ') || 'ENDPOINT'}] `;
      msg += `• ${escapeHtml(cat)}<code>${escapeHtml(uStr)}</code>\n`;
    }
    msg += '\n';
  } else {
    msg += '\n';
  }

  // Expandable blockquote for additional findings. If there are no stronger
  // signals, still show a short early-signal list instead of silently dropping
  // them.
  if (moreFindings.length > 0 && (majorSignals.length > 0 || highSignals.length > 0)) {
    const quoteLines = moreFindings.slice(0, 20).map((f) => {
      return `• ${escapeHtml(f.category)}: ${escapeHtml(f.value)} (${f.score} pts)`;
    }).join('\n');
    msg += `<blockquote expandable>${quoteLines}</blockquote>\n\n`;
  } else if (moreFindings.length > 0) {
    msg += `🔎 <b>EARLY SIGNALS</b>\n`;
    for (const signal of moreFindings.slice(0, 10)) {
      msg += `• <b>${escapeHtml(signal.category)}:</b> <code>${escapeHtml(signal.value)}</code> (${signal.score} pts)\n`;
    }
    msg += '\n';
  }

  // Count Check / Coverage summary
  if (countCheckText) {
    msg += `<code>${escapeHtml(countCheckText)}</code>\n`;
  }

  return msg;
}
