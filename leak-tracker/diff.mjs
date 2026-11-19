/**
 * Leak Tracker — Diffing Engine
 * Computes exact state transitions for:
 * - GCP SKUs
 * - Azure Foundry Models
 * - AWS Bedrock Pricing
 * - Azure Retail Prices
 * - AWS JumpStart Proprietary
 * - OpenAI Codex Models
 * - OpenAI Commits
 * - OpenAI OpenAPI Model Enums
 */

export function computeLeakDiff(current, baseline) {
  if (!baseline) {
    return {
      isFirstRun: true,
      hasChanges: false,
      channel1: { hasChanges: false, newGcpSkus: [], newAzureFoundry: [], newBedrock: [], newAzureRetail: [], newJumpstart: [] },
      channel2: { hasChanges: false, newCodexModels: [], newOpenaiCommits: [], newOpenaiEnums: [] },
    };
  }

  // 1. Channel 1: Pre-Release & Early Catalogs
  // GCP SKUs
  const baselineGcp = new Set((baseline.gcpSkus || []).map((s) => s.skuId));
  const newGcpSkus = (current.gcpSkus || []).filter((s) => !baselineGcp.has(s.skuId));

  // Azure Foundry Models
  const baselineAzureFoundry = new Set((baseline.azureFoundryModels || []).map((m) => `${m.name}::${m.version}`));
  const newAzureFoundry = (current.azureFoundryModels || []).filter((m) => !baselineAzureFoundry.has(`${m.name}::${m.version}`));

  // AWS Bedrock Pricing
  const baselineBedrockSkus = new Set((baseline.awsBedrockPricing?.products || []).map((p) => p.sku));
  const newBedrock = (current.awsBedrockPricing?.products || []).filter((p) => !baselineBedrockSkus.has(p.sku));
  const bedrockVersionChanged = baseline.awsBedrockPricing?.version !== current.awsBedrockPricing?.version &&
                                current.awsBedrockPricing?.version !== 'unknown';

  // Azure Retail Prices
  const baselineAzureRetail = new Set((baseline.azureRetailPrices || []).map((p) => `${p.productName}::${p.skuName}`));
  const newAzureRetail = (current.azureRetailPrices || []).filter((p) => !baselineAzureRetail.has(`${p.productName}::${p.skuName}`));

  // AWS JumpStart Proprietary
  const baselineJumpstart = new Set((baseline.jumpstartProprietary || []).map((m) => `${m.modelId}::${m.version}`));
  const newJumpstart = (current.jumpstartProprietary || []).filter((m) => !baselineJumpstart.has(`${m.modelId}::${m.version}`));

  // 2. Channel 2: OpenAI Code & Schema
  // OpenAI Codex Models
  const baselineCodex = new Set((baseline.openaiCodexModels || []).map((m) => m.slug));
  const newCodexModels = (current.openaiCodexModels || []).filter((m) => !baselineCodex.has(m.slug));

  // OpenAI OpenAPI Commits
  const baselineCommits = new Set((baseline.openaiCommits || []).map((c) => c.id));
  const newOpenaiCommits = (current.openaiCommits || []).filter((c) => !baselineCommits.has(c.id));

  // OpenAI OpenAPI Yaml Enums
  const baselineEnums = new Set(baseline.openaiOpenapiYaml?.modelEnums || []);
  const newOpenaiEnums = (current.openaiOpenapiYaml?.modelEnums || []).filter((e) => !baselineEnums.has(e));
  const openapiVersionChanged = baseline.openaiOpenapiYaml?.version !== current.openaiOpenapiYaml?.version &&
                                current.openaiOpenapiYaml?.version !== 'unknown';

  const channel1HasChanges = newGcpSkus.length > 0 ||
    newAzureFoundry.length > 0 ||
    newBedrock.length > 0 ||
    newAzureRetail.length > 0 ||
    newJumpstart.length > 0;

  const channel2HasChanges = newCodexModels.length > 0 ||
    newOpenaiCommits.length > 0 ||
    newOpenaiEnums.length > 0;

  return {
    isFirstRun: false,
    hasChanges: channel1HasChanges || channel2HasChanges,
    channel1: {
      hasChanges: channel1HasChanges,
      newGcpSkus,
      newAzureFoundry,
      newBedrock,
      bedrockVersionChanged,
      newAzureRetail,
      newJumpstart,
    },
    channel2: {
      hasChanges: channel2HasChanges,
      newCodexModels,
      newOpenaiCommits,
      newOpenaiEnums,
      openapiVersionChanged,
    },
  };
}
