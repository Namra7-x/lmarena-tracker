/**
 * Leak Tracker — Data Fetchers
 * Handles network requests, anti-hijack prefixes, XML atom parsing, and pagination.
 */

import { LEAK_CONFIG } from './config.mjs';

/**
 * Standard fetch helper with timeout and User-Agent.
 */
async function fetchSafe(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeout || LEAK_CONFIG.timeouts.fetch);

  const headers = {
    'User-Agent': LEAK_CONFIG.userAgent,
    Accept: '*/*',
    ...(options.headers || {}),
  };

  try {
    const res = await fetch(url, {
      ...options,
      headers,
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    return res;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 1. Google Cloud SKU Catalog Fetcher
 */
export async function fetchGcpSkus() {
  const allSkus = new Map();

  for (const item of LEAK_CONFIG.endpoints.gcpSkus) {
    try {
      const res = await fetchSafe(item.url);
      let text = await res.text();
      if (text.startsWith(")]}'")) {
        text = text.substring(text.indexOf('\n') + 1);
      }
      const data = JSON.parse(text);
      const groups = data.skus || [];
      for (const grp of groups) {
        const category = grp.category || 'General';
        const service = grp.cloud_service_id || 'GCP';
        for (const s of grp.skus || []) {
          if (s.sku_id && !allSkus.has(s.sku_id)) {
            allSkus.set(s.sku_id, {
              skuId: s.sku_id,
              description: s.description || 'Unknown SKU',
              category,
              service,
              filter: item.filter,
            });
          }
        }
      }
    } catch (err) {
      console.warn(`[Leak Tracker] GCP SKU filter '${item.filter}' failed:`, err.message);
    }
  }

  return Array.from(allSkus.values());
}

/**
 * 2. Azure AI Foundry Asset Catalog Fetcher
 */
export async function fetchAzureFoundryModels() {
  const body = JSON.stringify({
    order: [{ field: 'createdTime', direction: 'desc' }],
    pageSize: 50,
  });

  const res = await fetchSafe(LEAK_CONFIG.endpoints.azureFoundryModels, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  const data = await res.json();
  const summaries = data.summaries || [];

  return summaries.map((m) => ({
    name: m.name || m.displayName,
    version: m.version || 'latest',
    publisher: m.publisher || 'Unknown',
    lifecycleStatus: m.lifecycleStatus || 'Active',
    createdTime: m.createdTime || null,
    displayName: m.displayName || m.name,
    registry: m.registry || 'azureml',
  }));
}

/**
 * 3. AWS Bedrock Master Pricing Feed Fetcher (AmazonBedrock/current/index.json)
 * Leaks: Grok 4.7, Kimi K2/K3, MiniMax M2.5, Nemotron 3 Super, Nova 2.0
 */
export async function fetchAwsBedrockMaster() {
  const res = await fetchSafe(LEAK_CONFIG.endpoints.awsBedrockMaster);
  const data = await res.json();

  const version = data.version || 'unknown';
  const publicationDate = data.publicationDate || null;
  const products = [];

  if (data.products && typeof data.products === 'object') {
    for (const [sku, p] of Object.entries(data.products)) {
      const attrs = p.attributes || {};
      const modelName = attrs.model || attrs.modelName || attrs.description || sku;
      products.push({
        sku,
        modelName,
        provider: attrs.providerName || attrs.provider || 'Bedrock Provider',
        usagetype: attrs.usagetype || '',
        operation: attrs.operation || '',
      });
    }
  }

  return {
    version,
    publicationDate,
    products,
  };
}

const AI_MODEL_PATTERNS = [
  /\b(?:gpt[0-9.-]*|o[1-9][0-9.-]*|chatgpt|dall-e|sora|whisper|codex|mai|phi|deepseek|grok|llama|mistral|qwen|claude|gemini|flux|nemotron|nova|jina|cohere|voyage|kimi|minimax|bcv)\b/i,
  /\b(?:embed|embedding|realtime|reasoning|thinking|vision|audio|transcribe|image-generation|token|prompt|completion|fine-tuning|inference)\b/i,
];

const NOISE_NON_MODEL_PATTERNS = [
  /\b(?:spell[\s-]?check|emotion|form[\s-]?recognizer|custom[\s-]?speech|speaker[\s-]?identification|content[\s-]?moderator|anomaly[\s-]?detector|intelligent[\s-]?recommendations|video[\s-]?indexer|immersive[\s-]?reader|health[\s-]?bot|face|container|hardware[\s-]?accelerated|mainframe|production[\s-]?web[\s-]?api)\b/i,
];

/**
 * Validates whether an Azure Retail billing line represents an actual AI model SKU.
 * Rejects legacy Cognitive Services, OCR, spell checks, and general IT tools.
 */
export function isGenuineAiModelSku(item) {
  if (!item || !item.productName) return false;
  const name = `${item.productName} ${item.skuName || ''}`;

  // 1. Explicitly drop enterprise IT / Cognitive Services noise
  if (NOISE_NON_MODEL_PATTERNS.some((p) => p.test(name))) return false;

  // 2. Accept genuine AI model families & modalities
  if (AI_MODEL_PATTERNS.some((p) => p.test(name))) return true;

  // 3. Accept Foundry Models unless purely infrastructure/storage
  if (item.feedName === 'Foundry Models' && !/\b(?:storage|bandwidth|egress)\b/i.test(name)) return true;

  return false;
}

/**
 * 4. Azure Retail Prices (Foundry Models & Azure OpenAI)
 * Strictly filtered to genuine AI foundation models.
 */
export async function fetchAzureRetailFeeds() {
  const uniqueSkus = new Map();

  for (const feed of LEAK_CONFIG.endpoints.azureRetailFeeds) {
    try {
      const res = await fetchSafe(feed.url);
      const data = await res.json();
      const items = data.Items || [];

      for (const item of items) {
        if (!isGenuineAiModelSku({ ...item, feedName: feed.name })) continue;
        const key = `${item.productName}::${item.skuName}`;
        if (!uniqueSkus.has(key)) {
          uniqueSkus.set(key, {
            productName: item.productName,
            skuName: item.skuName,
            retailPrice: item.retailPrice,
            unitOfMeasure: item.unitOfMeasure,
            effectiveStartDate: item.effectiveStartDate,
            feedName: feed.name,
          });
        }
      }
    } catch (err) {
      console.warn(`[Leak Tracker] Azure Retail feed '${feed.name}' failed:`, err.message);
    }
  }

  return Array.from(uniqueSkus.values());
}

/**
 * 5. Google Vertex AI Pricing Table HTML Fetcher
 * Leaks pre-staged models: gemini-4-argon, gemini-3.8-flash, gemini-omni, gemini-3.5-transcribe
 */
export async function fetchGoogleVertexPricingHtml() {
  const res = await fetchSafe(LEAK_CONFIG.endpoints.googleVertexPricingHtml);
  const html = await res.text();

  const foundModels = new Set();
  const rawMatches = html.matchAll(/gemini-[a-zA-Z0-9.-]+/gi);

  for (const m of rawMatches) {
    let clean = m[0].replace(/[.,;:()]+$/, '').toLowerCase();
    // Filter out generic prose, documentation slugs, or CSS classes
    if (
      clean.length > 7 &&
      clean.length < 50 &&
      !clean.includes('is-billed') &&
      !clean.includes('to-calculate')
    ) {
      foundModels.add(clean);
    }
  }

  return Array.from(foundModels).sort();
}

/**
 * 6. AWS Generic Offers Index Fetcher
 */
export async function fetchAwsOffersIndex() {
  const res = await fetchSafe(LEAK_CONFIG.endpoints.awsOffersIndex);
  const data = await res.json();

  const offers = data.offers || {};
  const offerCodes = Object.keys(offers).sort();

  return {
    publicationDate: data.publicationDate || null,
    offerCodes,
  };
}

/**
 * 7. AWS JumpStart Proprietary SDKs Manifest Fetcher
 */
export async function fetchJumpstartProprietary() {
  const res = await fetchSafe(LEAK_CONFIG.endpoints.jumpstartProprietary);
  const data = await res.json();

  if (!Array.isArray(data)) return [];

  return data.map((m) => ({
    modelId: m.model_id,
    version: m.version,
    minVersion: m.min_version,
    specKey: m.spec_key,
  }));
}

/**
 * 8. Anthropic Python SDK Model Type Unions (anthropic-sdk-python/model.py)
 * Prime leak for: claude-mythos-preview, claude-mythos-5, claude-fable-5-1, etc.
 */
export async function fetchAnthropicPythonSdkModel() {
  const res = await fetchSafe(LEAK_CONFIG.endpoints.anthropicPythonSdkModel);
  const text = await res.text();

  const models = new Set();
  const literalMatches = text.matchAll(/["'](claude-[a-z0-9.-]+)["']/g);
  for (const m of literalMatches) {
    models.add(m[1]);
  }

  return Array.from(models).sort();
}

/**
 * 9. Google GenAI Python SDK Types (python-genai/types.py)
 * Leaks: gemini-3.8-flash, gemini-3-pro-preview
 */
export async function fetchGoogleGenaiPythonTypes() {
  const res = await fetchSafe(LEAK_CONFIG.endpoints.googleGenaiPythonTypes);
  const text = await res.text();

  const models = new Set();
  const matches = text.matchAll(/["'](gemini-[a-z0-9.-]+)["']/gi);
  for (const m of matches) {
    models.add(m[1].toLowerCase());
  }

  return Array.from(models).sort();
}

/**
 * 10. OpenAI Codex Models Fetcher
 */
export async function fetchOpenaiCodexModels() {
  const res = await fetchSafe(LEAK_CONFIG.endpoints.openaiCodexModels);
  const data = await res.json();

  const models = data.models || [];
  return models.map((m) => ({
    slug: m.slug,
    preferWebsockets: m.prefer_websockets || false,
    supportVerbosity: m.support_verbosity || false,
    defaultVerbosity: m.default_verbosity || 'standard',
    applyPatchToolType: m.apply_patch_tool_type || null,
  }));
}

/**
 * 11. OpenAI OpenAPI Commits Atom Fetcher
 */
export async function fetchOpenaiCommits() {
  const res = await fetchSafe(LEAK_CONFIG.endpoints.openaiCommitsAtom);
  const text = await res.text();

  const entries = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match;

  while ((match = entryRegex.exec(text)) !== null) {
    const entryBlock = match[1];
    const id = entryBlock.match(/<id>([\s\S]*?)<\/id>/)?.[1]?.trim();
    const title = entryBlock.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim()?.replace(/&amp;/g, '&');
    const updated = entryBlock.match(/<updated>([\s\S]*?)<\/updated>/)?.[1]?.trim();
    const link = entryBlock.match(/<link[^>]+href="([^"]+)"/)?.[1];
    const author = entryBlock.match(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>/)?.[1]?.trim();

    if (id && title) {
      entries.push({ id, title, updated, link, author });
    }
  }

  return entries;
}

/**
 * 12. OpenAI OpenAPI Specification Model Enums Fetcher
 */
export async function fetchOpenaiOpenapiYaml() {
  const res = await fetchSafe(LEAK_CONFIG.endpoints.openaiOpenapiYaml);
  const text = await res.text();

  const versionMatch = text.match(/version:\s*([^\s\n]+)/);
  const version = versionMatch ? versionMatch[1] : 'unknown';

  const modelEnums = new Set();
  const enumMatches = text.matchAll(/-\s*["']?(gpt-[^"'\s\n]+|o1-[^"'\s\n]+|o3-[^"'\s\n]+|chatgpt-[^"'\s\n]+)["']?/g);
  for (const m of enumMatches) {
    modelEnums.add(m[1]);
  }

  return {
    version,
    modelEnums: Array.from(modelEnums).sort(),
  };
}
