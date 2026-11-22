/**
 * Leak Tracker — Discord Webhook Notifier
 * Formats clean, rich embed cards with correct headings, direct links, and proper channel routing.
 */

import { LEAK_CONFIG } from './config.mjs';

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
 */
export async function sendDiscordWebhook(channelType, payload) {
  const webhookUrl = getWebhookUrl(channelType);
  if (!webhookUrl) {
    console.warn(`[Leak Tracker] No webhook configured for channel '${channelType}'. Skipping alert.`);
    return false;
  }

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      console.warn(`[Leak Tracker] Discord webhook error (${channelType}): HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[Leak Tracker] Failed to dispatch webhook (${channelType}):`, err.message);
    return false;
  }
}

// ==========================================
// CHANNEL 1: Early Model Tracker / Qwen Embeds
// ==========================================

export function buildGcpSkuEmbed(skus) {
  const count = skus.length;
  const fields = skus.slice(0, 8).map((s) => ({
    name: `🏷️ ${s.category} • \`${s.skuId}\``,
    value: `**Description:** ${s.description}\n**Service:** \`${s.service}\` (Matched filter: \`${s.filter}\`)`,
    inline: false,
  }));

  if (count > 8) {
    fields.push({
      name: '➕ More SKUs',
      value: `*...and ${count - 8} more billing SKUs detected.*`,
      inline: false,
    });
  }

  return {
    title: `☁️ Google Cloud SKU — New Model Billing Lines Detected (${count})`,
    description: `Google Cloud has staged **${count} new billing SKU(s)**. Billing lines frequently appear in financial systems weeks before marketing announcements.`,
    url: 'https://cloud.google.com/skus',
    color: LEAK_CONFIG.colors.google,
    fields,
    footer: { text: 'Source: Google Cloud Billing Catalog (Anonymous API) • Early Model Tracker' },
    timestamp: new Date().toISOString(),
  };
}

