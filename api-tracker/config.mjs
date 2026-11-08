/**
 * Qwen Cloud Tracker — Configuration
 * Discovers models, pricing, and rate limits across Qwen Cloud & Alibaba Bailian SFM.
 */

export const QWEN_CONFIG = {
  gatewayUrl: 'https://ap-southeast-1-cs-data.qwencloud.com/data/api.json',
  action: 'IntlBroadScopeAspnGateway',
  product: 'sfm_bailian',
  api: 'zeldaHttp.dashscopeModel./zelda/api/v1/modelCenter/listFoundationModels',
  consoleSite: 'AP_SOUTHEAST_1_QWENCLOUD',
  domain: 'www.qwencloud.com',
  productCode: 'p_efm',
  protocol: 'V2',
  xspLang: 'en_US',

  // Regional failover gateways
  regionalGateways: [
    'https://ap-southeast-1-cs-data.qwencloud.com/data/api.json',
    'https://cn-hongkong-cs-data.qwencloud.com/data/api.json',
    'https://cn-beijing-cs-data.qwencloud.com/data/api.json',
    'https://us-east-1-cs-data.qwencloud.com/data/api.json',
  ],

  modelMarkdownBase: 'https://www.qwencloud.com/models',
  modelPortalBase: 'https://www.qwencloud.com/models',
  
  // High-res avatar fallback
  qwenAvatar: 'https://avatars.githubusercontent.com/u/141221163?s=200&v=4',

  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',

  timeouts: {
    gateway: 15000,
    markdown: 10000,
    discord: 10000,
  },

  colors: {
    newModel: 0x6366f1,    // Indigo
    priceChange: 0x10b981, // Emerald Green
    specChange: 0x3b82f6,  // Blue
    removed: 0xef4444,     // Red
    info: 0x8b5cf6,        // Violet
  },

  webhookEnvVars: [
    'API_DISCORD_WEBHOOK_URL',
    'API_TRACKER_DISCORD_WEBHOOK_URL',
    'QWEN_DISCORD_WEBHOOK_URL',
    'DISCORD_WEBHOOK_URL',
  ],
};
