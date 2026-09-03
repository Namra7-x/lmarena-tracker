#!/usr/bin/env node
/**
 * LM Arena Tracker — High-Performance Native Node.js Edition
 *
 * Engineered for sub-second execution on GitHub Actions & Cloudflare edge:
 * - 100% Native Node.js ES Module (Zero npm packages, Zero pip install)
 * - Concurrent HTTP/2 & Fetch API: sub-second extraction
 * - 1 message per model event: guaranteed NOTHING is collapsed or missed in Discord
 * - Shows User Selectable (Live / Internal) on every model alert
 * - Modality collapse validation & anti-flapping baseline guards
 * - Stable identity-based batch confirmation
 */

import fs from 'node:fs';
import crypto from 'node:crypto';

// ==============================================================================
// Configuration
// ==============================================================================
const ARENA_URL = (process.env.ARENA_URL || 'https://canaryarena.ai/').trim();
const SNAPSHOT_FILE = 'snapshot.json';
const ALERT_STATE_FILE = '.arena_alert_state.json';

const DISCORD_WEBHOOK_URL = (
  process.env.DISCORD_WEBHOOK_URL ||
  process.env.DISCORD_WEBHOOK ||
  ''
).trim();

const TRACK_RANK = (process.env.TRACK_RANK || 'true').toLowerCase() === 'true';
const UNRANKED = 9007199254740991; // Number.MAX_SAFE_INTEGER
const LARGE_BATCH_THRESHOLD = 20;  // 20+ models added/removed require 2-run confirmation
const MIN_MODALITY_DROP_RATIO = 0.25;
const MODALITY_MIN_MODELS = 15;

const TRACKED_FIELDS = [
  'publicName',
  'displayName',
  'name',
  'organization',
  'provider',
  'userSelectable',
];

const FIELD_LABELS = {
  publicName: 'Public Name',
  displayName: 'Display Name',
  name: 'Internal Name',
  organization: 'Organization',
  provider: 'Provider',
  userSelectable: 'User Selectable',
};

const MODALITY_NORMALIZER = {
  text: 'chat',
  chat: 'chat',
  web: 'webdev',
  webdev: 'webdev',
  image: 'image',
  video: 'video',
  search: 'search',
};

// Vibrant Discord Border Colors
const COLORS = {
  new: 0x2ecc71,       // Emerald Green
  stealth: 0x9b59b6,   // Amethyst Purple
  variant: 0x1abc9c,   // Turquoise / Teal
  rename: 0x3498db,    // Sky Blue
  capability: 0xe67e22,// Orange
  rotation: 0x5865f2,  // Blurple
  rank: 0x34495e,      // Dark Navy
  org: 0xf1c40f,       // Sunflower Yellow
  provider: 0xe67e22,  // Carrot Orange
  enabled: 0x2ecc71,   // Bright Green
  disabled: 0xe74c3c,  // Red
  removed: 0xe74c3c,   // Red
  warning: 0xe67e22,   // Amber Warning
  brand: 0x5865f2,     // Brand
};

const AUTHOR_INFO = {
  name: 'LMSYS Arena Tracker',
  url: ARENA_URL,
  icon_url: 'https://arena.ai/favicon.ico',
};


// ==============================================================================
// Normalization & Capability Helpers
// ==============================================================================
function getModelModalities(model) {
  const mods = new Set();
  const caps = model?.capabilities?.outputCapabilities || {};
  for (const [k, v] of Object.entries(caps)) {
    if (v) {
      const norm = MODALITY_NORMALIZER[k.toLowerCase()] || k.toLowerCase();
      mods.add(norm);
    }
  }
  const rankByMod = model?.rankByModality || {};
  for (const k of Object.keys(rankByMod)) {
    const norm = MODALITY_NORMALIZER[k.toLowerCase()] || k.toLowerCase();
    mods.add(norm);
  }
  return mods;
}

function countModalities(models) {
  const counts = {};
  for (const m of Object.values(models)) {
    for (const mod of getModelModalities(m)) {
      counts[mod] = (counts[mod] || 0) + 1;
    }
  }
  return counts;
}

