/**
 * Deep Build Analyzer & Report Generator
 * Extracts:
 * 1. New Model Identifiers & Slugs (Highest Priority)
 * 2. Feature Gates & Experiment Flags (can_see_*, deep_*, etc.)
 * 3. Tool Schemas & Action Definitions
 * 4. Launch Copy & Announcement Text
 * 
 * Generates full permanent markdown reports in early-radar/reports/
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = path.join(__dirname, 'reports');

/**
 * Dynamically extracts all signals from JavaScript chunk content.
 * ZERO hardcoded model names.
 */
export function analyzeChunkContent(jsText) {
  if (!jsText || typeof jsText !== 'string') {
    return { models: [], featureGates: [], toolSchemas: [], launchCopy: [] };
  }

  const models = new Set();
  const featureGates = new Set();
  const toolSchemas = new Set();
  const launchCopy = new Set();

  // 1. Dynamic Model Identifiers
  const modelRegexes = [
    /(?:model_slug|model_id|default_model|modelName)\s*[:=]\s*['"]([a-zA-Z0-9_\-\.\:\/]+)['"]/gi,
    /"(?:model_slug|model_id|default_model)"\s*:\s*"([a-zA-Z0-9_\-\.\:\/]+)"/gi,
  ];
  for (const regex of modelRegexes) {
    for (const m of jsText.matchAll(regex)) {
      const val = m[1].trim();
      if (val.length > 2 && !['undefined', 'null', 'default', 'true', 'false'].includes(val.toLowerCase())) {
        models.add(val);
      }
    }
  }

  // 2. Dynamic Feature Gates & Experiments (can_see_*, has_*, enable_*, etc.)
  const gateRegexes = [
    /['"](can_see_[a-zA-Z0-9_]+)['"]/gi,
    /['"](enable_[a-zA-Z0-9_]+)['"]/gi,
    /['"](has_feature_[a-zA-Z0-9_]+)['"]/gi,
    /['"]([a-zA-Z0-9_]+_experiment_[a-zA-Z0-9_]+)['"]/gi,
    /['"]([a-zA-Z0-9_]+_v[0-9]+(?:_preview|_beta)?)['"]/gi,
  ];
  for (const regex of gateRegexes) {
    for (const m of jsText.matchAll(regex)) {
      const val = m[1].trim();
      if (val.length > 5 && !val.startsWith('http') && !val.includes('/')) {
        featureGates.add(val);
      }
    }
  }

  // 3. Tool Schemas
  const toolRegex = /name\s*:\s*['"]([a-zA-Z0-9_]+_(?:tool|sandbox|terminal|action|plugin|search|browser))['"]/gi;
  for (const m of jsText.matchAll(toolRegex)) {
    toolSchemas.add(m[1].trim());
  }

  // 4. Launch Copy (Readable English sentences starting with announcement phrases)
  const copyRegex = /"((?:Introducing|Announcing|Try our new|Welcome to|Early access to)\s+[A-Z][^"]{10,120})"/g;
  for (const m of jsText.matchAll(copyRegex)) {
    launchCopy.add(m[1].trim());
  }

  return {
    models: Array.from(models),
    featureGates: Array.from(featureGates),
    toolSchemas: Array.from(toolSchemas),
    launchCopy: Array.from(launchCopy),
  };
}

/**
 * Saves a full, unabridged markdown report to early-radar/reports/BUILD_<hash>.md
 */
export function writeBuildReport(serviceName, hash, analysis, repoBaseUrl = 'https://github.com/Namra7-x/lmarena-tracker') {
  if (!fs.existsSync(REPORTS_DIR)) {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
  }

  const fileName = `BUILD_${serviceName.toLowerCase()}_${hash}.md`;
  const filePath = path.join(REPORTS_DIR, fileName);

  const lines = [
    `# Production Build Report: ${serviceName} (${hash})`,
    ``,
    `*Generated on: ${new Date().toISOString()}*`,
    ``,
    `---`,
    ``,
    `## ⚡ Discovered Models (${analysis.models.length})`,
  ];

  if (analysis.models.length > 0) {
    analysis.models.forEach((m) => lines.push(`- \`${m}\``));
  } else {
    lines.push(`*No new explicit model slugs found in changed chunks.*`);
  }

  lines.push(``, `## 🚩 Discovered Feature Gates (${analysis.featureGates.length})`);
  if (analysis.featureGates.length > 0) {
    analysis.featureGates.forEach((g) => lines.push(`- \`${g}\``));
  } else {
    lines.push(`*No new feature gates found.*`);
  }

  lines.push(``, `## 🛠️ Tool Schemas & Sandboxes (${analysis.toolSchemas.length})`);
  if (analysis.toolSchemas.length > 0) {
    analysis.toolSchemas.forEach((t) => lines.push(`- \`${t}\``));
  } else {
    lines.push(`*No new tool schemas found.*`);
  }

  lines.push(``, `## 📢 Launch Copy & Announcements (${analysis.launchCopy.length})`);
  if (analysis.launchCopy.length > 0) {
    analysis.launchCopy.forEach((c) => lines.push(`> "${c}"`));
  } else {
    lines.push(`*No announcement copy detected.*`);
  }

  lines.push(``);
  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');

  // Return public GitHub URL for the markdown file
  return `${repoBaseUrl}/blob/feat/early-radar/early-radar/reports/${fileName}`;
}
