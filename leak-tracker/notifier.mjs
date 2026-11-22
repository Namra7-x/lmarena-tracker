/**
 * Leak Tracker — Discord Webhook Notifier
 * Formats clean, rich embed cards with correct headings, direct links, and proper channel routing.
 * Uses Multi-Embed Paging (Strategy A) to deliver 100% of detected models/SKUs without truncation.
 */

import { LEAK_CONFIG } from './config.mjs';

export const CHUNK_SIZE = 15;

/**
 * Splits an array into chunks of the given size.
 */
export function chunkArray(items, size = CHUNK_SIZE) {
  if (!items || items.length === 0) return [];
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Decorates an array of embeds with the first embed's properties
 * for 100% backward compatibility with test assertions (e.g. embed.title, embed.fields).
 */
function decorateEmbeds(embeds) {
  if (!embeds || embeds.length === 0) return [];
  embeds.title = embeds[0].title;
  embeds.color = embeds[0].color;
  embeds.fields = embeds[0].fields;
  embeds.description = embeds[0].description;
  embeds.url = embeds[0].url;
  return embeds;
}

/**
 * Resolves the active webhook URL from environment variables for a given channel key.
 */
export function getWebhookUrl(channelType = 'earlyModel') {
  const envVars = LEAK_CONFIG.channels[channelType] || LEAK_CONFIG.channels.earlyModel;
  for (const varName of envVars) {
    if (process.env[varName]) {
      return process.env[varName];
    }
  }
  return null;
}

/**
 * Sends a payload to the resolved Discord webhook.
 * Automatically handles multi-embed arrays and chunks into batches of up to 10 embeds per message.
 */
export async function sendDiscordWebhook(channelType, payload) {
  const webhookUrl = getWebhookUrl(channelType);
  if (!webhookUrl) {
    console.warn(`[Leak Tracker] No webhook configured for channel '${channelType}'. Skipping alert.`);
    return false;
  }

  let rawEmbeds = [];
  if (Array.isArray(payload)) {
    rawEmbeds = payload;
  } else if (payload && payload.embeds) {
    rawEmbeds = payload.embeds;
  }

  const flatEmbeds = rawEmbeds.flat(Infinity).filter(Boolean);

  if (flatEmbeds.length === 0) {
    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return res.ok;
    } catch (err) {
      console.warn(`[Leak Tracker] Failed to dispatch webhook (${channelType}):`, err.message);
      return false;
    }
  }

  let allSuccess = true;
  for (let i = 0; i < flatEmbeds.length; i += 10) {
    const chunk = flatEmbeds.slice(i, i + 10);
    const postBody = {
      ...(typeof payload === 'object' && !Array.isArray(payload) ? payload : {}),
      embeds: chunk,
    };

    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(postBody),
      });

      if (!res.ok) {
        console.warn(`[Leak Tracker] Discord webhook error (${channelType}): HTTP ${res.status}`);
        allSuccess = false;
      }
    } catch (err) {
      console.warn(`[Leak Tracker] Failed to dispatch webhook (${channelType}):`, err.message);
      allSuccess = false;
    }

    if (i + 10 < flatEmbeds.length) {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  return allSuccess;
}

// ==========================================
// CHANNEL 1: Early Model Tracker / Qwen Embeds
// ==========================================

export function buildGcpSkuEmbeds(skus) {
  const count = skus.length;
  if (count === 0) return [];

  const chunks = chunkArray(skus, CHUNK_SIZE);
  const totalParts = chunks.length;

  return chunks.map((chunk, index) => {
    const partNum = index + 1;
    const partSuffix = totalParts > 1 ? ` [Part ${partNum}/${totalParts}]` : '';

    const fields = chunk.map((s) => ({
      name: `🏷️ ${s.category} • \`${s.skuId}\``,
      value: `**Description:** ${s.description}\n**Service:** \`${s.service}\` (Matched filter: \`${s.filter}\`)`,
      inline: false,
    }));

    return {
      title: `☁️ Google Cloud SKU — New Model Billing Lines Detected (${count})${partSuffix}`,
      description: partNum === 1
        ? `Google Cloud has staged **${count} new billing SKU(s)**. Billing lines frequently appear in financial systems weeks before marketing announcements.`
        : `*Continued from Part ${partNum - 1} (${chunk.length} SKUs in this embed)*`,
      url: 'https://cloud.google.com/skus',
      color: LEAK_CONFIG.colors.google,
      fields,
      footer: { text: `Source: Google Cloud Billing Catalog (Anonymous API) • Early Model Tracker${totalParts > 1 ? ` • Part ${partNum} of ${totalParts}` : ''}` },
      timestamp: new Date().toISOString(),
    };
  });
}

