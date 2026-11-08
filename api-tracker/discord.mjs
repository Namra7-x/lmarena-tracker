/**
 * Qwen Cloud Discord Webhook Notifier
 * Formats rich embed cards with model specs, pricing tables, context limits, and logos.
 */

import { QWEN_CONFIG } from './config.mjs';

/**
 * Resolves an image URL suitable for Discord embeds (must be raster like PNG/JPG/WebP, not SVG).
 */
function resolveIconUrl(providerIconUrl) {
  if (providerIconUrl && (providerIconUrl.endsWith('.png') || providerIconUrl.endsWith('.jpg') || providerIconUrl.endsWith('.webp'))) {
    return providerIconUrl;
  }
  return QWEN_CONFIG.qwenAvatar;
}

/**
 * Builds embed for a newly added model.
 */
export function buildNewModelEmbed(model) {
  const iconUrl = resolveIconUrl(model.providerIconUrl);
  const portalUrl = model.modelPortalUrl;

  const fields = [
    {
      name: '🏷️ Model Identifier',
      value: `\`${model.modelId}\``,
      inline: true,
    },
    {
      name: '🏢 Provider & Category',
      value: `\`${model.provider}\` • \`${model.category || 'General'}\``,
      inline: true,
    },
  ];

  if (model.capabilities && model.capabilities.length > 0) {
    fields.push({
      name: '🧠 Capabilities',
      value: model.capabilities.map((c) => `\`${c}\``).join(' '),
      inline: true,
    });
  }

  // Modalities
  const reqMod = model.inferenceMetadata?.requestModality?.join(', ') || 'Text';
  const resMod = model.inferenceMetadata?.responseModality?.join(', ') || 'Text';
  fields.push({
    name: '🎛️ Modalities',
    value: `**In:** ${reqMod} ➔ **Out:** ${resMod}`,
    inline: true,
  });

  // Context & Token Limits
  const ctx = model.modelInfo?.contextWindow;
  const maxIn = model.modelInfo?.maxInputTokens;
  const maxOut = model.modelInfo?.maxOutputTokens;
  const maxReason = model.modelInfo?.maxReasoningTokens;

  const specParts = [];
  if (ctx) specParts.push(`**Context:** ${Number(ctx).toLocaleString()} tokens`);
  if (maxIn) specParts.push(`**Max Input:** ${Number(maxIn).toLocaleString()}`);
  if (maxOut) specParts.push(`**Max Output:** ${Number(maxOut).toLocaleString()}`);
  if (maxReason) specParts.push(`**Reasoning:** ${Number(maxReason).toLocaleString()}`);

  if (specParts.length > 0) {
    fields.push({
      name: '📊 Context & Token Limits',
      value: specParts.join(' | '),
      inline: false,
    });
  }

  // Pricing rows
  const pricing = model.pricing || {};
  const priceEntries = Object.entries(pricing);
  if (priceEntries.length > 0) {
    const priceLines = priceEntries.map(([k, v]) => `• **${k}:** \`${v}\``);
    fields.push({
      name: '💰 Pricing (Public API)',
      value: priceLines.slice(0, 10).join('\n'),
      inline: false,
    });
  }

  // Features
  if (model.features && model.features.length > 0) {
    fields.push({
      name: '⚡ Supported Features',
      value: model.features.map((f) => `\`${f}\``).join(' '),
      inline: false,
    });
  }

  // Quick Links
  const links = [`• [View Model on Qwen Cloud](${portalUrl})`];
  if (model.docUrl) {
    links.push(`• [API Documentation](${model.docUrl})`);
  }
  fields.push({
    name: '🔗 Links',
    value: links.join(' | '),
    inline: false,
  });

  return {
    title: `🆕 New Model Released: ${model.name}`,
    url: portalUrl,
    description: (model.shortDescription || model.description || 'New model indexed on Qwen Cloud').slice(0, 400),
    color: QWEN_CONFIG.colors.newModel,
    fields,
    thumbnail: { url: iconUrl },
    footer: { text: `Qwen Cloud Tracker • ${model.modelId}` },
    timestamp: new Date().toISOString(),
  };
}

/**
 * Builds embed for pricing changes.
 */
