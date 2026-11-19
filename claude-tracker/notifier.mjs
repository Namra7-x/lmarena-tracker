/**
 * Claude Model Catalog Notifier
 * Formats rich alert cards for Discord (the GitHub commits channel) and Telegram (Anthropic/Claude topic).
 */

import { CLAUDE_CONFIG } from './config.mjs';
import { TelegramClient } from '../reverse-tracker/telegram/client.mjs';

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Builds a sleek Discord embed matching the early-radar SDK commit channel aesthetic.
 */
export function buildClaudeDiscordEmbed(diff, catalog) {
  const versionHeader = diff.previousVersion && diff.previousVersion !== diff.currentVersion
    ? `v${diff.previousVersion} → v${diff.currentVersion}`
    : `v${diff.currentVersion}`;

  const title = diff.newModels.length > 0
    ? `⚡ Claude Model Catalog | ${diff.newModels.length} New Model(s) Discovered!`
    : `⚡ Claude Model Catalog | Catalog Update (${versionHeader})`;

  const fields = [
    {
      name: '📋 Catalog Version',
      value: `**${versionHeader}** (${catalog.totalModels} total models)`,
      inline: true,
    },
    {
      name: '🕒 Issued At',
      value: `\`${catalog.issuedAt || 'N/A'}\``,
      inline: true,
    },
    {
      name: '🔑 Signing Key',
      value: `\`${catalog.keyId || 'N/A'}\``,
      inline: true,
    },
  ];

  // 1. New Models
  if (diff.newModels.length > 0) {
    for (const m of diff.newModels.slice(0, 5)) {
      const details = [];
      if (m.family) details.push(`**Family:** \`${m.family}\``);
      if (m.maxInputTokens && m.maxOutputTokens) {
        details.push(`**Context:** ${m.maxInputTokens.toLocaleString()} in / ${m.maxOutputTokens.toLocaleString()} out`);
      }
      if (m.effortLevels?.length > 0) {
        details.push(`**Thinking:** \`${m.effortLevels.join(', ')}\``);
      }
      if (m.capabilities?.length > 0) {
        details.push(`**Capabilities:** \`${m.capabilities.join(', ')}\``);
      }
      if (m.surfaces?.length > 0) {
        details.push(`**Surfaces:** \`${m.surfaces.join(', ')}\``);
      }
      if (m.offeredOn?.length > 0) {
        details.push(`**Providers:** \`${m.offeredOn.join(', ')}\``);
      }
      if (m.minClaudeCodeVersion) {
        details.push(`**Min CC Ver:** \`${m.minClaudeCodeVersion}\``);
      }
      if (m.voiceModel) {
        details.push(`**Voice Model:** \`${m.voiceModel}\``);
      }

      fields.push({
        name: `🔥 New Model: ${m.name} (\`${m.id}\`)`,
        value: details.join('\n') || 'Model metadata available in catalog.',
        inline: false,
      });
    }

    // Include Raw Specs for the primary new model
    const primaryNew = diff.newModels[0];
    const rawJsonStr = JSON.stringify(primaryNew.rawSpecs || primaryNew, null, 2);
    fields.push({
      name: `📦 Model Specs Preview (${primaryNew.id})`,
      value: `\`\`\`json\n${rawJsonStr.slice(0, 950)}\n\`\`\``,
      inline: false,
    });
  }

  // 2. Spec Changes
  if (diff.specChanges.length > 0) {
    const preview = diff.specChanges.slice(0, 4).map((sc) => {
      return `• **${sc.name}** (\`${sc.id}\`):\n  ${sc.changes.map((c) => `→ ${c}`).join('\n  ')}`;
    }).join('\n');

    fields.push({
      name: '📈 Model Spec Upgrades & Property Changes',
      value: preview.slice(0, 1024),
      inline: false,
    });
  }

  // 3. Surface Default Changes
  if (diff.surfaceDefaultChanges.length > 0) {
    const preview = diff.surfaceDefaultChanges.map((sd) => {
      return `• **${sd.surface.toUpperCase()} Surface:** \`${sd.previous}\` → **\`${sd.current}\`**`;
    }).join('\n');

    fields.push({
      name: '🎛️ Active Surface Default Changes',
      value: preview,
      inline: false,
    });
  }

  // 4. Provider Alias Target Changes
  if (diff.aliasTargetChanges.length > 0) {
    const preview = diff.aliasTargetChanges.map((at) => {
      const prov = at.provider === 'default' ? 'Default' : at.provider;
      return `• **${at.alias} (${prov}):** \`${at.previous}\` → **\`${at.current}\`**`;
    }).join('\n');

    fields.push({
      name: '🎯 Provider Alias Target Shifts',
      value: preview,
      inline: false,
    });
  }

  // Quick Links
  fields.push({
    name: '🔗 Official Catalog Endpoints',
    value: [
      `• **[Live Model Catalog JSON](${CLAUDE_CONFIG.endpoint})**`,
      `• **[Model Catalog Schema JSON](${CLAUDE_CONFIG.schemaUrl})**`,
    ].join('\n'),
    inline: false,
  });

  return {
    title,
    url: CLAUDE_CONFIG.endpoint,
    description: `Real-time model catalog signal published by Anthropic vestibule!`,
    color: CLAUDE_CONFIG.color,
    fields,
    footer: { text: 'downloads.claude.ai • Ground-Zero Model Catalog Radar' },
    timestamp: catalog.issuedAt || new Date().toISOString(),
  };
}

