/**
 * Early Signal Radar - Test Suite
 * Tests Artificial Analysis parsing, ChatGPT & Claude manifest extraction,
 * SDK commit diff parsing, and Discord embed builder.
 * Verifies ZERO HARDCODED MODEL NAMES.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { RADAR_CONFIG } from '../early-radar/config.mjs';
import { extractModelIdentifiersFromDiff } from '../early-radar/sources/sdk_commits.mjs';
import { extractDynamicModelIdentifiers } from '../early-radar/sources/chatgpt_manifest.mjs';
import { extractDynamicClaudeIdentifiers } from '../early-radar/sources/claude_manifest.mjs';
import {
  buildArtificialAnalysisEmbed,
  buildChatGPTBuildEmbed,
  buildClaudeBuildEmbed,
  buildSdkCommitEmbed,
} from '../early-radar/discord.mjs';

describe('Early Radar Configuration', () => {
  it('should define all required endpoints and colors', () => {
    assert.ok(RADAR_CONFIG.endpoints.artificialAnalysis);
    assert.ok(RADAR_CONFIG.endpoints.chatgpt);
    assert.ok(RADAR_CONFIG.endpoints.claude);
    assert.ok(RADAR_CONFIG.endpoints.openaiSdkRepo);
    assert.ok(RADAR_CONFIG.endpoints.anthropicSdkRepo);

    assert.equal(typeof RADAR_CONFIG.colors.artificialAnalysis, 'number');
    assert.equal(typeof RADAR_CONFIG.colors.chatgpt, 'number');
    assert.equal(typeof RADAR_CONFIG.colors.claude, 'number');
  });

  it('should include EARLY_RADAR_DISCORD_WEBHOOK_URL in webhook env vars', () => {
    assert.ok(RADAR_CONFIG.webhookEnvVars.includes('EARLY_RADAR_DISCORD_WEBHOOK_URL'));
    assert.equal(RADAR_CONFIG.webhookEnvVars[0], 'EARLY_RADAR_DISCORD_WEBHOOK_URL');
  });
});

describe('Dynamic Model Extraction (Zero Hardcoded Names)', () => {
  it('should dynamically extract arbitrary new model names from git diff', () => {
    const mockDiff = `
@@ -10,6 +10,8 @@
-    "old-model-v1",
+    "unannounced-future-model-x99",
+    "experimental-quantum-reasoner",
+    // some comment
    "existing-model",
    `;

    const extracted = extractModelIdentifiersFromDiff(mockDiff);
    assert.deepEqual(extracted, [
      'unannounced-future-model-x99',
      'experimental-quantum-reasoner',
    ]);
  });

  it('should dynamically extract arbitrary model slugs from ChatGPT chunk JS', () => {
    const mockJs = `
      const config = {
        model_slug: "stealth-frontier-preview",
        default_model: "autonomous-coder-v1",
        timeout: 30000
      };
    `;

    const extracted = extractDynamicModelIdentifiers(mockJs);
    assert.ok(extracted.includes('stealth-frontier-preview'));
    assert.ok(extracted.includes('autonomous-coder-v1'));
    assert.equal(extracted.length, 2);
  });

  it('should dynamically extract arbitrary model IDs from Claude chunk JS', () => {
    const mockJs = `
      function getModel() {
        return { modelId: "secret-hybrid-agent-77", isDefault: true };
      }
    `;

    const extracted = extractDynamicClaudeIdentifiers(mockJs);
    assert.deepEqual(extracted, ['secret-hybrid-agent-77']);
  });
});

describe('Discord Embed Builder', () => {
  it('should build rich embed for Artificial Analysis new model', () => {
    const model = {
      name: 'Arbitrary New Model',
      slug: 'arbitrary-new-model',
      url: 'https://artificialanalysis.ai/models/arbitrary-new-model',
    };
    const embed = buildArtificialAnalysisEmbed(model);
    assert.ok(embed.title.includes('Artificial Analysis'));
    assert.equal(embed.color, RADAR_CONFIG.colors.artificialAnalysis);
    assert.equal(embed.fields[0].value, 'Arbitrary New Model');
    assert.equal(embed.fields[1].value, '`arbitrary-new-model`');
  });

  it('should build rich embed for ChatGPT web app build deployment', () => {
    const event = {
      manifestHash: '1a91f86c',
      prevHash: 'old99999',
      manifestUrl: 'https://chatgpt.com/cdn/assets/manifest-1a91f86c.js',
      totalChunks: 6721,
    };
    const embed = buildChatGPTBuildEmbed(event);
    assert.ok(embed.title.includes('ChatGPT Web App'));
    assert.equal(embed.color, RADAR_CONFIG.colors.chatgpt);
    assert.equal(embed.fields[0].value, '`1a91f86c`');
    assert.equal(embed.fields[1].value, '`old99999`');
  });

  it('should build rich embed for Claude web app build deployment', () => {
    const event = {
      entryHash: 'PYSO3vVA',
      prevHash: 'OLDHASH1',
      entryUrl: 'https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/index-PYSO3vVA.js',
    };
    const embed = buildClaudeBuildEmbed(event);
    assert.ok(embed.title.includes('Claude.ai'));
    assert.equal(embed.color, RADAR_CONFIG.colors.claude);
    assert.equal(embed.fields[0].value, '`PYSO3vVA`');
  });

  it('should build rich embed for SDK model commit with dynamic additions', () => {
    const event = {
      repo: 'openai/openai-python',
      filePath: 'src/openai/types/shared/chat_model.py',
      sha: '5b43cceea4a25bc1b9ed1b08f087408b47981083',
      shortSha: '5b43cce',
      author: 'Justin Beckwith',
      message: 'chore(api): update model enum (#4199)',
      commitUrl: 'https://github.com/openai/openai-python/commit/5b43cce',
      additions: ['"brand-new-unannounced-model"', '"secret-reasoner"'],
    };
    const embed = buildSdkCommitEmbed(event);
    assert.ok(embed.title.includes('OpenAI SDK'));
    assert.equal(embed.color, RADAR_CONFIG.colors.chatgpt);
    assert.ok(embed.fields.some((f) => f.name === 'Model Enum Additions'));
    const additionsField = embed.fields.find((f) => f.name === 'Model Enum Additions');
    assert.ok(additionsField.value.includes('brand-new-unannounced-model'));
  });
});
