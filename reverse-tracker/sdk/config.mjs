/**
 * Official AI SDK Tracker — Configuration
 * Tracks npm dist-tags (including pre-release beta/next/canary), releases,
 * and type/client definitions across official Anthropic, OpenAI, and Google SDKs.
 */

export const SDK_CONFIG = {
  registryBase: 'https://registry.npmjs.org',

  packages: [
    // Anthropic (Claude)
    {
      name: '@anthropic-ai/sdk',
      family: 'anthropic',
      displayName: 'Anthropic Claude SDK',
      tags: ['latest', 'next', 'beta', 'alpha', 'canary'],
    },
    {
      name: '@anthropic-ai/claude-agent-sdk',
      family: 'anthropic',
      displayName: 'Anthropic Claude Agent SDK',
      tags: ['latest', 'next', 'beta', 'canary'],
    },

    // OpenAI (ChatGPT)
    {
      name: 'openai',
      family: 'openai',
      displayName: 'OpenAI Node/TS SDK',
      tags: ['latest', 'next', 'beta', 'alpha'],
    },
    {
      name: '@openai/agents',
      family: 'openai',
      displayName: 'OpenAI Agents SDK',
      tags: ['latest', 'next', 'beta'],
    },

    // Google (Gemini)
    {
      name: '@google/genai',
      family: 'google',
      displayName: 'Google GenAI SDK (v1)',
      tags: ['latest', 'next', 'beta', 'rc'],
    },
    {
      name: '@google/generative-ai',
      family: 'google',
      displayName: 'Google Generative AI SDK',
      tags: ['latest', 'next'],
    },
    {
      name: '@google/adk',
      family: 'google',
      displayName: 'Google ADK (Agent Development Kit)',
      tags: ['latest', 'next', 'beta'],
    },
  ],

  timeouts: {
    registry: 15000,
    download: 25000,
  },
};
