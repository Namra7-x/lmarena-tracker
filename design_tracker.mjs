#!/usr/bin/env node
/**
 * DesignArena Registry Tracker — Native Node.js Edition
 * Diffs https://www.designarena.ai/api/registry and alerts Discord instantly.
 */

import fs from 'node:fs';

const URL = 'https://www.designarena.ai/api/registry';
const SNAPSHOT = 'design_snapshot.json';

const DISCORD_WEBHOOK_URL = (
  process.env.DISCORD_WEBHOOK_URL ||
  process.env.DISCORD_WEBHOOK ||
  ''
).trim();

async function fetchRegistry() {
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    Accept: 'application/json',
  };

  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(URL, { headers, signal: AbortSignal.timeout(15000) });
      if (res.ok) {
        const data = await res.json();
        if (data && typeof data === 'object' && data.models) {
          return data;
        }
      }
    } catch (err) {
      console.warn(`Attempt ${attempt} failed: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('Failed to fetch DesignArena registry');
}

function normModels(raw = {}) {
  const out = {};
  for (const [mid, m] of Object.entries(raw)) {
    const arenas = m?.arenas || {};
    const normArenas = {};
    for (const [k, v] of Object.entries(arenas)) {
      if (Array.isArray(v)) normArenas[k] = [...v].sort();
    }
    out[mid] = {
      displayName: m?.displayName || mid,
      provider: m?.provider || null,
      active: Boolean(m?.active),
      openSource: Boolean(m?.openSource),
      router: Boolean(m?.router),
      vision: Boolean(m?.vision),
      inputModalities: [...(m?.inputModalities || [])].sort(),
      arenas: normArenas,
    };
  }
  return out;
}

function normProviders(raw = {}) {
  const out = {};
  for (const [pid, p] of Object.entries(raw)) {
    out[pid] = p?.displayName || pid;
  }
  return out;
}

function normPricing(raw = {}) {
  const out = {};
  for (const [mid, cats] of Object.entries(raw)) {
    const flat = {};
    for (const [cat, fields] of Object.entries(cats || {})) {
      for (const [k, v] of Object.entries(fields || {})) {
        flat[`${cat}.${k}`] = v;
      }
    }
    if (Object.keys(flat).length > 0) out[mid] = flat;
  }
  return out;
}

function loadSnapshot() {
  if (!fs.existsSync(SNAPSHOT)) return null;
  try {
    return JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
  } catch {
    return null;
  }
}

function saveSnapshot(models, providers, pricing) {
  fs.writeFileSync(
    SNAPSHOT,
    JSON.stringify({ models, providers, pricing }, null, 2) + '\n',
    'utf8'
  );
}

function diff(oldData, newData) {
  const om = oldData.models || {};
  const nm = newData.models || {};
  const op = oldData.providers || {};
  const np = newData.providers || {};
  const opz = oldData.pricing || {};
  const npz = newData.pricing || {};

  const d = {
    added: [],
    removed: [],
    renamed: [],
    provider: [],
    active_on: [],
    active_off: [],
    categories: [],
    caps: [],
    new_providers: [],
    price_new: [],
    price_changed: [],
  };

  const oldMids = new Set(Object.keys(om));
  const newMids = new Set(Object.keys(nm));

  for (const mid of [...newMids].filter((x) => !oldMids.has(x)).sort()) {
    const m = nm[mid];
    const catList = Object.entries(m.arenas).map(([k, v]) => `${k}: ${v.join(', ')}`).join(' • ') || 'none';
    d.added.push([mid, m, catList]);
  }

  for (const mid of [...oldMids].filter((x) => !newMids.has(x)).sort()) {
    d.removed.push([mid, om[mid]]);
  }

  for (const mid of [...oldMids].filter((x) => newMids.has(x)).sort()) {
    const o = om[mid];
    const n = nm[mid];

    if (o.displayName !== n.displayName) {
      d.renamed.push([mid, o.displayName, n.displayName]);
    }
    if (o.active !== n.active) {
      (n.active ? d.active_on : d.active_off).push([mid, n.displayName]);
    }

    // Categories
    const allCats = new Set([...Object.keys(o.arenas), ...Object.keys(n.arenas)]);
    const catChanges = [];
    for (const cat of allCats) {
      const oSet = new Set(o.arenas[cat] || []);
      const nSet = new Set(n.arenas[cat] || []);
      const added = [...nSet].filter((x) => !oSet.has(x));
      const removed = [...oSet].filter((x) => !nSet.has(x));
      if (added.length > 0) catChanges.push(`➕ ${cat}: ${added.join(', ')}`);
      if (removed.length > 0) catChanges.push(`➖ ${cat}: ${removed.join(', ')}`);
    }
    if (catChanges.length > 0) {
      d.categories.push([mid, n.displayName, catChanges]);
    }

    // Capabilities
    const capChanges = [];
    for (const f of ['openSource', 'router', 'vision']) {
      if (o[f] !== n[f]) capChanges.push(`${f}: ${o[f]} ➔ ${n[f]}`);
    }
    if (o.inputModalities.join(',') !== n.inputModalities.join(',')) {
      capChanges.push(`inputModalities: ${o.inputModalities.join(', ') || 'none'} ➔ ${n.inputModalities.join(', ') || 'none'}`);
    }
    if (capChanges.length > 0) {
      d.caps.push([mid, n.displayName, capChanges]);
    }
  }

  for (const pid of Object.keys(np).filter((x) => !op[x])) {
    d.new_providers.push([pid, np[pid]]);
  }

  for (const mid of Object.keys(npz).filter((x) => !opz[x])) {
    d.price_new.push([mid, npz[mid]]);
  }
  for (const mid of Object.keys(npz).filter((x) => opz[x])) {
    const changes = [];
    const allK = new Set([...Object.keys(npz[mid]), ...Object.keys(opz[mid])]);
    for (const k of allK) {
      if (opz[mid][k] !== npz[mid][k]) {
        changes.push(`${k}: ${opz[mid][k]} ➔ ${npz[mid][k]}`);
      }
    }
    if (changes.length > 0) d.price_changed.push([mid, changes]);
  }

  return d;
}

function hasChanges(d) {
  return Object.values(d).some((arr) => arr.length > 0);
}

function buildMessage(d) {
  const now = new Date().toUTCString();
  const lines = [`🎨 DesignArena Tracker — ${now}`, ''];

  function section(title, items, render) {
    if (!items || items.length === 0) return;
    lines.push(`${title} (${items.length})`);
    for (const it of items.slice(0, 15)) {
      lines.push(...render(it));
    }
    lines.push('');
  }

  section('🆕 New models', d.added, (it) => [
    `• ${it[1].displayName} (\`${it[0]}\`)`,
    `  Provider: ${it[1].provider} | Active: ${it[1].active ? '✅' : '❌'} | Open Source: ${it[1].openSource ? '✅' : '❌'}`,
    `  Categories: ${it[2]}`,
  ]);
  section('❌ Removed models', d.removed, (it) => [
    `• ${it[1].displayName} (\`${it[0]}\`) — Provider: ${it[1].provider}`,
  ]);
  section('✏️ Name updates', d.renamed, (it) => [
    `• ${it[1]} ➔ **${it[2]}** (\`${it[0]}\`)`,
  ]);
  section('🏢 Provider updates', d.provider, (it) => [
    `• ${it[1]} (\`${it[0]}\`): ${it[2]} ➔ **${it[3]}**`,
  ]);
  section('🟢 Activated (now live)', d.active_on, (it) => [
    `• ${it[1]} (\`${it[0]}\`)`,
  ]);
  section('🔴 Deactivated (pulled)', d.active_off, (it) => [
    `• ${it[1]} (\`${it[0]}\`)`,
  ]);
  section('🏟️ Category updates', d.categories, (it) => [
    `• ${it[1]} (\`${it[0]}\`)`,
    ...it[2].map((c) => `  ${c}`),
  ]);
  section('⚡ Capability updates', d.caps, (it) => [
    `• ${it[1]} (\`${it[0]}\`)`,
    ...it[2].map((c) => `  ${c}`),
  ]);

  return lines.join('\n').trim();
}