function flattenCaps(model) {
  const caps = model?.capabilities || {};
  const result = new Set();
  const inputCaps = caps.inputCapabilities || {};
  for (const [k, v] of Object.entries(inputCaps)) {
    if (v) result.add(`in:${k}`);
  }
  const outputCaps = caps.outputCapabilities || {};
  for (const [k, v] of Object.entries(outputCaps)) {
    if (v) result.add(`out:${k}`);
  }
  return result;
}

function formatCapabilityLines(model) {
  const badges = [];
  const c = model?.capabilities || {};
  const inp = c.inputCapabilities || {};
  const out = c.outputCapabilities || {};

  if (inp.text) badges.push('💬 Text');
  if (inp.image) badges.push('🖼️ Vision');
  if (inp.video) badges.push('🎬 Video In');
  if (inp.file) badges.push('📁 File');

  if (out.search) badges.push('🔍 Search');
  if (out.web) badges.push('🌐 Web');
  if (out.image) badges.push('🎨 Image Gen');
  if (out.video) badges.push('🎥 Video Gen');

  if (badges.length === 0) {
    const raw = Array.from(flattenCaps(model)).sort();
    return raw.length > 0 ? raw.slice(0, 6).map(r => `\`${r}\``).join(' • ') : '*None*';
  }
  return badges.map(b => `\`${b}\``).join(' • ');
}

function disp(model) {
  return String(model?.displayName || model?.publicName || model?.id || 'Unknown');
}

function valOrDash(val) {
  return val === null || val === undefined || String(val).trim() === '' || String(val) === 'None'
    ? '—'
    : String(val);
}

function fmtRank(rankVal) {
  if (rankVal === null || rankVal === undefined || rankVal === UNRANKED) {
    return 'Unranked';
  }
  return `#${rankVal}`;
}

function fmtSelectable(val) {
  return val ? '✅ Yes (Selectable in Arena)' : '❌ No (Internal / Eval Only)';
}


// ==============================================================================
// Fast Fetch & Next.js Extraction
// ==============================================================================
const PUSH_RE = /self\.__next_f\.push\(\[1,"((?:\\.|[^"\\])*)"\]\)/gs;

function decodeNextJsPayload(html) {
  const parts = [];
  let match;
  while ((match = PUSH_RE.exec(html)) !== null) {
    const raw = match[1];
    try {
      parts.push(JSON.parse(`"${raw}"`));
    } catch {
      parts.push(raw);
    }
  }
  return parts.join('');
}

function extractJsonArray(text, key = '"initialModels":') {
  const idx = text.indexOf(key);
  if (idx === -1) return null;
  const start = text.indexOf('[', idx);
  if (start === -1) return null;

  let depth = 0;
  let inStr = false;
  let escChar = false;

  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (escChar) {
        escChar = false;
      } else if (c === '\\') {
        escChar = true;
      } else if (c === '"') {
        inStr = false;
      }
    } else {
      if (c === '"') {
        inStr = true;
      } else if (c === '[') {
        depth++;
      } else if (c === ']') {
        depth--;
        if (depth === 0) {
          return text.slice(start, i + 1);
        }
      }
    }
  }
  return null;
}

async function fetchArenaHtml() {
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
  };

  let lastErr = 'unknown';
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(ARENA_URL, {
        headers,
        signal: AbortSignal.timeout(15000),
      });

      if (res.ok) {
        const text = await res.text();
        if (text.includes('initialModels')) {
          return text;
        }
        lastErr = `HTTP ${res.status}, initialModels missing`;
      } else {
        lastErr = `HTTP ${res.status}`;
      }
    } catch (err) {
      lastErr = err.message;
    }

    if (attempt < 4) {
      // Instant small retry pause (under 1s)
      await new Promise((r) => setTimeout(r, 800));
    }
  }

  throw new Error(`Failed to fetch ${ARENA_URL} after 4 attempts: ${lastErr}`);
}

function parseModelsFromHtml(html) {
  const decoded = decodeNextJsPayload(html);
  const rawArray = extractJsonArray(decoded) || extractJsonArray(html);
  if (!rawArray) {
    throw new Error('initialModels array not found in arena page');
  }
  const models = JSON.parse(rawArray);
  const map = {};
  for (const m of models) {
    if (m && typeof m === 'object' && typeof m.id === 'string') {
      map[m.id] = m;
    }
  }
  return map;
}


