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
 * Format the Immediate Alert (sent BEFORE downloading/scanning)
 */
export function formatImmediateAlert({ componentName, oldVersion, newVersion, scanId, targets = [], releaseUrl }) {
  const comp = escapeHtml(componentName.toUpperCase());
  const oldV = escapeHtml(oldVersion || 'none');
  const newV = escapeHtml(newVersion);
  const sId = escapeHtml(scanId);

  const macTarget = targets.some((t) => t.includes('darwin')) ? 'macOS ✓' : 'macOS ✗';
  const winTarget = targets.some((t) => t.includes('win32')) ? 'Windows ✓' : 'Windows ✗';

  let msg = `🚨 <b>${comp} ${oldV} → ${newV}</b>\n`;
  msg += `Targets: ${macTarget}  ${winTarget}\n`;
  msg += `Scan: <code>${sId}</code>\n`;
  if (releaseUrl) {
    msg += `<a href="${escapeHtml(releaseUrl)}">[Official Release]</a>`;
  }
  return msg;
}

/**
 * Format Completion Message (edit or reply to alert)
 */
export function formatCompletionMessage({
  scanId,
  counts = {},
  majorSignals = [],
  highSignals = [],
  moreFindings = [],
  coverage = {},
  countCheckText = '',
}) {
  const sId = escapeHtml(scanId);
  const statLine = `${counts.commands || 0} commands · ${counts.flags || 0} flags · ${counts.configs || 0} config keys · ${counts.endpoints || 0} endpoints`;

  let msg = `🔬 <b>ANALYSIS COMPLETE · ${sId}</b>\n`;
  msg += `<i>${escapeHtml(statLine)}</i>\n\n`;

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
  }

  // Expandable blockquote for additional findings
  if (moreFindings.length > 0) {
    const quoteLines = moreFindings.slice(0, 30).map((f) => {
      return `• ${escapeHtml(f.category)}: ${escapeHtml(f.value)} (${f.score} pts)`;
    }).join('\n');
    msg += `<blockquote expandable>${quoteLines}</blockquote>\n\n`;
  }

  // Mandatory Count Check & Coverage block
  if (countCheckText) {
    msg += `<code>${escapeHtml(countCheckText)}</code>\n`;
  } else {
    msg += `Coverage: ${coverage.percentage || 100}% ✓  macOS ${coverage.macOk ? '✓' : '✗'} Windows ${coverage.winOk ? '✓' : '✗'}\n`;
  }

  return msg.slice(0, 4096);
}