/**
 * Formats a high-impact, clean HTML message for Telegram (< 4000 chars).
 */
export function formatClaudeTelegramSummary(diff, catalog) {
  const versionHeader = diff.previousVersion && diff.previousVersion !== diff.currentVersion
    ? `v${diff.previousVersion} → v${diff.currentVersion}`
    : `v${diff.currentVersion}`;

  const header = diff.newModels.length > 0
    ? `🚨 <b>CLAUDE MODEL CATALOG: NEW MODEL DISCOVERED!</b>`
    : `⚡ <b>CLAUDE MODEL CATALOG UPDATE (${versionHeader})</b>`;

  const lines = [
    header,
    `<blockquote><b>Catalog Version:</b> ${versionHeader} (${catalog.totalModels} models)</blockquote>`,
    `<b>Issued:</b> <code>${escapeHtml(catalog.issuedAt || 'N/A')}</code>`,
    `<b>Endpoint:</b> <code>downloads.claude.ai/model-catalog/v1/catalog.json</code>`,
    '',
  ];

  // 1. New Models
  if (diff.newModels.length > 0) {
    lines.push(`🆕 <b>New Model(s) Added:</b>`);
    for (const m of diff.newModels) {
      lines.push(`• <b>${escapeHtml(m.name)}</b> (<code>${escapeHtml(m.id)}</code>)`);
      if (m.family) lines.push(`  - <b>Family:</b> <code>${escapeHtml(m.family)}</code>`);
      if (m.maxInputTokens && m.maxOutputTokens) {
        lines.push(`  - <b>Context:</b> ${m.maxInputTokens.toLocaleString()} in / ${m.maxOutputTokens.toLocaleString()} out`);
      }
      if (m.effortLevels?.length > 0) {
        lines.push(`  - <b>Thinking:</b> <code>${escapeHtml(m.effortLevels.join(', '))}</code>`);
      }
      if (m.capabilities?.length > 0) {
        lines.push(`  - <b>Capabilities:</b> <code>${escapeHtml(m.capabilities.join(', '))}</code>`);
      }
      if (m.surfaces?.length > 0) {
        lines.push(`  - <b>Surfaces:</b> <code>${escapeHtml(m.surfaces.join(', '))}</code>`);
      }
      if (m.offeredOn?.length > 0) {
        lines.push(`  - <b>Providers:</b> <code>${escapeHtml(m.offeredOn.join(', '))}</code>`);
      }
      if (m.minClaudeCodeVersion) {
        lines.push(`  - <b>Min Claude Code:</b> <code>${escapeHtml(m.minClaudeCodeVersion)}</code>`);
      }
      if (m.voiceModel) {
        lines.push(`  - <b>Voice Model:</b> <code>${escapeHtml(m.voiceModel)}</code>`);
      }
      lines.push('');
    }
  }

  // 2. Spec Changes
  if (diff.specChanges.length > 0) {
    lines.push(`📈 <b>Model Spec Upgrades:</b>`);
    for (const sc of diff.specChanges.slice(0, 5)) {
      lines.push(`• <b>${escapeHtml(sc.name)}</b> (<code>${escapeHtml(sc.id)}</code>):`);
      for (const c of sc.changes) {
        lines.push(`  → ${escapeHtml(c)}`);
      }
    }
    lines.push('');
  }

  // 3. Surface Defaults
  if (diff.surfaceDefaultChanges.length > 0) {
    lines.push(`🎛️ <b>Surface Default Shifts:</b>`);
    for (const sd of diff.surfaceDefaultChanges) {
      lines.push(`• <code>${escapeHtml(sd.surface)}</code>: <code>${escapeHtml(sd.previous)}</code> → <b>${escapeHtml(sd.current)}</b>`);
    }
    lines.push('');
  } else if (catalog.surfaceDefaults) {
    lines.push(`📊 <b>Current Surface Defaults:</b>`);
    for (const [surf, defModel] of Object.entries(catalog.surfaceDefaults)) {
      lines.push(`• <code>${escapeHtml(surf)}</code>: <b>${escapeHtml(defModel)}</b>`);
    }
    lines.push('');
  }

  // 4. Provider Aliases
  if (diff.aliasTargetChanges.length > 0) {
    lines.push(`🎯 <b>Provider Alias Target Shifts:</b>`);
    for (const at of diff.aliasTargetChanges) {
      lines.push(`• <code>${escapeHtml(at.alias)}</code> (${escapeHtml(at.provider)}): <code>${escapeHtml(at.previous)}</code> → <b>${escapeHtml(at.current)}</b>`);
    }
    lines.push('');
  }

  let text = lines.join('\n');
  if (text.length > 3900) {
    text = text.slice(0, 3850) + '\n\n<i>[Truncated to fit Telegram limits]</i>';
  }

  return text;
}

