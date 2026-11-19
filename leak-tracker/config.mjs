/**
 * Leak Tracker — Configuration
 * Covers:
 * 1. Early Model Tracker (Channel 1 - alongside Qwen):
 *    - Google Cloud SKU Catalog (generic token/gemini/claude filters)
 *    - Azure AI Foundry Asset Catalog (models ordered by createdTime desc)
 *    - AWS Bedrock Master Feed (AmazonBedrock/current/index.json - Grok, Kimi, MiniMax, Nemotron, Nova)
 *    - Azure Retail Prices (Foundry Models, Azure OpenAI, and AI+Machine Learning)
 *    - Google Vertex AI Pricing Table HTML (pre-staged Gemini models in table anchors)
 *    - AWS Generic Offers Index (aws/index.json)
 *    - AWS SageMaker JumpStart (proprietary-sdk-manifest.json)
 *
 * 2. GitHub Commits / Analysis (Channel 2 - alongside early-radar):
 *    - Anthropic Python SDK Model Type Unions (anthropic-sdk-python/model.py)
 *    - Google GenAI Python SDK Types (python-genai/types.py)
 *    - OpenAI Codex Model List (models.json)
 *    - OpenAI OpenAPI Commits Feed (commits/main.atom)
 *    - OpenAI OpenAPI Specification (openapi.yaml model enums)
 */

export const LEAK_CONFIG = {
  // Desktop User Agent for clean responses
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',

  timeouts: {
    fetch: 15000,
    discord: 10000,
  },

  // Target endpoints
  endpoints: {
    // Channel 1: Pre-Release & Early Catalogs (Early Model Tracker / Qwen Channel)
    gcpSkus: [
      { filter: 'token', url: 'https://cloud.google.com/__/json/searchskus?filter=token&currency=USD' },
      { filter: 'gemini', url: 'https://cloud.google.com/__/json/searchskus?filter=gemini&currency=USD' },
      { filter: 'claude', url: 'https://cloud.google.com/__/json/searchskus?filter=claude&currency=USD' },
    ],
    azureFoundryModels: 'https://api.catalog.azureml.ms/asset-gallery/v1.0/models',
    awsBedrockMaster: 'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrock/current/index.json',
    azureRetailFeeds: [
      { name: 'Foundry Models', url: 'https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&$filter=serviceName%20eq%20%27Foundry%20Models%27' },
      { name: 'Azure OpenAI', url: 'https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&$filter=productName%20eq%20%27Azure%20OpenAI%27' },
      { name: 'AI + ML Master', url: 'https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&$filter=serviceFamily%20eq%20%27AI%20%2B%20Machine%20Learning%27' },
    ],
    googleVertexPricingHtml: 'https://cloud.google.com/vertex-ai/generative-ai/pricing',
    awsOffersIndex: 'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/index.json',
    jumpstartProprietary: 'https://jumpstart-cache-prod-us-east-1.s3.us-east-1.amazonaws.com/proprietary-sdk-manifest.json',

    // Channel 2: GitHub Code Staging & SDK Type Unions (GitHub Commits & Analysis Channel)
    anthropicPythonSdkModel: 'https://raw.githubusercontent.com/anthropics/anthropic-sdk-python/main/src/anthropic/types/model.py',
    googleGenaiPythonTypes: 'https://raw.githubusercontent.com/googleapis/python-genai/main/google/genai/types.py',
    openaiCodexModels: 'https://raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json',
    openaiCommitsAtom: 'https://github.com/openai/openai-openapi/commits/main.atom',
    openaiOpenapiYaml: 'https://raw.githubusercontent.com/openai/openai-openapi/main/openapi.yaml',
  },

  // Embed Colors
  colors: {
    google: 0x4285f4,      // Google Blue
    azure: 0x0078d4,       // Microsoft Azure Blue
    aws: 0xff9900,         // AWS Orange
    anthropic: 0xd97706,   // Anthropic Terracotta / Amber
    openai: 0x10a37f,      // OpenAI Emerald Green
    codex: 0x22c55e,       // Vibrant Green
  },

  // Webhook Channels
  channels: {
    // Channel 1: Early model tracker (alongside Qwen & catalog updates)
    earlyModel: [
      'API_DISCORD_WEBHOOK_URL',
      'API_TRACKER_DISCORD_WEBHOOK_URL',
      'QWEN_DISCORD_WEBHOOK_URL',
      'DISCORD_WEBHOOK_URL',
    ],
    // Channel 2: GitHub commits and Artificial Analysis
    commitAnalysis: [
      'EARLY_RADAR_DISCORD_WEBHOOK_URL',
      'RADAR_DISCORD_WEBHOOK_URL',
      'DISCORD_WEBHOOK_URL',
    ],
  },
};