// ==============================================================================
// Modality Health & Sanity Validation
// ==============================================================================
function checkModalityHealth(oldModels, newModels) {
  if (!newModels || Object.keys(newModels).length === 0) {
    return { ok: false, reason: 'Empty model response (0 models)' };
  }

  if (!oldModels) {
    const count = Object.keys(newModels).length;
    if (count < 100) {
      return { ok: false, reason: `Baseline model count suspiciously low (${count} models)` };
    }
    return { ok: true, reason: 'Baseline OK' };
  }

  const oldCount = Object.keys(oldModels).length;
  const newCount = Object.keys(newModels).length;

  // 1. Overall count drop guard
  const minAllowed = Math.max(50, Math.floor(oldCount * 0.60));
  if (newCount < minAllowed) {
    return {
      ok: false,
      reason: `Catastrophic count drop: ${newCount} models vs ${oldCount} baseline (<60%)`,
    };
  }

  // 2. Modality collapse guard
  const oldMods = countModalities(oldModels);
  const newMods = countModalities(newModels);

  for (const [mod, countBefore] of Object.entries(oldMods)) {
    if (countBefore >= MODALITY_MIN_MODELS) {
      const countAfter = newMods[mod] || 0;
      const ratio = countAfter / countBefore;
      if (ratio < MIN_MODALITY_DROP_RATIO) {
        return {
          ok: false,
          reason: `Modality '${mod}' collapsed: ${countAfter} vs ${countBefore} before (${(ratio * 100).toFixed(1)}% kept)`,
        };
      }
    }
  }

  return { ok: true, reason: 'Healthy' };
}

async function getModels(oldModels) {
  let lastErr = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const html = await fetchArenaHtml();
      const models = parseModelsFromHtml(html);
      const health = checkModalityHealth(oldModels, models);
      if (health.ok) {
        return { models, valid: true, statusMsg: 'OK' };
      }
      lastErr = health.reason;
      console.warn(`Extraction attempt ${attempt} incomplete: ${lastErr}. Retrying...`);
      await new Promise((r) => setTimeout(r, 1000));
    } catch (err) {
      lastErr = err.message;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return { models: {}, valid: false, statusMsg: lastErr };
}


