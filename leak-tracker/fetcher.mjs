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
 * 3. AWS Bedrock Pricing Feed Fetcher
 */
export async function fetchAwsBedrockPricing() {
  const res = await fetchSafe(LEAK_CONFIG.endpoints.awsBedrockPricing);
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

/**
 * 4. Azure Retail Prices (Foundry Models) Fetcher
 */
export async function fetchAzureRetailPrices() {
  const res = await fetchSafe(LEAK_CONFIG.endpoints.azureRetailPrices);
  const data = await res.json();

  const items = data.Items || [];
  const uniqueSkus = new Map();

  for (const item of items) {
    const key = `${item.productName}::${item.skuName}`;
    if (!uniqueSkus.has(key)) {
      uniqueSkus.set(key, {
        productName: item.productName,
        skuName: item.skuName,
        retailPrice: item.retailPrice,
        unitOfMeasure: item.unitOfMeasure,
        effectiveStartDate: item.effectiveStartDate,
      });
    }
  }

  return Array.from(uniqueSkus.values());
}

/**
 * 5. AWS JumpStart Proprietary SDKs Manifest Fetcher
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
 * 6. OpenAI Codex Models Fetcher
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
 * 7. OpenAI OpenAPI Commits Atom Fetcher
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
 * 8. OpenAI OpenAPI Specification Model Enums Fetcher
 */
export async function fetchOpenaiOpenapiYaml() {
  const res = await fetchSafe(LEAK_CONFIG.endpoints.openaiOpenapiYaml);
  const text = await res.text();

  const versionMatch = text.match(/version:\s*([^\s\n]+)/);
  const version = versionMatch ? versionMatch[1] : 'unknown';

  // Extract model enum strings (e.g. gpt-4o, gpt-6...)
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