export function buildAzureFoundryEmbed(models) {
  const count = models.length;
  const fields = models.slice(0, 8).map((m) => ({
    name: `🔥 ${m.displayName || m.name} (\`v${m.version}\`)`,
    value: `**Publisher:** \`${m.publisher}\` • **Status:** \`${m.lifecycleStatus}\`\n**Registry:** \`${m.registry}\`${m.createdTime ? `\n**Created:** \`${m.createdTime}\`` : ''}`,
    inline: false,
  }));

  if (count > 8) {
    fields.push({
      name: '➕ More Models',
      value: `*...and ${count - 8} more models added to Azure AI Foundry.*`,
      inline: false,
    });
  }

  return {
    title: `🔷 Azure AI Foundry — New Model(s) Deployed (${count})`,
    description: `Microsoft staged **${count} new model(s)** in the Azure AI Foundry Asset Catalog.`,
    url: 'https://ai.azure.com/explore/models',
    color: LEAK_CONFIG.colors.azure,
    fields,
    footer: { text: 'Source: Azure AI Foundry Asset Gallery API • Early Model Tracker' },
    timestamp: new Date().toISOString(),
  };
}

export function buildAwsBedrockMasterEmbed(newProducts, version) {
  const count = newProducts.length;
  const fields = newProducts.slice(0, 8).map((p) => ({
    name: `🏷️ ${p.modelName} (\`${p.sku}\`)`,
    value: `**Provider:** \`${p.provider}\`${p.usagetype ? `\n**Usage Type:** \`${p.usagetype}\`` : ''}${p.operation ? ` • **Op:** \`${p.operation}\`` : ''}`,
    inline: false,
  }));

  if (count > 8) {
    fields.push({
      name: '➕ More Bedrock Products',
      value: `*...and ${count - 8} more models detected in AWS Bedrock master pricing index.*`,
      inline: false,
    });
  }

  return {
    title: `🟧 AWS Bedrock (Master) — New Model Pricing Detected (${count})`,
    description: `AWS published pricing metadata for **${count} new model product(s)** (Grok, Kimi, MiniMax, Nemotron, Nova) in feed version \`${version}\`.`,
    url: 'https://aws.amazon.com/bedrock/pricing/',
    color: LEAK_CONFIG.colors.aws,
    fields,
    footer: { text: 'Source: AWS Bedrock Master Pricing Index • Early Model Tracker' },
    timestamp: new Date().toISOString(),
  };
}

export function buildAzureRetailPricesEmbed(skus) {
  const count = skus.length;
  const fields = skus.slice(0, 8).map((s) => ({
    name: `🏷️ [${s.feedName || 'Retail'}] ${s.productName} — ${s.skuName}`,
    value: `**Retail Price:** \`$${s.retailPrice} / ${s.unitOfMeasure}\`${s.effectiveStartDate ? `\n**Effective Date:** \`${s.effectiveStartDate}\`` : ''}`,
    inline: false,
  }));

  if (count > 8) {
    fields.push({
      name: '➕ More Azure Retail SKUs',
      value: `*...and ${count - 8} more retail pricing rows.*`,
      inline: false,
    });
  }

  return {
    title: `🔷 Azure Retail Prices — New AI Model SKU Listed (${count})`,
    description: `Microsoft listed **${count} new retail price line(s)** across Foundry Models and Azure OpenAI feeds.`,
    url: 'https://azure.microsoft.com/en-us/pricing/details/cognitive-services/',
    color: LEAK_CONFIG.colors.azure,
    fields,
    footer: { text: 'Source: Azure Retail Prices API • Early Model Tracker' },
    timestamp: new Date().toISOString(),
  };
}

export function buildGoogleVertexPricingEmbed(newModels) {
  return {
    title: `☁️ Google Vertex AI Pricing Table — Pre-Staged Model(s) Detected (${newModels.length})`,
    description: `Google's official Vertex AI pricing web page HTML has pre-staged table anchor links for unannounced models:`,
    url: 'https://cloud.google.com/vertex-ai/generative-ai/pricing',
    color: LEAK_CONFIG.colors.google,
    fields: [
      {
        name: 'Detected Models in Web HTML Table',
        value: newModels.map((m) => `• \`${m}\``).join('\n'),
        inline: false,
      },
    ],
    footer: { text: 'Source: cloud.google.com/vertex-ai/generative-ai/pricing • Early Model Tracker' },
    timestamp: new Date().toISOString(),
  };
}

export function buildAwsOffersIndexEmbed(newOffers) {
  return {
    title: `🟧 AWS Pricing Index — New Service Offer Code Registered (${newOffers.length})`,
    description: `AWS added **${newOffers.length} new service offer code(s)** to the global pricing index:`,
    url: 'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/index.json',
    color: LEAK_CONFIG.colors.aws,
    fields: [
      {
        name: 'New Service Offer Codes',
        value: newOffers.map((o) => `• \`${o}\``).join('\n'),
        inline: false,
      },
    ],
    footer: { text: 'Source: AWS Global Pricing Index • Early Model Tracker' },
    timestamp: new Date().toISOString(),
  };
}

export function buildJumpstartProprietaryEmbed(models) {
  const count = models.length;
  const fields = models.slice(0, 8).map((m) => ({
    name: `📦 ${m.modelId} (\`v${m.version}\`)`,
    value: `**Min SDK Version:** \`${m.minVersion || 'None'}\`\n**Spec Key:** \`${m.specKey || 'N/A'}\``,
    inline: false,
  }));

  return {
    title: `🟧 AWS SageMaker JumpStart — New Proprietary Model Manifest (${count})`,
    description: `AWS JumpStart added **${count} new proprietary model deployment manifest(s)**.`,
    url: 'https://aws.amazon.com/sagemaker/jumpstart/',
    color: LEAK_CONFIG.colors.aws,
    fields,
    footer: { text: 'Source: AWS JumpStart S3 Manifest Cache • Early Model Tracker' },
    timestamp: new Date().toISOString(),
  };
}

// ==========================================
// CHANNEL 2: GitHub Commits & Analysis Embeds
// ==========================================

export function buildAnthropicPythonSdkEmbed(newModels) {
  return {
    title: `⚡ Anthropic Python SDK — New Model Type Union(s) Detected (${newModels.length})`,
    description: `Anthropic engineers updated the literal model type union in \`anthropic-sdk-python\` before public announcement:`,
    url: 'https://github.com/anthropics/anthropic-sdk-python/blob/main/src/anthropic/types/model.py',
    color: LEAK_CONFIG.colors.anthropic,
    fields: [
      {
        name: '🔥 New Model Identifiers in SDK Type Union',
        value: newModels.map((m) => `• \`${m}\``).join('\n'),
        inline: false,
      },
    ],
    footer: { text: 'Source: anthropics/anthropic-sdk-python (model.py) • GitHub Commits & Analysis' },
    timestamp: new Date().toISOString(),
  };
}

export function buildGoogleGenaiPythonEmbed(newModels) {
  return {
    title: `🔷 Google GenAI Python SDK — New Model Identifier(s) Detected (${newModels.length})`,
    description: `Google pushed new model type definitions to \`google-genai\` Python SDK:`,
    url: 'https://github.com/googleapis/python-genai/blob/main/google/genai/types.py',
    color: LEAK_CONFIG.colors.google,
    fields: [
      {
        name: 'New Model Identifiers in SDK Types',
        value: newModels.map((m) => `• \`${m}\``).join('\n'),
        inline: false,
      },
    ],
    footer: { text: 'Source: googleapis/python-genai (types.py) • GitHub Commits & Analysis' },
    timestamp: new Date().toISOString(),
  };
}

export function buildOpenaiCodexEmbed(models) {
  const count = models.length;
  const fields = models.slice(0, 8).map((m) => ({
    name: `🔥 Model Slug: \`${m.slug}\``,
    value: `**WebSockets:** \`${m.preferWebsockets}\` • **Verbosity:** \`${m.defaultVerbosity}\`${m.applyPatchToolType ? `\n**Patch Tool:** \`${m.applyPatchToolType}\`` : ''}`,
    inline: false,
  }));

  return {
    title: `🟢 OpenAI Codex — New Internal Model Staged (${count})`,
    description: `OpenAI pushed **${count} new model slug(s)** to the internal Codex Rust client manager.`,
    url: 'https://github.com/openai/codex/blob/main/codex-rs/models-manager/models.json',
    color: LEAK_CONFIG.colors.codex,
    fields,
    footer: { text: 'Source: openai/codex (models.json) • GitHub Commits & Analysis' },
    timestamp: new Date().toISOString(),
  };
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

export function buildOpenaiOpenapiEmbed(newEnums, version) {
  return {
    title: `🟢 OpenAI API Spec — New Model Identifier(s) Added (${newEnums.length})`,
    description: `The OpenAI OpenAPI schema (v\`${version}\`) added new model enum entries:`,
    url: 'https://github.com/openai/openai-openapi/blob/main/openapi.yaml',
    color: LEAK_CONFIG.colors.openai,
    fields: [
      {
        name: 'Added Model Enums',
        value: newEnums.map((e) => `• \`${e}\``).join('\n'),
        inline: false,
      },
    ],
    footer: { text: 'Source: openai/openai-openapi (openapi.yaml) • GitHub Commits & Analysis' },
    timestamp: new Date().toISOString(),
  };
}
