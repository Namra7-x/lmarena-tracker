/**
 * Official AI SDK Tracker — Configuration
 * Tracks npm dist-tags, releases, and type definitions across frontier AI labs.
 */

export const SDK_CONFIG = {
  registryBase: 'https://registry.npmjs.org',
  
  packages: [
    {
      name: '@anthropic-ai/sdk',
      family: 'anthropic',
      displayName: 'Anthropic Claude SDK',
      tags: ['latest', 'canary', 'beta'],
    },
    {
      name: 'openai',
      family: 'openai',
      displayName: 'OpenAI Python/TS SDK',
      tags: ['latest', 'beta', 'next'],
    },
    {
      name: '@google/genai',
      family: 'google',
      displayName: 'Google GenAI SDK (v1)',
      tags: ['latest', 'next'],
    },
    {
      name: '@google/generative-ai',
      family: 'google',
      displayName: 'Google Generative AI SDK',
      tags: ['latest', 'next'],
    },
  ],

  timeouts: {
    registry: 15000,
    download: 25000,
  },
};