export function buildGcpSkuEmbed(skus) {
  return decorateEmbeds(buildGcpSkuEmbeds(skus));
}

export function buildAzureFoundryEmbeds(models) {
  const count = models.length;
  if (count === 0) return [];

  const chunks = chunkArray(models, CHUNK_SIZE);
  const totalParts = chunks.length;

  return chunks.map((chunk, index) => {
    const partNum = index + 1;
    const partSuffix = totalParts > 1 ? ` [Part ${partNum}/${totalParts}]` : '';

    const fields = chunk.map((m) => ({
      name: `🔥 ${m.displayName || m.name} (\`v${m.version}\`)`,
      value: `**Publisher:** \`${m.publisher}\` • **Status:** \`${m.lifecycleStatus}\`\n**Registry:** \`${m.registry}\`${m.createdTime ? `\n**Created:** \`${m.createdTime}\`` : ''}`,
      inline: false,
    }));

    return {
      title: `🔷 Azure AI Foundry — New Model(s) Deployed (${count})${partSuffix}`,
      description: partNum === 1
        ? `Microsoft staged **${count} new model(s)** in the Azure AI Foundry Asset Catalog.`
        : `*Continued from Part ${partNum - 1} (${chunk.length} models in this embed)*`,
      url: 'https://ai.azure.com/explore/models',
      color: LEAK_CONFIG.colors.azure,
      fields,
      footer: { text: `Source: Azure AI Foundry Asset Gallery API • Early Model Tracker${totalParts > 1 ? ` • Part ${partNum} of ${totalParts}` : ''}` },
      timestamp: new Date().toISOString(),
    };
  });
}

export function buildAzureFoundryEmbed(models) {
  return decorateEmbeds(buildAzureFoundryEmbeds(models));
}

export function buildAwsBedrockMasterEmbeds(newProducts, version) {
  const count = newProducts.length;
  if (count === 0) return [];

  const chunks = chunkArray(newProducts, CHUNK_SIZE);
  const totalParts = chunks.length;

  return chunks.map((chunk, index) => {
    const partNum = index + 1;
    const partSuffix = totalParts > 1 ? ` [Part ${partNum}/${totalParts}]` : '';

    const fields = chunk.map((p) => ({
      name: `🏷️ ${p.modelName} (\`${p.sku}\`)`,
      value: `**Provider:** \`${p.provider}\`${p.usagetype ? `\n**Usage Type:** \`${p.usagetype}\`` : ''}${p.operation ? ` • **Op:** \`${p.operation}\`` : ''}`,
      inline: false,
    }));

    return {
      title: `🟧 AWS Bedrock (Master) — New Model Pricing Detected (${count})${partSuffix}`,
      description: partNum === 1
        ? `AWS published pricing metadata for **${count} new model product(s)** (Grok, Kimi, MiniMax, Nemotron, Nova) in feed version \`${version}\`.`
        : `*Continued from Part ${partNum - 1} (${chunk.length} models in this embed)*`,
      url: 'https://aws.amazon.com/bedrock/pricing/',
      color: LEAK_CONFIG.colors.aws,
      fields,
      footer: { text: `Source: AWS Bedrock Master Pricing Index • Early Model Tracker${totalParts > 1 ? ` • Part ${partNum} of ${totalParts}` : ''}` },
      timestamp: new Date().toISOString(),
    };
  });
}

export function buildAwsBedrockMasterEmbed(newProducts, version) {
  return decorateEmbeds(buildAwsBedrockMasterEmbeds(newProducts, version));
}

export function buildAzureRetailPricesEmbeds(skus) {
  const count = skus.length;
  if (count === 0) return [];

  const chunks = chunkArray(skus, CHUNK_SIZE);
  const totalParts = chunks.length;

  return chunks.map((chunk, index) => {
    const partNum = index + 1;
    const partSuffix = totalParts > 1 ? ` [Part ${partNum}/${totalParts}]` : '';

    const fields = chunk.map((s) => ({
      name: `🏷️ [${s.feedName || 'Retail'}] ${s.productName} — ${s.skuName}`,
      value: `**Retail Price:** \`$${s.retailPrice} / ${s.unitOfMeasure}\`${s.effectiveStartDate ? `\n**Effective Date:** \`${s.effectiveStartDate}\`` : ''}`,
      inline: false,
    }));

    return {
      title: `🔷 Azure Retail Prices — New AI Model SKU Listed (${count})${partSuffix}`,
      description: partNum === 1
        ? `Microsoft listed **${count} new retail price line(s)** across Foundry Models and Azure OpenAI feeds.`
        : `*Continued from Part ${partNum - 1} (${chunk.length} SKUs in this embed)*`,
      url: 'https://azure.microsoft.com/en-us/pricing/details/cognitive-services/',
      color: LEAK_CONFIG.colors.azure,
      fields,
      footer: { text: `Source: Azure Retail Prices API • Early Model Tracker${totalParts > 1 ? ` • Part ${partNum} of ${totalParts}` : ''}` },
      timestamp: new Date().toISOString(),
    };
  });
}

export function buildAzureRetailPricesEmbed(skus) {
  return decorateEmbeds(buildAzureRetailPricesEmbeds(skus));
}

export function buildGoogleVertexPricingEmbeds(newModels) {
  const count = newModels.length;
  if (count === 0) return [];

  const chunks = chunkArray(newModels, 25);
  const totalParts = chunks.length;

  return chunks.map((chunk, index) => {
    const partNum = index + 1;
    const partSuffix = totalParts > 1 ? ` [Part ${partNum}/${totalParts}]` : '';

    return {
      title: `☁️ Google Vertex AI Pricing Table — Pre-Staged Model(s) Detected (${count})${partSuffix}`,
      description: partNum === 1
        ? `Google's official Vertex AI pricing web page HTML has pre-staged table anchor links for unannounced models:`
        : `*Continued from Part ${partNum - 1} (${chunk.length} models in this embed)*`,
      url: 'https://cloud.google.com/vertex-ai/generative-ai/pricing',
      color: LEAK_CONFIG.colors.google,
      fields: [
        {
          name: `Detected Models in Web HTML Table (${chunk.length})`,
          value: chunk.map((m) => `• \`${m}\``).join('\n'),
          inline: false,
        },
      ],
      footer: { text: `Source: cloud.google.com/vertex-ai/generative-ai/pricing • Early Model Tracker${totalParts > 1 ? ` • Part ${partNum} of ${totalParts}` : ''}` },
      timestamp: new Date().toISOString(),
    };
  });
}

export function buildGoogleVertexPricingEmbed(newModels) {
  return decorateEmbeds(buildGoogleVertexPricingEmbeds(newModels));
}

export function buildAwsOffersIndexEmbeds(newOffers) {
  const count = newOffers.length;
  if (count === 0) return [];

  const chunks = chunkArray(newOffers, 25);
  const totalParts = chunks.length;

  return chunks.map((chunk, index) => {
    const partNum = index + 1;
    const partSuffix = totalParts > 1 ? ` [Part ${partNum}/${totalParts}]` : '';

    return {
      title: `🟧 AWS Pricing Index — New Service Offer Code Registered (${count})${partSuffix}`,
      description: partNum === 1
        ? `AWS added **${count} new service offer code(s)** to the global pricing index:`
        : `*Continued from Part ${partNum - 1} (${chunk.length} offer codes in this embed)*`,
      url: 'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/index.json',
      color: LEAK_CONFIG.colors.aws,
      fields: [
        {
          name: `New Service Offer Codes (${chunk.length})`,
          value: chunk.map((o) => `• \`${o}\``).join('\n'),
          inline: false,
        },
      ],
      footer: { text: `Source: AWS Global Pricing Index • Early Model Tracker${totalParts > 1 ? ` • Part ${partNum} of ${totalParts}` : ''}` },
      timestamp: new Date().toISOString(),
    };
  });
}

export function buildAwsOffersIndexEmbed(newOffers) {
  return decorateEmbeds(buildAwsOffersIndexEmbeds(newOffers));
}

export function buildJumpstartProprietaryEmbeds(models) {
  const count = models.length;
  if (count === 0) return [];

  const chunks = chunkArray(models, CHUNK_SIZE);
  const totalParts = chunks.length;

  return chunks.map((chunk, index) => {
    const partNum = index + 1;
    const partSuffix = totalParts > 1 ? ` [Part ${partNum}/${totalParts}]` : '';

    const fields = chunk.map((m) => ({
      name: `📦 ${m.modelId} (\`v${m.version}\`)`,
      value: `**Min SDK Version:** \`${m.minVersion || 'None'}\`\n**Spec Key:** \`${m.specKey || 'N/A'}\``,
      inline: false,
    }));

    return {
      title: `🟧 AWS SageMaker JumpStart — New Proprietary Model Manifest (${count})${partSuffix}`,
      description: partNum === 1
        ? `AWS JumpStart added **${count} new proprietary model deployment manifest(s)**.`
        : `*Continued from Part ${partNum - 1} (${chunk.length} models in this embed)*`,
      url: 'https://aws.amazon.com/sagemaker/jumpstart/',
      color: LEAK_CONFIG.colors.aws,
      fields,
      footer: { text: `Source: AWS JumpStart S3 Manifest Cache • Early Model Tracker${totalParts > 1 ? ` • Part ${partNum} of ${totalParts}` : ''}` },
      timestamp: new Date().toISOString(),
    };
  });
}

export function buildJumpstartProprietaryEmbed(models) {
  return decorateEmbeds(buildJumpstartProprietaryEmbeds(models));
}

// ==========================================
// CHANNEL 2: GitHub Commits & Analysis Embeds
// ==========================================

export function buildAnthropicPythonSdkEmbeds(newModels) {
  const count = newModels.length;
  if (count === 0) return [];

  const chunks = chunkArray(newModels, 25);
  const totalParts = chunks.length;

  return chunks.map((chunk, index) => {
    const partNum = index + 1;
    const partSuffix = totalParts > 1 ? ` [Part ${partNum}/${totalParts}]` : '';

    return {
      title: `⚡ Anthropic Python SDK — New Model Type Union(s) Detected (${count})${partSuffix}`,
      description: partNum === 1
        ? `Anthropic engineers updated the literal model type union in \`anthropic-sdk-python\` before public announcement:`
        : `*Continued from Part ${partNum - 1} (${chunk.length} models in this embed)*`,
      url: 'https://github.com/anthropics/anthropic-sdk-python/blob/main/src/anthropic/types/model.py',
      color: LEAK_CONFIG.colors.anthropic,
      fields: [
        {
          name: `🔥 New Model Identifiers in SDK Type Union (${chunk.length})`,
          value: chunk.map((m) => `• \`${m}\``).join('\n'),
          inline: false,
        },
      ],
      footer: { text: `Source: anthropics/anthropic-sdk-python (model.py) • GitHub Commits & Analysis${totalParts > 1 ? ` • Part ${partNum} of ${totalParts}` : ''}` },
      timestamp: new Date().toISOString(),
    };
  });
}

export function buildAnthropicPythonSdkEmbed(newModels) {
  return decorateEmbeds(buildAnthropicPythonSdkEmbeds(newModels));
}

export function buildGoogleGenaiPythonEmbeds(newModels) {
  const count = newModels.length;
  if (count === 0) return [];

  const chunks = chunkArray(newModels, 25);
  const totalParts = chunks.length;

  return chunks.map((chunk, index) => {
    const partNum = index + 1;
    const partSuffix = totalParts > 1 ? ` [Part ${partNum}/${totalParts}]` : '';

    return {
      title: `🔷 Google GenAI Python SDK — New Model Identifier(s) Detected (${count})${partSuffix}`,
      description: partNum === 1
        ? `Google pushed new model type definitions to \`google-genai\` Python SDK:`
        : `*Continued from Part ${partNum - 1} (${chunk.length} models in this embed)*`,
      url: 'https://github.com/googleapis/python-genai/blob/main/google/genai/types.py',
      color: LEAK_CONFIG.colors.google,
      fields: [
        {
          name: `New Model Identifiers in SDK Types (${chunk.length})`,
          value: chunk.map((m) => `• \`${m}\``).join('\n'),
          inline: false,
        },
      ],
      footer: { text: `Source: googleapis/python-genai (types.py) • GitHub Commits & Analysis${totalParts > 1 ? ` • Part ${partNum} of ${totalParts}` : ''}` },
      timestamp: new Date().toISOString(),
    };
  });
}

export function buildGoogleGenaiPythonEmbed(newModels) {
  return decorateEmbeds(buildGoogleGenaiPythonEmbeds(newModels));
}

export function buildOpenaiCodexEmbeds(models) {
  const count = models.length;
  if (count === 0) return [];

  const chunks = chunkArray(models, CHUNK_SIZE);
  const totalParts = chunks.length;

  return chunks.map((chunk, index) => {
    const partNum = index + 1;
    const partSuffix = totalParts > 1 ? ` [Part ${partNum}/${totalParts}]` : '';

    const fields = chunk.map((m) => ({
      name: `🔥 Model Slug: \`${m.slug}\``,
      value: `**WebSockets:** \`${m.preferWebsockets}\` • **Verbosity:** \`${m.defaultVerbosity}\`${m.applyPatchToolType ? `\n**Patch Tool:** \`${m.applyPatchToolType}\`` : ''}`,
      inline: false,
    }));

    return {
      title: `🟢 OpenAI Codex — New Internal Model Staged (${count})${partSuffix}`,
      description: partNum === 1
        ? `OpenAI pushed **${count} new model slug(s)** to the internal Codex Rust client manager.`
        : `*Continued from Part ${partNum - 1} (${chunk.length} models in this embed)*`,
      url: 'https://github.com/openai/codex/blob/main/codex-rs/models-manager/models.json',
      color: LEAK_CONFIG.colors.codex,
      fields,
      footer: { text: `Source: openai/codex (models.json) • GitHub Commits & Analysis${totalParts > 1 ? ` • Part ${partNum} of ${totalParts}` : ''}` },
      timestamp: new Date().toISOString(),
    };
  });
}

export function buildOpenaiCodexEmbed(models) {
  return decorateEmbeds(buildOpenaiCodexEmbeds(models));
}

export function buildOpenaiCommitEmbed(commit) {
  return {
    title: `🟢 OpenAI OpenAPI — New Schema Commit`,
    description: `**${commit.title}**`,
    url: commit.link || 'https://github.com/openai/openai-openapi/commits/main',
    color: LEAK_CONFIG.colors.openai,
    fields: [
      { name: 'Commit ID', value: `\`${commit.id.split('/').pop()}\``, inline: true },
      { name: 'Author', value: commit.author || 'OpenAI Engineer', inline: true },
      { name: 'Committed At', value: `\`${commit.updated || 'Recent'}\``, inline: true },
    ],
    footer: { text: 'Source: openai/openai-openapi (commits/main.atom) • GitHub Commits & Analysis' },
    timestamp: new Date().toISOString(),
  };
}

export function buildOpenaiOpenapiEmbeds(newEnums, version) {
  const count = newEnums.length;
  if (count === 0) return [];

  const chunks = chunkArray(newEnums, 25);
  const totalParts = chunks.length;

  return chunks.map((chunk, index) => {
    const partNum = index + 1;
    const partSuffix = totalParts > 1 ? ` [Part ${partNum}/${totalParts}]` : '';

    return {
      title: `🟢 OpenAI API Spec — New Model Identifier(s) Added (${count})${partSuffix}`,
      description: partNum === 1
        ? `The OpenAI OpenAPI schema (v\`${version}\`) added new model enum entries:`
        : `*Continued from Part ${partNum - 1} (${chunk.length} enums in this embed)*`,
      url: 'https://github.com/openai/openai-openapi/blob/main/openapi.yaml',
      color: LEAK_CONFIG.colors.openai,
      fields: [
        {
          name: `Added Model Enums (${chunk.length})`,
          value: chunk.map((e) => `• \`${e}\``).join('\n'),
          inline: false,
        },
      ],
      footer: { text: `Source: openai/openai-openapi (openapi.yaml) • GitHub Commits & Analysis${totalParts > 1 ? ` • Part ${partNum} of ${totalParts}` : ''}` },
      timestamp: new Date().toISOString(),
    };
  });
}

export function buildOpenaiOpenapiEmbed(newEnums, version) {
  return decorateEmbeds(buildOpenaiOpenapiEmbeds(newEnums, version));
}
