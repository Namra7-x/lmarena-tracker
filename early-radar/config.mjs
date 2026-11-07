/**
 * Early Signal Radar - Configuration
 * Tracks:
 * 1. Artificial Analysis Index (Frontier Models & Benchmarks)
 * 2. OpenAI Python SDK Model Enum Commits (openai-python)
 * 3. Anthropic TypeScript SDK Model Enum Commits (anthropic-sdk-typescript)
 */

export const RADAR_CONFIG = {
  // Target Endpoints
  endpoints: {
    artificialAnalysis: 'https://artificialanalysis.ai/models',
    openaiSdkRepo: 'openai/openai-python',
    openaiSdkPath: 'src/openai/types/shared/chat_model.py',
    anthropicSdkRepo: 'anthropics/anthropic-sdk-typescript',
    anthropicSdkPath: 'src/resources/messages/messages.ts',
  },

  // Discord Embed Styling Colors (Hex integers)
  colors: {
    artificialAnalysis: 0x6366f1, // Indigo
    openai: 0x10a37f,             // OpenAI Green
    anthropic: 0xd97706,          // Anthropic Amber / Terracotta
    chatgpt: 0x10a37f,            // Alias for OpenAI
    claude: 0xd97706,             // Alias for Anthropic
    commit: 0x8b5cf6,             // Purple
    init: 0x3b82f6,               // Blue
  },

  // Desktop User-Agent
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',

  // Timeout settings
  timeouts: {
    fetch: 15000,
  },

  // Webhook Environment Variables (in priority order)
  webhookEnvVars: [
    'EARLY_RADAR_DISCORD_WEBHOOK_URL',
    'RADAR_DISCORD_WEBHOOK_URL',
    'HF_DISCORD_WEBHOOK_URL',
    'DISCORD_WEBHOOK_URL',
  ],
};
