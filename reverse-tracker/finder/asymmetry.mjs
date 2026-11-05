/**
 * Cross-Platform Asymmetry Detector (Section 4.2)
 * Identifies findings present on macOS but missing on Windows (or vice versa).
 */

/**
 * Compare findings across OS targets within the same release.
 *
 * @param {Array<Object>} macFindings - Extracted records from darwin targets
 * @param {Array<Object>} winFindings - Extracted records from win32 targets
 * @returns {Object} { common, macOnly, winOnly }
 */
export function detectPlatformAsymmetry(macFindings = [], winFindings = []) {
  const macMap = new Map();
  for (const f of macFindings) {
    macMap.set(f.value, f);
  }

  const winMap = new Map();
  for (const f of winFindings) {
    winMap.set(f.value, f);
  }

  const macOnly = [];
  const winOnly = [];
  const common = [];

  for (const [val, f] of macMap.entries()) {
    if (winMap.has(val)) {
      common.push({ ...f, platforms: ['macOS', 'Windows'] });
    } else {
      macOnly.push({ ...f, platformOnly: 'macOS', platforms: ['macOS'] });
    }
  }

  for (const [val, f] of winMap.entries()) {
    if (!macMap.has(val)) {
      winOnly.push({ ...f, platformOnly: 'Windows', platforms: ['Windows'] });
    }
  }

  return { common, macOnly, winOnly };
}
