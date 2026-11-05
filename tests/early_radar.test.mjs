/**
 * Early Signal Radar - Test Suite
 * Tests Artificial Analysis parsing, ChatGPT & Claude manifest extraction,
 * SDK commit diff parsing, deep build analyzer, and Discord embed builder.
 * Verifies ZERO HARDCODED MODEL NAMES.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { RADAR_CONFIG } from '../early-radar/config.mjs';
import { extractModelIdentifiersFromDiff } from '../early-radar/sources/sdk_commits.mjs';
import { extractDynamicModelIdentifiers } from '../early-radar/sources/chatgpt_manifest.mjs';
import { extractDynamicClaudeIdentifiers } from '../early-radar/sources/claude_manifest.mjs';
import { analyzeChunkContent, writeBuildReport } from '../early-radar/analyzer.mjs';
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

describe('Deep Build Analyzer & Reports', () => {
  it('should extract feature gates, tools, launch copy, and models from chunk text', () => {
    const mockChunk = `
      const gates = ["can_see_autonomous_tasks", "enable_deep_reasoning_v2"];
      const tool = { name: "terminal_sandbox_action" };
      const banner = "Introducing Project Titan: A new paradigm in reasoning";
      const settings = { model_slug: "titan-preview" };
    `;

    const analysis = analyzeChunkContent(mockChunk);
    assert.ok(analysis.models.includes('titan-preview'));
    assert.ok(analysis.featureGates.includes('can_see_autonomous_tasks'));
    assert.ok(analysis.featureGates.includes('enable_deep_reasoning_v2'));
    assert.ok(analysis.toolSchemas.includes('terminal_sandbox_action'));
    assert.ok(analysis.launchCopy.some((c) => c.includes('Introducing Project Titan')));
  });

  it('should generate a permanent markdown report file without errors', () => {
    const analysis = {
      models: ['titan-preview'],
      featureGates: ['can_see_autonomous_tasks'],
      toolSchemas: ['terminal_sandbox_action'],
      launchCopy: ['Introducing Project Titan'],
    };

    const url = writeBuildReport('ChatGPT', 'test1234', analysis);
    assert.ok(url.includes('BUILD_chatgpt_test1234.md'));
  });
});

describe('Discord Embed Builder', () => {
  it('should build rich embed for Artificial Analysis new model with JSON block', () => {
    const model = {
      name: 'Arbitrary New Model',
      slug: 'arbitrary-new-model',
      url: 'https://artificialanalysis.ai/models/arbitrary-new-model',
      creator: 'Test Lab',
      rawJson: {
        name: 'Arbitrary New Model',
        slug: 'arbitrary-new-model',
        parameters: '100B',
      },
    };
    const embed = buildArtificialAnalysisEmbed(model);
    assert.ok(embed.title.includes('Artificial Analysis'));
    assert.equal(embed.color, RADAR_CONFIG.colors.artificialAnalysis);
    assert.ok(embed.fields.some((f) => f.name.includes('Raw JSON Block')));
    const jsonField = embed.fields.find((f) => f.name.includes('Raw JSON Block'));
    assert.ok(jsonField.value.includes('```json'));
    assert.ok(jsonField.value.includes('arbitrary-new-model'));
  });

  it('should build rich embed for ChatGPT web app build deployment with detected models', () => {
    const event = {
      manifestHash: '1a91f86c',
      prevHash: 'old99999',
      manifestUrl: 'https://chatgpt.com/cdn/assets/manifest-1a91f86c.js',
      totalChunks: 6721,
      models: ['titan-preview'],
      featureGates: ['can_see_autonomous_tasks'],
      launchCopy: ['Introducing Project Titan'],
      reportUrl: 'https://github.com/Namra7-x/lmarena-tracker/blob/feat/early-radar/early-radar/reports/BUILD_chatgpt_1a91f86c.md',
    };
    const embed = buildChatGPTBuildEmbed(event);
    assert.ok(embed.title.includes('ChatGPT Web App'));
    assert.equal(embed.color, RADAR_CONFIG.colors.chatgpt);
    assert.ok(embed.fields.some((f) => f.name.includes('Discovered Model Slugs')));
    assert.ok(embed.fields.some((f) => f.name.includes('Feature Gates')));
    assert.ok(embed.fields.some((f) => f.name.includes('Quick Links') && f.value.includes('Unabridged Report')));
  });

  it('should build rich embed for Claude web app build deployment', () => {
    const event = {
      entryHash: 'PYSO3vVA',
      prevHash: 'OLDHASH1',
      entryUrl: 'https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/index-PYSO3vVA.js',
      models: ['claude-4-preview'],
      featureGates: ['can_see_computer_use_v2'],
    };
    const embed = buildClaudeBuildEmbed(event);
    assert.ok(embed.title.includes('Claude.ai'));
    assert.equal(embed.color, RADAR_CONFIG.colors.claude);
    assert.ok(embed.fields.some((f) => f.name.includes('Discovered Model Slugs')));
  });

  it('should build rich embed for SDK model commit with direct GitHub links', () => {
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
    assert.ok(embed.fields.some((f) => f.name.includes('Model Enum Additions')));
    assert.ok(embed.fields.some((f) => f.name.includes('Direct GitHub Links')));

    const linksField = embed.fields.find((f) => f.name.includes('Direct GitHub Links'));
    assert.ok(linksField.value.includes('View Commit Diff on GitHub'));
    assert.ok(linksField.value.includes('View Source File on GitHub'));
    assert.ok(linksField.value.includes('GitHub Commits API Endpoint'));
  });
});
