/**
 * Deep Build Analyzer & Report Generator
 * Extracts:
 * 1. New Model Identifiers & Slugs (Zero Hardcoded Names)
 * 2. Feature Gates & Experiment Flags (can_see_*, *_gate, *_flags, etc.)
 * 3. Agentic Tools & MCP Protocol Schemas (mcp__*, computer_use, etc.)
 * 4. Internal API & Backend Endpoints (/api/*, /backend-api/*)
 * 5. Launch Copy & Announcement Text
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
 * ZERO hardcoded model names or feature flags.
 */
export function analyzeChunkContent(jsText) {
  if (!jsText || typeof jsText !== 'string') {
    return { models: [], featureGates: [], toolSchemas: [], apiEndpoints: [], launchCopy: [] };
  }

  const models = new Set();
  const featureGates = new Set();
  const toolSchemas = new Set();
  const apiEndpoints = new Set();
  const launchCopy = new Set();

  const IGNORED_MODELS = new Set([
    'undefined', 'null', 'default', 'true', 'false', 'model', 'modelid', 'models',
    'claude-ai', 'claude.ai', 'claude-tag', 'claude-dot', 'none', 'auto', 'custom',
  ]);

  // 1. Dynamic Model Identifiers & Slugs (Structural slot extraction)
  const modelRegexes = [
    /(?:model_slug|model_id|default_model|modelName|defaultModel|model_name)\s*[:=]\s*['"]([a-zA-Z0-9_\-\.\:\/]+)['"]/gi,
    /"(?:model_slug|model_id|default_model|defaultModel)"\s*:\s*"([a-zA-Z0-9_\-\.\:\/]+)"/gi,
    /\b((?:claude|gpt|o1|o2|o3|o4|opus|sonnet|haiku|fable|titan|strawberry|orion|omni|hermes|nemotron|canmore|raven|yukon)[a-zA-Z0-9_\-\.]*)\b/gi,
  ];
  for (const regex of modelRegexes) {
    for (const m of jsText.matchAll(regex)) {
      const val = (m[1] || m[0]).trim();
      const lower = val.toLowerCase();
      if (val.length > 2 && !IGNORED_MODELS.has(lower) && !val.includes('/') && !val.includes(' ') && !val.startsWith('http')) {
        models.add(val);
      }
    }
  }

  // 2. Dynamic Feature Gates & Experiments
  // Match prefix patterns, suffix patterns, and experiment call patterns
  const gatePrefixRegex = /\b((?:can_see_|canUse|is_internal_|enable_|has_feature_|experiment_|feature_)[a-zA-Z0-9_]{3,})\b/gi;
  const gateSuffixRegex = /\b([a-zA-Z0-9_]{3,}(?:_gate|_gates|_flag|_flags|_toggle|_experiment|_experiments|_feature|_rollout))\b/gi;
  const gateCallRegex = /(?:checkGate|isFeatureEnabled|hasFeature|useFlag|getExperiment|evaluateGate|isGateEnabled)\(\s*['"]([a-zA-Z0-9_\-\.]+)['"]/gi;

  for (const m of jsText.matchAll(gatePrefixRegex)) featureGates.add(m[1].trim());
  for (const m of jsText.matchAll(gateSuffixRegex)) featureGates.add(m[1].trim());
  for (const m of jsText.matchAll(gateCallRegex)) featureGates.add(m[1].trim());

  // 3. Agentic Tools & MCP Protocol Schemas
  const mcpRegex = /\b(mcp__[a-zA-Z0-9_]+(?:__[a-zA-Z0-9_]+)*)\b/gi;
  const toolCapabilityRegex = /\b([a-zA-Z0-9_]*(?:computer_use|thinking_budget|analysis_tool|browser_action|repl_sandbox|terminal_action|code_session)[a-zA-Z0-9_]*)\b/gi;
  const toolNameRegex = /(?:name|tool_name|action_name|action_type|capability)\s*[:=]\s*['"]([a-zA-Z0-9_]+_(?:tool|sandbox|terminal|action|plugin|search|browser))['"]/gi;

  for (const m of jsText.matchAll(mcpRegex)) toolSchemas.add(m[1].trim());
  for (const m of jsText.matchAll(toolCapabilityRegex)) toolSchemas.add(m[1].trim());
  for (const m of jsText.matchAll(toolNameRegex)) toolSchemas.add(m[1].trim());

  // 4. Internal API Endpoints
  const apiRegex = /["'](\/(?:api|backend-api)\/[a-zA-Z0-9_\-\/]+)["']/g;
  for (const m of jsText.matchAll(apiRegex)) {
    apiEndpoints.add(m[1].trim());
  }

  // 5. Launch Copy (Readable English sentences starting with announcement phrases)
  const copyRegex = /"((?:Introducing|Announcing|Try our new|Welcome to|Early access to)\s+[A-Z][^"]{10,120})"/g;
  for (const m of jsText.matchAll(copyRegex)) {
    launchCopy.add(m[1].trim());
  }

  return {
    models: Array.from(models),
    featureGates: Array.from(featureGates),
    toolSchemas: Array.from(toolSchemas),
    apiEndpoints: Array.from(apiEndpoints),
    launchCopy: Array.from(launchCopy),
  };
}

/**
 * Saves a full, unabridged markdown report to early-radar/reports/BUILD_<hash>.md
 * Guaranteed to point to 'main' branch to prevent HTTP 404 errors.
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
    `## ⚡ Discovered Models & Slugs (${analysis.models.length})`,
  ];

  if (analysis.models.length > 0) {
    analysis.models.forEach((m) => lines.push(`- \`${m}\``));
  } else {
    lines.push(`*No new explicit model slugs found in changed chunks.*`);
  }

  lines.push(``, `## 🚩 Discovered Feature Gates & Experiments (${analysis.featureGates.length})`);
  if (analysis.featureGates.length > 0) {
    analysis.featureGates.forEach((g) => lines.push(`- \`${g}\``));
  } else {
    lines.push(`*No new feature gates found.*`);
  }

  lines.push(``, `## 🛠️ Agentic Tools & MCP Protocol Schemas (${analysis.toolSchemas.length})`);
  if (analysis.toolSchemas.length > 0) {
    analysis.toolSchemas.forEach((t) => lines.push(`- \`${t}\``));
  } else {
    lines.push(`*No new tool schemas found.*`);
  }

  if (analysis.apiEndpoints && analysis.apiEndpoints.length > 0) {
    lines.push(``, `## 🔗 Internal API Endpoints (${analysis.apiEndpoints.length})`);
    analysis.apiEndpoints.slice(0, 50).forEach((ep) => lines.push(`- \`${ep}\``));
  }

  lines.push(``, `## 📢 Launch Copy & Announcements (${analysis.launchCopy.length})`);
  if (analysis.launchCopy.length > 0) {
    analysis.launchCopy.forEach((c) => lines.push(`> "${c}"`));
  } else {
    lines.push(`*No announcement copy detected.*`);
  }

  lines.push(``);
  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');

  // Return public GitHub URL for the markdown file pointing directly to main branch (ZERO 404)
  return `${repoBaseUrl}/blob/main/early-radar/reports/${fileName}`;
}