export function buildPriceChangeEmbed(change) {
  const { model, diffs } = change;
  const iconUrl = resolveIconUrl(model.providerIconUrl);
  const portalUrl = model.modelPortalUrl;

  const lines = diffs.map((d) => {
    if (d.type === 'CHANGED') {
      return `• **${d.key}:** ~~\`${d.oldVal}\`~~ ➔ **\`${d.newVal}\`**`;
    }
    if (d.type === 'ADDED') {
      return `• ➕ **${d.key}:** **\`${d.value}\`** (New Tier)`;
    }
    return `• ❌ **${d.key}:** ~~\`${d.value}\`~~ (Removed)`;
  });

  return {
    title: `💰 Pricing Updated: ${model.name}`,
    url: portalUrl,
    description: `Public pricing updated on Qwen Cloud for \`${model.modelId}\`:\n\n${lines.join('\n')}`,
    color: QWEN_CONFIG.colors.priceChange,
    fields: [
      {
        name: '🏢 Provider',
        value: `\`${model.provider}\``,
        inline: true,
      },
      {
        name: '🔗 Quick Link',
        value: `[View Model Pricing](${portalUrl})`,
        inline: true,
      },
    ],
    thumbnail: { url: iconUrl },
    footer: { text: 'Qwen Cloud Tracker • Pricing Canary' },
    timestamp: new Date().toISOString(),
  };
}

/**
 * Builds embed for context window / token limit changes.
 */
export function buildContextChangeEmbed(change) {
  const { model, diffs } = change;
  const iconUrl = resolveIconUrl(model.providerIconUrl);
  const portalUrl = model.modelPortalUrl;

  const lines = diffs.map((d) => {
    return `• **${d.field}:** ~~\`${Number(d.oldVal).toLocaleString()}\`~~ ➔ **\`${Number(d.newVal).toLocaleString()}\`** tokens`;
  });

  return {
    title: `⚡ Context / Limits Updated: ${model.name}`,
    url: portalUrl,
    description: `Token specifications updated for \`${model.modelId}\`:\n\n${lines.join('\n')}`,
    color: QWEN_CONFIG.colors.specChange,
    thumbnail: { url: iconUrl },
    footer: { text: 'Qwen Cloud Tracker • Token Specs' },
    timestamp: new Date().toISOString(),
  };
}

/**
 * Builds embed for removed/deprecated models.
 */
export function buildRemovedModelEmbed(model) {
  return {
    title: `❌ Model Removed / Deprecated: ${model.name || model.modelId}`,
    url: model.modelPortalUrl || `${QWEN_CONFIG.modelPortalBase}/${model.modelId}`,
    description: `\`${model.modelId}\` from \`${model.provider}\` is no longer returned in the Qwen Cloud foundation model catalog.`,
    color: QWEN_CONFIG.colors.removed,
    thumbnail: { url: QWEN_CONFIG.qwenAvatar },
    footer: { text: 'Qwen Cloud Tracker • Deprecation Notice' },
    timestamp: new Date().toISOString(),
  };
}

/**
 * Dispatches an array of embeds to the Discord webhook in batches of up to 10.
 */
export async function sendDiscordEmbeds(embeds, webhookUrl = null) {
  const url = (
    webhookUrl ||
    process.env.API_DISCORD_WEBHOOK_URL ||
    process.env.API_TRACKER_DISCORD_WEBHOOK_URL ||
    process.env.QWEN_DISCORD_WEBHOOK_URL ||
    process.env.DISCORD_WEBHOOK_URL ||
    ''
  ).trim();

  if (!url || !url.startsWith('https://discord.com/api/webhooks/')) {
    console.log('[Qwen Discord] No valid webhook URL configured. Running in audit/preview mode.');
    return { sent: 0, total: embeds.length };
  }

  const BATCH_SIZE = 10;
  let sentCount = 0;

  for (let i = 0; i < embeds.length; i += BATCH_SIZE) {
    const batch = embeds.slice(i, i + BATCH_SIZE);
    const payload = {
      username: 'API Tracker',
      avatar_url: QWEN_CONFIG.qwenAvatar,
      embeds: batch,
    };

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(QWEN_CONFIG.timeouts.discord),
      });

      if (!res.ok) {
        const errText = await res.text();
        console.warn(`[Qwen Discord] Webhook HTTP ${res.status}: ${errText}`);
      } else {
        sentCount += batch.length;
        console.log(`[Qwen Discord] Successfully delivered ${batch.length} embed(s) to Discord.`);
      }
    } catch (err) {
      console.warn(`[Qwen Discord] Webhook delivery error: ${err.message}`);
    }

    if (i + BATCH_SIZE < embeds.length) {
      await new Promise((r) => setTimeout(r, 600));
    }
  }

  return { sent: sentCount, total: embeds.length };
}
