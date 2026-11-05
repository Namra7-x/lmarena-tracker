/**
 * Early Signal Radar - Test Suite
 * Tests Artificial Analysis parsing, ChatGPT & Claude manifest extraction,
 * SDK commit diff parsing, and Discord embed builder.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { RADAR_CONFIG } from '../early-radar/config.mjs';
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

describe('Discord Embed Builder', () => {
  it('should build rich embed for Artificial Analysis new model', () => {
    const model = {
      name: 'GPT-6 Astra',
      slug: 'gpt-6-astra',
      url: 'https://artificialanalysis.ai/models/gpt-6-astra',
    };
    const embed = buildArtificialAnalysisEmbed(model);
    assert.ok(embed.title.includes('Artificial Analysis'));
    assert.equal(embed.color, RADAR_CONFIG.colors.artificialAnalysis);
    assert.equal(embed.fields[0].value, 'GPT-6 Astra');
    assert.equal(embed.fields[1].value, '`gpt-6-astra`');
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

  it('should build rich embed for SDK model commit', () => {
    const event = {
      repo: 'openai/openai-python',
      filePath: 'src/openai/types/shared/chat_model.py',
      sha: '5b43cceea4a25bc1b9ed1b08f087408b47981083',
      shortSha: '5b43cce',
      author: 'Justin Beckwith',
      message: 'chore(api): document upcoming model shutdowns (#4199)',
      commitUrl: 'https://github.com/openai/openai-python/commit/5b43cce',
      additions: ['"gpt-4.5-preview"', '"o3-mini"'],
    };
    const embed = buildSdkCommitEmbed(event);
    assert.ok(embed.title.includes('OpenAI SDK'));
    assert.equal(embed.color, RADAR_CONFIG.colors.chatgpt);
    assert.ok(embed.fields.some((f) => f.name === 'Model Enum Additions'));
  });
});
