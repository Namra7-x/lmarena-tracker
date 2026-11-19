/**
 * Leak Tracker — Diffing Engine
 * Computes exact state transitions for:
 * Channel 1 (Early Model / Qwen):
 *   - GCP SKUs
 *   - Azure Foundry Models
 *   - AWS Bedrock Master Pricing (Grok 4.7, Kimi, MiniMax, Nemotron, Nova)
 *   - Azure Retail Prices (Foundry, Azure OpenAI, AI+ML)
 *   - Google Vertex AI Pricing Table HTML (gemini-4-argon, etc.)
 *   - AWS Generic Offers Index
 *   - AWS JumpStart Proprietary
 *
 * Channel 2 (GitHub Commits & Analysis):
 *   - Anthropic Python SDK Model Type Unions (claude-mythos, etc.)
 *   - Google GenAI Python SDK Types (gemini-3.8-flash, etc.)
 *   - OpenAI Codex Models
 *   - OpenAI Commits
 *   - OpenAI OpenAPI Model Enums
 */

export function computeLeakDiff(current, baseline) {
  if (!baseline) {
    return {
      isFirstRun: true,
      hasChanges: false,
      channel1: {
        hasChanges: false,
        newGcpSkus: [],
        newAzureFoundry: [],
        newBedrockMaster: [],
        newAzureRetail: [],
        newVertexPricingModels: [],
        newAwsOfferCodes: [],
        newJumpstart: [],
      },
      channel2: {
        hasChanges: false,
        newAnthropicPythonModels: [],
        newGoogleGenaiPythonModels: [],
        newCodexModels: [],
        newOpenaiCommits: [],
        newOpenaiEnums: [],
      },
    };
  }

  // ==========================================
  // CHANNEL 1: Early Model Tracker / Qwen
  // ==========================================

  // 1. GCP SKUs
  const baselineGcp = new Set((baseline.gcpSkus || []).map((s) => s.skuId));
  const newGcpSkus = (current.gcpSkus || []).filter((s) => !baselineGcp.has(s.skuId));

  // 2. Azure Foundry Models
  const baselineAzureFoundry = new Set((baseline.azureFoundryModels || []).map((m) => `${m.name}::${m.version}`));
  const newAzureFoundry = (current.azureFoundryModels || []).filter((m) => !baselineAzureFoundry.has(`${m.name}::${m.version}`));

  // 3. AWS Bedrock Master (AmazonBedrock/current/index.json)
  const baselineBedrockSkus = new Set((baseline.awsBedrockMaster?.products || []).map((p) => p.sku));
  const newBedrockMaster = (current.awsBedrockMaster?.products || []).filter((p) => !baselineBedrockSkus.has(p.sku));
  const bedrockVersionChanged = baseline.awsBedrockMaster?.version !== current.awsBedrockMaster?.version &&
                                current.awsBedrockMaster?.version !== 'unknown';

  // 4. Azure Retail Prices (Foundry, Azure OpenAI, AI+ML)
  const baselineAzureRetail = new Set((baseline.azureRetailPrices || []).map((p) => `${p.productName}::${p.skuName}`));
  const newAzureRetail = (current.azureRetailPrices || []).filter((p) => !baselineAzureRetail.has(`${p.productName}::${p.skuName}`));

  // 5. Google Vertex AI Pricing Table HTML
  const baselineVertexHtml = new Set(baseline.googleVertexPricingModels || []);
  const newVertexPricingModels = (current.googleVertexPricingModels || []).filter((m) => !baselineVertexHtml.has(m));

  // 6. AWS Generic Offers Index
  const baselineAwsOffers = new Set(baseline.awsOffersIndex?.offerCodes || []);
  const newAwsOfferCodes = (current.awsOffersIndex?.offerCodes || []).filter((c) => !baselineAwsOffers.has(c));

  // 7. AWS JumpStart Proprietary
  const baselineJumpstart = new Set((baseline.jumpstartProprietary || []).map((m) => `${m.modelId}::${m.version}`));
  const newJumpstart = (current.jumpstartProprietary || []).filter((m) => !baselineJumpstart.has(`${m.modelId}::${m.version}`));

  // ==========================================
  // CHANNEL 2: GitHub Commits & Analysis
  // ==========================================

  // 1. Anthropic Python SDK Model Type Unions (claude-mythos, etc.)
  const baselineAnthropicPy = new Set(baseline.anthropicPythonSdkModels || []);
  const newAnthropicPythonModels = (current.anthropicPythonSdkModels || []).filter((m) => !baselineAnthropicPy.has(m));

  // 2. Google GenAI Python SDK Types (gemini-3.8-flash, etc.)
  const baselineGoogleGenaiPy = new Set(baseline.googleGenaiPythonModels || []);
  const newGoogleGenaiPythonModels = (current.googleGenaiPythonModels || []).filter((m) => !baselineGoogleGenaiPy.has(m));

  // 3. OpenAI Codex Models
  const baselineCodex = new Set((baseline.openaiCodexModels || []).map((m) => m.slug));
  const newCodexModels = (current.openaiCodexModels || []).filter((m) => !baselineCodex.has(m.slug));

  // 4. OpenAI OpenAPI Commits
  const baselineCommits = new Set((baseline.openaiCommits || []).map((c) => c.id));
  const newOpenaiCommits = (current.openaiCommits || []).filter((c) => !baselineCommits.has(c.id));

  // 5. OpenAI OpenAPI Yaml Enums
  const baselineEnums = new Set(baseline.openaiOpenapiYaml?.modelEnums || []);
  const newOpenaiEnums = (current.openaiOpenapiYaml?.modelEnums || []).filter((e) => !baselineEnums.has(e));
  const openapiVersionChanged = baseline.openaiOpenapiYaml?.version !== current.openaiOpenapiYaml?.version &&
                                current.openaiOpenapiYaml?.version !== 'unknown';

  const channel1HasChanges =
    newGcpSkus.length > 0 ||
    newAzureFoundry.length > 0 ||
    newBedrockMaster.length > 0 ||
    newAzureRetail.length > 0 ||
    newVertexPricingModels.length > 0 ||
    newAwsOfferCodes.length > 0 ||
    newJumpstart.length > 0;

  const channel2HasChanges =
    newAnthropicPythonModels.length > 0 ||
    newGoogleGenaiPythonModels.length > 0 ||
    newCodexModels.length > 0 ||
    newOpenaiCommits.length > 0 ||
    newOpenaiEnums.length > 0;

  return {
    isFirstRun: false,
    hasChanges: channel1HasChanges || channel2HasChanges,
    channel1: {
      hasChanges: channel1HasChanges,
      newGcpSkus,
      newAzureFoundry,
      newBedrockMaster,
      bedrockVersionChanged,
      newAzureRetail,
      newVertexPricingModels,
      newAwsOfferCodes,
      newJumpstart,
    },
    channel2: {
      hasChanges: channel2HasChanges,
      newAnthropicPythonModels,
      newGoogleGenaiPythonModels,
      newCodexModels,
      newOpenaiCommits,
      newOpenaiEnums,
      openapiVersionChanged,
    },
  };
}
