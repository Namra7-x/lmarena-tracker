/**
 * Qwen Cloud Gateway Client
 * Queries internal JSON gateway for foundation model catalog & groups.
 */

import { QWEN_CONFIG } from './config.mjs';

/**
 * Builds the URL-encoded POST body for the gateway query.
 */
function buildRequestBody(pageNo = 1, pageSize = 50) {
  const params = {
    Api: QWEN_CONFIG.api,
    Data: {
      cornerstoneParam: {
        consoleSite: QWEN_CONFIG.consoleSite,
        domain: QWEN_CONFIG.domain,
        productCode: QWEN_CONFIG.productCode,
        protocol: QWEN_CONFIG.protocol,
        xsp_lang: QWEN_CONFIG.xspLang,
      },
      V: '1.0',
      input: {
        pageNo,
        pageSize,
        group: true,
        queryPermissions: true,
        queryApplyStatus: true,
        queryActivationStatus: true,
        supports: { inference: true },
      },
    },
  };

  return new URLSearchParams({
    product: QWEN_CONFIG.product,
    action: QWEN_CONFIG.action,
    sec_token: '',
    region: 'ap-southeast-1',
    params: JSON.stringify(params),
  }).toString();
}

/**
 * Fetches a single page of model groups from the gateway with retry and regional fallback.
 */
async function fetchGatewayPage(pageNo = 1, pageSize = 50) {
  const body = buildRequestBody(pageNo, pageSize);
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': QWEN_CONFIG.userAgent,
    Accept: 'application/json',
  };

  const gateways = QWEN_CONFIG.regionalGateways;

  for (const gwUrl of gateways) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const fullUrl = `${gwUrl}?action=${QWEN_CONFIG.action}&product=${QWEN_CONFIG.product}&api=${encodeURIComponent(QWEN_CONFIG.api)}`;
        const res = await fetch(fullUrl, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(QWEN_CONFIG.timeouts.gateway),
        });

        if (res.ok) {
          const json = await res.json();
          const list = json?.data?.DataV2?.data?.data?.list;
          const total = json?.data?.DataV2?.data?.data?.total;
          if (Array.isArray(list)) {
            return { list, total: total || list.length };
          }
        }
      } catch (err) {
        // Retry next attempt or next regional gateway
      }
      await new Promise((r) => setTimeout(r, 600));
    }
  }

  throw new Error(`Failed to fetch Qwen Cloud gateway page ${pageNo} across all regional endpoints`);
}

/**
 * Fetches all model groups and flattens them into an array of individual model specifications.
 * Returns { groups: Array, models: Map<modelId, modelSpec>, totalGroups, totalModels }
 */
export async function fetchAllModels() {
  const firstPage = await fetchGatewayPage(1, 50);
  const groups = [...firstPage.list];
  const totalGroups = firstPage.total;

  // If there are more groups, fetch subsequent pages
  let currentPage = 2;
  while (groups.length < totalGroups && currentPage <= 10) {
    const pageResult = await fetchGatewayPage(currentPage, 50);
    if (!pageResult.list || pageResult.list.length === 0) break;
    groups.push(...pageResult.list);
    currentPage++;
  }

  // Flatten items into model specifications
  const models = new Map();

  for (const group of groups) {
    const groupItems = Array.isArray(group.items) ? group.items : [];
    const groupIcon = group.providerIconUrl || null;

    for (const item of groupItems) {
      const modelId = item.model || item.modelAlias || item.name;
      if (!modelId) continue;

      const normSpec = {
        modelId,
        name: item.name || modelId,
        modelAlias: item.modelAlias || null,
        provider: item.provider || group.provider || 'qwen',
        providerIconUrl: item.providerIconUrl || groupIcon || null,
        category: item.category || group.category || null,
        description: item.description || group.description || '',
        shortDescription: item.shortDescription || group.shortDescription || '',
        updateAt: item.updateAt || group.updateAt || null,
        latestOnlineAt: item.latestOnlineAt || null,
        collectionTag: item.collectionTag || group.collectionTag || null,
        features: Array.isArray(item.features) ? [...item.features].sort() : [],
        capabilities: Array.isArray(item.capabilities) ? [...item.capabilities].sort() : [],
        modelInfo: {
          contextWindow: item.modelInfo?.contextWindow || item.contextWindow || null,
          maxInputTokens: item.modelInfo?.maxInputTokens || item.maxInputTokens || null,
          maxOutputTokens: item.modelInfo?.maxOutputTokens || item.maxOutputTokens || null,
          maxReasoningTokens: item.modelInfo?.maxReasoningTokens || null,
          reasoningMaxInputTokens: item.modelInfo?.reasoningMaxInputTokens || null,
          reasoningMaxOutputTokens: item.modelInfo?.reasoningMaxOutputTokens || null,
        },
        inferenceMetadata: {
          requestModality: item.inferenceMetadata?.request_modality || [],
          responseModality: item.inferenceMetadata?.response_modality || [],
        },
        docUrl: item.docUrl || group.docUrl || null,
        modelPortalUrl: `${QWEN_CONFIG.modelPortalBase}/${modelId}`,
        markdownUrl: `${QWEN_CONFIG.modelMarkdownBase}/${modelId}.md`,
        supports: item.supports || {},
        rawItem: item,
      };

      models.set(modelId, normSpec);
    }
  }

  return {
    groups,
    models,
    totalGroups: groups.length,
    totalModels: models.size,
  };
}