/**
 * Sends embeds to Discord via webhook.
 */
async function sendDiscordWebhook(url, embed) {
  const body = {
    username: 'Claude Catalog Radar',
    avatar_url: 'https://cdn.oaistatic.com/_next/static/media/apple-touch-icon.82af6fe1.png',
    embeds: [embed],
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    throw new Error(`Discord returned HTTP ${res.status}`);
  }
}

/**
 * Dispatches alerts to both Discord (GitHub commits channel) and Telegram (Claude/Anthropic topic).
 */
export async function sendCatalogAlerts(diff, catalog, options = {}) {
  const results = { discord: false, telegram: false, errors: [] };

  // 1. Resolve Discord Webhook
  let webhookUrl = options.webhookUrl || null;
  if (!webhookUrl) {
    for (const envVar of CLAUDE_CONFIG.webhookEnvVars) {
      const val = process.env[envVar]?.trim();
      if (val && val.startsWith('https://discord.com/api/webhooks/')) {
        webhookUrl = val;
        break;
      }
    }
  }

  // 2. Deliver to Discord
  if (webhookUrl) {
    try {
      const embed = buildClaudeDiscordEmbed(diff, catalog);
      await sendDiscordWebhook(webhookUrl, embed);
      results.discord = true;
      console.log(`[Claude Catalog] ✓ Alert embed delivered to Discord (${CLAUDE_CONFIG.webhookEnvVars[0] || 'webhook'}).`);
    } catch (err) {
      results.errors.push(`Discord error: ${err.message}`);
      console.warn(`[Claude Catalog] ⚠️ Discord delivery warning: ${err.message}`);
    }
  } else {
    console.log(`[Claude Catalog] Notice: No Discord webhook configured. Skipping Discord.`);
  }

  // 3. Deliver to Telegram
  const tgClient = new TelegramClient(null, null, CLAUDE_CONFIG.family, CLAUDE_CONFIG.componentId);
  const topicId = tgClient.getTopicId(CLAUDE_CONFIG.family, CLAUDE_CONFIG.componentId);

  if (tgClient.isConfigured() || options.forceAlert) {
    try {
      const summaryText = formatClaudeTelegramSummary(diff, catalog);
      await tgClient.sendMessage(summaryText, { topicId });
      results.telegram = true;
      console.log(`[Claude Catalog] ✓ Alert message delivered to Telegram (family: ${CLAUDE_CONFIG.family}, topic: ${topicId || 'main'}).`);
    } catch (err) {
      results.errors.push(`Telegram error: ${err.message}`);
      console.warn(`[Claude Catalog] ⚠️ Telegram delivery warning: ${err.message}`);
    }
  } else {
    console.log(`[Claude Catalog] Notice: Telegram not configured for ${CLAUDE_CONFIG.family}. Skipping Telegram.`);
  }

  return results;
}
