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
}) {
  const familyBadge = family ? `[${escapeHtml(family.toUpperCase())}] ` : '';
  const comp = escapeHtml(componentName.toUpperCase());
  const oldV = escapeHtml(oldVersion || 'none');
  const newV = escapeHtml(newVersion);
  const sId = escapeHtml(scanId);
  const timeStr = escapeHtml(formatUtcDateTime(timestamp));

  const macTarget = targets.some((t) => t.includes('darwin')) ? 'macOS ✓' : 'macOS ✗';
  const winTarget = targets.some((t) => t.includes('win32')) ? 'Windows ✓' : 'Windows ✗';
  const linuxTarget = targets.some((t) => t.includes('linux')) ? 'Linux ✓' : null;
  const targetStr = [macTarget, winTarget, linuxTarget].filter(Boolean).join(' | ');

  let msg = `🤖 <b>${familyBadge}${comp}</b>\n`;
  msg += `🚨 <b>Version Change:</b> <code>${oldV}</code> → <b>${newV}</b>\n`;
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
  coverage = {},
  countCheckText = '',
  leakCount = 0,
  newStringsCount = 0,
  urlsCount = 0,
  newUrls = [],
  timestamp = new Date(),
}) {
  const familyBadge = family ? `[${escapeHtml(family.toUpperCase())}] ` : '';
  const comp = componentName ? `${escapeHtml(componentName.toUpperCase())} · ` : '';
  const sId = escapeHtml(scanId);
  const timeStr = escapeHtml(formatUtcDateTime(timestamp));
  const totalLeaks = leakCount || (majorSignals.length + highSignals.length + moreFindings.length);

  let msg = `🤖 <b>${familyBadge}${comp}ANALYSIS COMPLETE</b>\n`;
  if (oldVersion && newVersion) {
    msg += `📦 <b>Version:</b> <code>${escapeHtml(oldVersion)}</code> ➔ <b><code>${escapeHtml(newVersion)}</code></b>\n`;
  }
  msg += `🏷️ <b>Scan:</b> <code>${sId}</code> · 📅 <i>${timeStr}</i>\n\n`;

  // Major Early Signals
  if (majorSignals.length > 0) {
    msg += `🔥 <b>MAJOR EARLY SIGNALS</b>\n`;
    for (const sig of majorSignals.slice(0, 10)) {
      const plat = (sig.platforms || []).join('+') || 'all';
      msg += `• <b>${escapeHtml(sig.category)}:</b> <code>${escapeHtml(sig.value)}</code> (${plat})\n`;
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
  } else if (majorSignals.length === 0 && totalLeaks === 0) {
    msg += `ℹ️ <i>Routine update: No early leak signals detected in this release.</i>\n\n`;
  }

  // Files summary badge
  const attachedNames = ['diff.txt'];
  if (totalLeaks > 0) attachedNames.unshift('leaks.txt');
  if (newStringsCount > 0) attachedNames.push('strings.txt');
  if (urlsCount > 0 || (newUrls && newUrls.length > 0)) attachedNames.push('urls.txt');

  const attachedCode = attachedNames.map((n) => `<code>${n}</code>`).join(', ');
  msg += `📁 <b>Attached Files:</b> ${attachedCode}\n`;
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

  // Expandable blockquote for additional findings
  if (moreFindings.length > 0 && (majorSignals.length > 0 || highSignals.length > 0)) {
    const quoteLines = moreFindings.slice(0, 20).map((f) => {
      return `• ${escapeHtml(f.category)}: ${escapeHtml(f.value)} (${f.score} pts)`;
    }).join('\n');
    msg += `<blockquote expandable>${quoteLines}</blockquote>\n\n`;
  }

  // Count Check / Coverage summary
  if (countCheckText) {
    msg += `<code>${escapeHtml(countCheckText)}</code>\n`;
  }

  return msg.slice(0, 4096);
}
