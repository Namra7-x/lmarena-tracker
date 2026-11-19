/**
 * Claude Model Catalog Tracker — Configuration
 * Tracks Anthropic's official live model catalog endpoint:
 * https://downloads.claude.ai/model-catalog/v1/catalog.json
 */

export const CLAUDE_CONFIG = {
  // Official live endpoints
  endpoint: 'https://downloads.claude.ai/model-catalog/v1/catalog.json',
  fallbackEndpoint: 'https://downloads.claude.ai/model-catalog/v1/cataalog.json',
  schemaUrl: 'https://downloads.claude.ai/model-catalog/v1/schema.json',

  // Network timeouts (ms)
  timeout: 15000,

  // Desktop user agent
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',

  // Brand color for embeds (Anthropic Terracotta / Amber)
  color: 0xd97706,

  // Webhook Environment Variables for Discord (exact channel where GitHub commits and Artificial Analysis messages appear)
  webhookEnvVars: [
    'EARLY_RADAR_DISCORD_WEBHOOK_URL',
    'RADAR_DISCORD_WEBHOOK_URL',
    'DISCORD_WEBHOOK_URL',
  ],

  // Telegram Family and Component Identifier
  family: 'anthropic',
  componentId: 'claude-catalog',
};