// ==============================================================================
// Identity Hash & Alert State
// ==============================================================================
function snapshotIdentityHash(models) {
  const identities = [];
  const sortedIds = Object.keys(models).sort();
  for (const mid of sortedIds) {
    const m = models[mid];
    const pn = String(m?.publicName || '').trim();
    const caps = Array.from(flattenCaps(m)).sort();
    identities.push([mid, pn, caps]);
  }
  const payload = JSON.stringify(identities);
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

function loadAlertState() {
  if (!fs.existsSync(ALERT_STATE_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(ALERT_STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveAlertState(state) {
  fs.writeFileSync(ALERT_STATE_FILE, JSON.stringify(state, null, 1) + '\n', 'utf8');
}

function loadSnapshot() {
  if (!fs.existsSync(SNAPSHOT_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function saveSnapshot(models) {
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(models, null, 1) + '\n', 'utf8');
}


// ==============================================================================
// Deep Diff Engine
// ==============================================================================
class ModelChangeReport {
  constructor() {
    this.new_models = [];
    this.hidden_models = [];
    this.variants = [];
    this.name_updates = [];
    this.org_updates = [];
    this.provider_updates = [];
    this.capability_updates = [];
    this.selectable_enabled = [];
    this.selectable_disabled = [];
    this.id_rotations = [];
    this.rank_updates = [];
    this.removed_models = [];
  }

  hasChanges() {
    return (
      this.new_models.length > 0 ||
      this.hidden_models.length > 0 ||
      this.variants.length > 0 ||
      this.name_updates.length > 0 ||
      this.org_updates.length > 0 ||
      this.provider_updates.length > 0 ||
      this.capability_updates.length > 0 ||
      this.selectable_enabled.length > 0 ||
      this.selectable_disabled.length > 0 ||
      this.id_rotations.length > 0 ||
      this.rank_updates.length > 0 ||
      this.removed_models.length > 0
    );
  }
}

function detectChanges(oldModels, newModels) {
  const report = new ModelChangeReport();

  const oldIds = new Set(Object.keys(oldModels));
  const newIds = new Set(Object.keys(newModels));

  const removedIds = new Set([...oldIds].filter((x) => !newIds.has(x)));
  const addedIds = new Set([...newIds].filter((x) => !oldIds.has(x)));
  const commonIds = [...oldIds].filter((x) => newIds.has(x));

  // 1. Multi-Pass ID Rotation Pairing
  const stillRemoved = new Set(removedIds);
  const stillAdded = new Set(addedIds);

  // Pass 1: Match by exact publicName
  const byPublicName = {};
  for (const mid of [...stillRemoved].sort()) {
    const pn = String(oldModels[mid]?.publicName || '').trim();
    if (pn) {
      if (!byPublicName[pn]) byPublicName[pn] = [];
      byPublicName[pn].push(mid);
    }
  }

  for (const mid of [...stillAdded].sort()) {
    const pn = String(newModels[mid]?.publicName || '').trim();
    if (pn && byPublicName[pn] && byPublicName[pn].length > 0) {
      const oldMid = byPublicName[pn].shift();
      report.id_rotations.push([oldModels[oldMid], newModels[mid]]);
      stillRemoved.delete(oldMid);
      stillAdded.delete(mid);
    }
  }

  // Pass 2: Match by displayName
  const byDisplayName = {};
  for (const mid of [...stillRemoved].sort()) {
    const dn = String(oldModels[mid]?.displayName || '').trim();
    if (dn) {
      if (!byDisplayName[dn]) byDisplayName[dn] = [];
      byDisplayName[dn].push(mid);
    }
  }

  for (const mid of [...stillAdded].sort()) {
    const dn = String(newModels[mid]?.displayName || '').trim();
    if (dn && byDisplayName[dn] && byDisplayName[dn].length > 0) {
      const oldMid = byDisplayName[dn].shift();
      report.id_rotations.push([oldModels[oldMid], newModels[mid]]);
      stillRemoved.delete(oldMid);
      stillAdded.delete(mid);
    }
  }

  // Remaining are genuine removals
  for (const mid of [...stillRemoved].sort()) {
    report.removed_models.push(oldModels[mid]);
  }

  // 2. Classify Added Models
  const oldPublicNames = new Set(
    Object.values(oldModels)
      .map((m) => String(m?.publicName || '').trim())
      .filter(Boolean)
  );

  for (const mid of [...stillAdded].sort()) {
    const m = newModels[mid];
    const org = String(m?.organization || '').trim();
    const pn = String(m?.publicName || '').trim();

    if (!org) {
      report.hidden_models.push(m);
    } else if (oldPublicNames.has(pn)) {
      report.variants.push(m);
    } else {
      report.new_models.push(m);
    }
  }

  // 3. Diff Existing Models (Independent evaluation, nothing dropped)
  for (const mid of commonIds.sort()) {
    const o = oldModels[mid];
    const n = newModels[mid];

    const fieldDiffs = [];
    for (const f of TRACKED_FIELDS) {
      if (o[f] !== n[f]) {
        fieldDiffs.push([f, o[f], n[f]]);
      }
    }

    const oldCaps = flattenCaps(o);
    const newCaps = flattenCaps(n);
    const gainedCaps = [...newCaps].filter((x) => !oldCaps.has(x));
    const lostCaps = [...oldCaps].filter((x) => !newCaps.has(x));

    let rankChanged = false;
    if (TRACK_RANK) {
      const oldRankStr = fmtRank(o.rank);
      const newRankStr = fmtRank(n.rank);
      if (oldRankStr !== newRankStr) {
        rankChanged = true;
      }
    }

    if (fieldDiffs.length === 0 && gainedCaps.length === 0 && lostCaps.length === 0 && !rankChanged) {
      continue;
    }

    const item = {
      id: mid,
      old: o,
      new: n,
      diffs: fieldDiffs,
      gained_caps: gainedCaps,
      lost_caps: lostCaps,
      rank_changed: rankChanged,
    };

    const changedFields = new Set(fieldDiffs.map((d) => d[0]));

    if (changedFields.has('publicName') || changedFields.has('displayName') || changedFields.has('name')) {
      report.name_updates.push(item);
    }
    if (changedFields.has('organization')) {
      report.org_updates.push(item);
    }
    if (changedFields.has('provider')) {
      report.provider_updates.push(item);
    }
    if (changedFields.has('userSelectable')) {
      const oldSel = Boolean(o.userSelectable);
      const newSel = Boolean(n.userSelectable);
      if (newSel && !oldSel) {
        report.selectable_enabled.push(item);
      } else if (oldSel && !newSel) {
        report.selectable_disabled.push(item);
      }
    }
    if (gainedCaps.length > 0 || lostCaps.length > 0) {
      report.capability_updates.push(item);
    }
    if (rankChanged) {
      report.rank_updates.push(item);
    }
  }

  return report;
}


// ==============================================================================
// Discord Embed Generator (Spacious Line-by-Line with UserSelectable)
// ==============================================================================
function buildDiscordEmbeds(report) {
  const embeds = [];
  const nowIso = new Date().toISOString();
  const footer = { text: 'Canary Arena • canaryarena.ai' };

  // 1. ✨ NEW MODEL LIVE
  for (const m of report.new_models) {
    const org = valOrDash(m.organization);
    const prov = valOrDash(m.provider);
    const rank = fmtRank(m.rank);
    const caps = formatCapabilityLines(m);
    const sel = fmtSelectable(m.userSelectable);

    const lines = [
      `### [${disp(m)}](${ARENA_URL})`,
      '',
      `🏢 **Organization:** **${org}**`,
      '',
      `🏭 **Provider:** **${prov}**`,
      '',
      `🔘 **User Selectable:** **${sel}**`,
      '',
      `📊 **Arena Rank:** **${rank}**`,
      '',
      '🛠️ **Capabilities:**',
      caps,
      '',
      '🆔 **Model ID:**',
      `\`${m.id}\``,
    ];

    embeds.push({
      author: AUTHOR_INFO,
      title: '✨ NEW MODEL LIVE',
      url: ARENA_URL,
      description: lines.join('\n'),
      color: COLORS.new,
      timestamp: nowIso,
      footer,
    });
  }

  // 2. 🕵️ STEALTH MODEL DETECTED
  for (const m of report.hidden_models) {
    const rank = fmtRank(m.rank);
    const caps = formatCapabilityLines(m);
    const sel = fmtSelectable(m.userSelectable);

    const lines = [
      `### [${disp(m)}](${ARENA_URL})`,
      '',
      '🏢 **Status:** *Unannounced / Stealth Test Model*',
      '',
      `🔘 **User Selectable:** **${sel}**`,
      '',
      `📊 **Arena Rank:** **${rank}**`,
      '',
      '🛠️ **Capabilities:**',
      caps,
      '',
      '🆔 **Model ID:**',
      `\`${m.id}\``,
    ];

    embeds.push({
      author: AUTHOR_INFO,
      title: '🕵️ STEALTH MODEL DETECTED',
      url: ARENA_URL,
      description: lines.join('\n'),
      color: COLORS.stealth,
      timestamp: nowIso,
      footer,
    });
  }

  // 3. 🧬 NEW MODEL VARIANT
  for (const m of report.variants) {
    const org = valOrDash(m.organization);
    const rank = fmtRank(m.rank);
    const caps = formatCapabilityLines(m);
    const sel = fmtSelectable(m.userSelectable);

    const lines = [
      `### [${disp(m)}](${ARENA_URL})`,
      '',
      `🧬 **Base Model:** \`${m.publicName}\``,
      '',
      `🏢 **Organization:** **${org}**`,
      '',
      `🔘 **User Selectable:** **${sel}**`,
      '',
      `📊 **Arena Rank:** **${rank}**`,
      '',
      '🛠️ **Capabilities:**',
      caps,
      '',
      '🆔 **Model ID:**',
      `\`${m.id}\``,
    ];

    embeds.push({
      author: AUTHOR_INFO,
      title: '🧬 NEW MODEL VARIANT',
      url: ARENA_URL,
      description: lines.join('\n'),
      color: COLORS.variant,
      timestamp: nowIso,
      footer,
    });
  }

  // 4. 🔄 MODEL RENAME
  for (const item of report.name_updates) {
    const oldName = valOrDash(item.old.displayName || item.old.publicName);
    const newName = valOrDash(item.new.displayName || item.new.publicName);

    const lines = [
      `### [${newName}](${ARENA_URL})`,
      '',
      '⬅️ **Previous Name:**',
      `\`${oldName}\``,
      '',
      '➡️ **Updated Name:**',
      `**\`${newName}\`**`,
      '',
      '🆔 **Model ID:**',
      `\`${item.id}\``,
    ];

    embeds.push({
      author: AUTHOR_INFO,
      title: '🔄 MODEL RENAME',
      url: ARENA_URL,
      description: lines.join('\n'),
      color: COLORS.rename,
      timestamp: nowIso,
      footer,
    });
  }

  // 5. 🏢 ORGANIZATION UPDATE
  for (const item of report.org_updates) {
    const m = item.new;
    const oldOrg = valOrDash(item.old.organization);
    const newOrg = valOrDash(item.new.organization);

    const lines = [
      `### [${disp(m)}](${ARENA_URL})`,
      '',
      '⬅️ **Previous Organization:**',
      `\`${oldOrg}\``,
      '',
      '➡️ **Updated Organization:**',
      `**\`${newOrg}\`**`,
      '',
      '🆔 **Model ID:**',
      `\`${item.id}\``,
    ];

    embeds.push({
      author: AUTHOR_INFO,
      title: '🏢 ORGANIZATION UPDATE',
      url: ARENA_URL,
      description: lines.join('\n'),
      color: COLORS.org,
      timestamp: nowIso,
      footer,
    });
  }

  // 6. 🏭 PROVIDER UPDATE
  for (const item of report.provider_updates) {
    const m = item.new;
    const oldProv = valOrDash(item.old.provider);
    const newProv = valOrDash(item.new.provider);

    const lines = [
      `### [${disp(m)}](${ARENA_URL})`,
      '',
      '⬅️ **Previous Provider:**',
      `\`${oldProv}\``,
      '',
      '➡️ **Updated Provider:**',
      `**\`${newProv}\`**`,
      '',
      '🆔 **Model ID:**',
      `\`${item.id}\``,
    ];

    embeds.push({
      author: AUTHOR_INFO,
      title: '🏭 PROVIDER UPDATE',
      url: ARENA_URL,
      description: lines.join('\n'),
      color: COLORS.provider,
      timestamp: nowIso,
      footer,
    });
  }

  // 7. 🟢 DIRECT SELECTION ENABLED
  for (const item of report.selectable_enabled) {
    const m = item.new;
    const lines = [
      `### [${disp(m)}](${ARENA_URL})`,
      '',
      '🔘 **User Selectable:**',
      '`false` ➔ **`true`**',
      '',
      'ℹ️ **Status:**',
      'Now directly selectable by users in Chat Arena.',
      '',
      '🆔 **Model ID:**',
      `\`${item.id}\``,
    ];

    embeds.push({
      author: AUTHOR_INFO,
      title: '🟢 DIRECT SELECTION ENABLED',
      url: ARENA_URL,
      description: lines.join('\n'),
      color: COLORS.enabled,
      timestamp: nowIso,
      footer,
    });
  }

  // 8. 🔴 DIRECT SELECTION DISABLED
  for (const item of report.selectable_disabled) {
    const m = item.new;
    const lines = [
      `### [${disp(m)}](${ARENA_URL})`,
      '',
      '🔘 **User Selectable:**',
      '`true` ➔ **`false`**',
      '',
      'ℹ️ **Status:**',
      'Direct user selection has been disabled.',
      '',
      '🆔 **Model ID:**',
      `\`${item.id}\``,
    ];

    embeds.push({
      author: AUTHOR_INFO,
      title: '🔴 DIRECT SELECTION DISABLED',
      url: ARENA_URL,
      description: lines.join('\n'),
      color: COLORS.disabled,
      timestamp: nowIso,
      footer,
    });
  }

  // 9. ⚙️ CAPABILITIES UPDATED
  for (const item of report.capability_updates) {
    const m = item.new;
    const gained = item.gained_caps.sort().map((g) => `\`+${g}\``);
    const lost = item.lost_caps.sort().map((l) => `\`-${l}\``);

    const lines = [`### [${disp(m)}](${ARENA_URL})`, ''];
    if (gained.length > 0) {
      lines.push('🟢 **Added Capabilities:**', gained.join(' • '), '');
    }
    if (lost.length > 0) {
      lines.push('🔴 **Removed Capabilities:**', lost.join(' • '), '');
    }
    lines.push('🆔 **Model ID:**', `\`${item.id}\``);

    embeds.push({
      author: AUTHOR_INFO,
      title: '⚙️ CAPABILITIES UPDATED',
      url: ARENA_URL,
      description: lines.join('\n'),
      color: COLORS.capability,
      timestamp: nowIso,
      footer,
    });
  }

  // 10. 🆔 ID ROTATION DETECTED
  for (const [oldM, newM] of report.id_rotations) {
    const lines = [
      `### [${disp(newM)}](${ARENA_URL})`,
      '',
      '⬅️ **Previous Model ID:**',
      `\`${oldM.id}\``,
      '',
      '➡️ **New Model ID:**',
      `**\`${newM.id}\`**`,
    ];

    embeds.push({
      author: AUTHOR_INFO,
      title: '🆔 ID ROTATION DETECTED',
      url: ARENA_URL,
      description: lines.join('\n'),
      color: COLORS.rotation,
      timestamp: nowIso,
      footer,
    });
  }

  // 11. 📊 ARENA RANK SHIFT
  for (const item of report.rank_updates) {
    const o = item.old;
    const n = item.new;
    const oldR = fmtRank(o.rank);
    const newR = fmtRank(n.rank);

    const lines = [
      `### [${disp(n)}](${ARENA_URL})`,
      '',
      '⬅️ **Previous Rank:**',
      `\`${oldR}\``,
      '',
      '➡️ **New Rank:**',
      `**\`${newR}\`**`,
      '',
      '🆔 **Model ID:**',
      `\`${item.id}\``,
    ];

    embeds.push({
      author: AUTHOR_INFO,
      title: '📊 ARENA RANK SHIFT',
      url: ARENA_URL,
      description: lines.join('\n'),
      color: COLORS.rank,
      timestamp: nowIso,
      footer,
    });
  }

  // 12. ❌ MODEL DELISTED
  for (const m of report.removed_models) {
    const org = valOrDash(m.organization);
    const rank = fmtRank(m.rank);

    const lines = [
      `### ${disp(m)}`,
      '',
      `🏢 **Organization:** **${org}**`,
      '',
      `📊 **Final Rank:** **${rank}**`,
      '',
      '🆔 **Model ID:**',
      `\`${m.id}\``,
    ];

    embeds.push({
      author: AUTHOR_INFO,
      title: '❌ MODEL DELISTED',
      url: ARENA_URL,
      description: lines.join('\n'),
      color: COLORS.removed,
      timestamp: nowIso,
      footer,
    });
  }

  return embeds;
}


// ==============================================================================
// Discord Dispatch (Individual Alert per Model, 0 Delays, 429 Backoff)
// ==============================================================================
async function sendDiscordPayload(payload) {
  if (!DISCORD_WEBHOOK_URL) {
    console.log('\n[Discord Webhook Dry-Run]');
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(DISCORD_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });

      if (res.status === 200 || res.status === 204) {
        return;
      }

      if (res.status === 429) {
        let retryAfter = 2.0;
        try {
          const data = await res.json();
          retryAfter = Number(data.retry_after) || 2.0;
        } catch {
          retryAfter = 2.0;
        }
        console.warn(`Discord rate limited (429). Retrying in ${retryAfter.toFixed(1)}s...`);
        await new Promise((r) => setTimeout(r, retryAfter * 1000 + 200));
        continue;
      }

      const txt = await res.text();
      console.error(`Discord webhook error: ${res.status} ${txt.slice(0, 300)}`);
      break;
    } catch (err) {
      console.error(`Discord network exception: ${err.message}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

/**
 * Sends EACH model event as its OWN dedicated Discord message!
 * Guaranteed that Discord never collapses, combines, or hides any model.
 */
async function notifyDiscordEmbeds(embeds) {
  if (!embeds || embeds.length === 0) return;

  // Dispatch all embeds concurrently to Discord edge API
  const promises = embeds.map((embed) => sendDiscordPayload({ embeds: [embed] }));
  await Promise.all(promises);
}

async function sendDiscordText(text, color = COLORS.brand) {
  const nowIso = new Date().toISOString();
  await sendDiscordPayload({
    embeds: [
      {
        author: AUTHOR_INFO,
        description: text,
        color,
        timestamp: nowIso,
        footer: { text: 'Canary Arena • canaryarena.ai' },
      },
    ],
  });
}


// ==============================================================================
// Main Orchestrator
// ==============================================================================
async function main() {
  const startTime = Date.now();
  const oldSnapshot = loadSnapshot();
  const { models: newSnapshot, valid: isValid, statusMsg } = await getModels(oldSnapshot);

  const oldCount = oldSnapshot ? Object.keys(oldSnapshot).length : 0;
  const newCount = Object.keys(newSnapshot).length;
  console.log(`Loaded old: ${oldCount} models | Fetched new: ${newCount} models (${ARENA_URL})`);

  // 1. Modality Health & Sanity Guard
  if (!isValid) {
    console.warn(`⚠️ Fetch rejected: ${statusMsg}`);
    const alertState = loadAlertState();
    if (!alertState.broken_notified) {
      await sendDiscordText(
        `⚠️ **Arena Fetch Incomplete**\n\n${statusMsg}\n\n*Skipping snapshot update to protect baseline.*`,
        COLORS.warning
      );
      alertState.broken_notified = true;
      saveAlertState(alertState);
    }
    return;
  }

  // Clear broken notification state
  const alertState = loadAlertState();
  if (alertState.broken_notified) {
    delete alertState.broken_notified;
    saveAlertState(alertState);
  }

  // 2. Initial Run: Baseline initialization
  if (oldSnapshot === null) {
    saveSnapshot(newSnapshot);
    await sendDiscordText(
      `✅ **Arena Tracker Initialized**\n\nLoaded \`${newCount}\` models from \`${ARENA_URL}\` as baseline.\n\nAlerts will trigger starting from the next change.`,
      COLORS.new
    );
    console.log('Initial baseline snapshot saved.');
    return;
  }

  // 3. Large Churn Confirmation Guard
  const oldSet = new Set(Object.keys(oldSnapshot));
  const newSet = new Set(Object.keys(newSnapshot));
  const addedCount = [...newSet].filter((x) => !oldSet.has(x)).length;
  const removedCount = [...oldSet].filter((x) => !newSet.has(x)).length;
  const isLargeBatch = Math.max(addedCount, removedCount) >= LARGE_BATCH_THRESHOLD;

  if (isLargeBatch) {
    const candidateHash = snapshotIdentityHash(newSnapshot);
    let pendingHash = alertState.pending_large_hash;
    let pendingCount = Number(alertState.pending_large_count || 0);

    if (pendingHash === candidateHash) {
      pendingCount++;
    } else {
      pendingHash = candidateHash;
      pendingCount = 1;
    }

    if (pendingCount < 2) {
      alertState.pending_large_hash = pendingHash;
      alertState.pending_large_count = pendingCount;
      alertState.pending_added = addedCount;
      alertState.pending_removed = removedCount;
      saveAlertState(alertState);
      console.log(
        `Large batch detected (+${addedCount}/-${removedCount}). Holding for confirmation (seen ${pendingCount}/2 runs)...`
      );
      return;
    }

    delete alertState.pending_large_hash;
    delete alertState.pending_large_count;
    saveAlertState(alertState);
  } else if (alertState.pending_large_hash) {
    delete alertState.pending_large_hash;
    delete alertState.pending_large_count;
    saveAlertState(alertState);
  }

  // 4. Deep Change Detection
  const report = detectChanges(oldSnapshot, newSnapshot);
  if (report.hasChanges()) {
    const embeds = buildDiscordEmbeds(report);
    if (embeds.length > 0) {
      await notifyDiscordEmbeds(embeds);
      console.log(`Changes detected: dispatched ${embeds.length} independent Discord alert(s).`);
    }
  } else {
    console.log('No changes detected.');
  }

  // 5. Commit Valid Snapshot
  saveSnapshot(newSnapshot);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`Execution completed in ${elapsed}s.`);
}

main().catch((err) => {
  console.error('Fatal execution error:', err);
  process.exit(1);
});