async function notifyDiscord(msg) {
  if (!DISCORD_WEBHOOK_URL) return;
  const payload = {
    embeds: [
      {
        title: '🎨 DesignArena Tracker Update',
        description: msg.slice(0, 4000),
        color: 0x9b59b6,
        timestamp: new Date().toISOString(),
        footer: { text: 'DesignArena Tracker • designarena.ai' },
      },
    ],
  };

  try {
    await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error('DesignArena discord error:', err.message);
  }
}

async function main() {
  const old = loadSnapshot();
  const data = await fetchRegistry();
  const newModels = normModels(data.models);
  const newProviders = normProviders(data.providers);
  const newPricing = normPricing(data.pricing);

  console.log(`Design models: ${Object.keys(newModels).length}, providers: ${Object.keys(newProviders).length}`);

  if (old === null) {
    saveSnapshot(newModels, newProviders, newPricing);
    console.log('Design baseline saved.');
    return;
  }

  const d = diff(old, { models: newModels, providers: newProviders, pricing: newPricing });
  if (!hasChanges(d)) {
    console.log('DesignArena: no changes.');
    return;
  }

  const msg = buildMessage(d);
  await notifyDiscord(msg);
  saveSnapshot(newModels, newProviders, newPricing);
  console.log('DesignArena snapshot updated.');
}

main().catch((err) => {
  console.error('DesignArena error:', err);
  process.exit(1);
});

