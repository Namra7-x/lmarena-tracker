import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeLeakDiff } from '../leak-tracker/diff.mjs';
import {
  buildGcpSkuEmbed,
  buildAzureFoundryEmbed,
  buildAwsBedrockMasterEmbed,
  buildAzureRetailPricesEmbed,
  buildGoogleVertexPricingEmbed,
  buildAwsOffersIndexEmbed,
  buildJumpstartProprietaryEmbed,
  buildAnthropicPythonSdkEmbed,
  buildGoogleGenaiPythonEmbed,
  buildOpenaiCodexEmbed,
  buildOpenaiCommitEmbed,
  buildOpenaiOpenapiEmbed,
  getWebhookUrl,
} from '../leak-tracker/notifier.mjs';
import { LEAK_CONFIG } from '../leak-tracker/config.mjs';

describe('Leak Tracker — Diffing Engine', () => {
  it('should initialize baseline with zero noise and no alert flags', () => {
    const current = {
      gcpSkus: [{ skuId: 'SKU-001', description: 'Gemini 3 Pro token', category: 'Gemini API' }],
      azureFoundryModels: [{ name: 'DeepSeek-V4', version: '1', publisher: 'DeepSeek' }],
      awsBedrockMaster: { version: '20261111', products: [{ sku: 'BEDROCK-001', modelName: 'Grok 4.7' }] },
      azureRetailPrices: [{ productName: 'Azure OpenAI GPT6', skuName: 'GPT 6.2 Chat' }],
      googleVertexPricingModels: ['gemini-4-argon', 'gemini-3.8-flash'],
      awsOffersIndex: { publicationDate: '2026-11-19', offerCodes: ['AmazonBedrock'] },
      jumpstartProprietary: [{ modelId: 'voyage-code-3', version: '0.0.1' }],
      anthropicPythonSdkModels: ['claude-mythos-preview', 'claude-mythos-5'],
      googleGenaiPythonModels: ['gemini-3.8-flash'],
      openaiCodexModels: [{ slug: 'gpt-6.2-astra' }],
      openaiCommits: [{ id: 'commit-101', title: 'Update default model' }],
      openaiOpenapiYaml: { version: '2.3.0', modelEnums: ['gpt-4o', 'gpt-6.2-astra'] },
    };

    const diff = computeLeakDiff(current, null);
    assert.strictEqual(diff.isFirstRun, true);
    assert.strictEqual(diff.hasChanges, false);
    assert.strictEqual(diff.channel1.hasChanges, false);
    assert.strictEqual(diff.channel2.hasChanges, false);
  });

  it('should detect identical snapshots as zero changes (Cache Hit)', () => {
    const state = {
      gcpSkus: [{ skuId: 'SKU-001', description: 'Gemini 3 Pro token' }],
      azureFoundryModels: [{ name: 'DeepSeek-V4', version: '1' }],
      awsBedrockMaster: { version: '20261111', products: [{ sku: 'BEDROCK-001', modelName: 'Grok 4.7' }] },
      azureRetailPrices: [{ productName: 'GPT6', skuName: 'Standard' }],
      googleVertexPricingModels: ['gemini-4-argon'],
      awsOffersIndex: { offerCodes: ['AmazonBedrock'] },
      jumpstartProprietary: [{ modelId: 'voyage-code-3', version: '0.0.1' }],
      anthropicPythonSdkModels: ['claude-mythos-5'],
      googleGenaiPythonModels: ['gemini-3.8-flash'],
      openaiCodexModels: [{ slug: 'gpt-6.2-astra' }],
      openaiCommits: [{ id: 'commit-101' }],
      openaiOpenapiYaml: { version: '2.3.0', modelEnums: ['gpt-4o'] },
    };

    const diff = computeLeakDiff(state, state);
    assert.strictEqual(diff.isFirstRun, false);
    assert.strictEqual(diff.hasChanges, false);
    assert.strictEqual(diff.channel1.hasChanges, false);
    assert.strictEqual(diff.channel2.hasChanges, false);
  });

  it('should detect Anthropic Python SDK claude-mythos type unions and route to Channel 2', () => {
    const baseline = {
      anthropicPythonSdkModels: ['claude-3-5-sonnet-20241022'],
    };

    const current = {
      ...baseline,
      anthropicPythonSdkModels: [
        'claude-3-5-sonnet-20241022',
        'claude-mythos-preview',
        'claude-mythos-5',
        'claude-fable-5-1',
      ],
    };

    const diff = computeLeakDiff(current, baseline);
    assert.strictEqual(diff.hasChanges, true);
    assert.strictEqual(diff.channel2.hasChanges, true);
    assert.strictEqual(diff.channel1.hasChanges, false);
    assert.strictEqual(diff.channel2.newAnthropicPythonModels.length, 3);
    assert.ok(diff.channel2.newAnthropicPythonModels.includes('claude-mythos-preview'));
  });

  it('should detect Google GenAI Python SDK gemini-3.8-flash and route to Channel 2', () => {
    const baseline = {
      googleGenaiPythonModels: ['gemini-2.0-flash'],
    };

    const current = {
      ...baseline,
      googleGenaiPythonModels: ['gemini-2.0-flash', 'gemini-3.8-flash', 'gemini-3-pro-preview'],
    };

    const diff = computeLeakDiff(current, baseline);
    assert.strictEqual(diff.channel2.hasChanges, true);
    assert.strictEqual(diff.channel2.newGoogleGenaiPythonModels.length, 2);
    assert.ok(diff.channel2.newGoogleGenaiPythonModels.includes('gemini-3.8-flash'));
  });

  it('should detect Google Vertex AI pricing table HTML leaks (gemini-4-argon) and route to Channel 1', () => {
    const baseline = {
      googleVertexPricingModels: ['gemini-1.5-pro'],
    };

    const current = {
      ...baseline,
      googleVertexPricingModels: ['gemini-1.5-pro', 'gemini-4-argon', 'gemini-3.8-flash', 'gemini-omni'],
    };

    const diff = computeLeakDiff(current, baseline);
    assert.strictEqual(diff.channel1.hasChanges, true);
    assert.strictEqual(diff.channel2.hasChanges, false);
    assert.strictEqual(diff.channel1.newVertexPricingModels.length, 3);
    assert.ok(diff.channel1.newVertexPricingModels.includes('gemini-4-argon'));
  });

  it('should detect AWS Bedrock Master pricing models (Grok 4.7, Kimi K2) and route to Channel 1', () => {
    const baseline = {
      awsBedrockMaster: { products: [{ sku: 'BEDROCK-OLD', modelName: 'OldModel' }] },
    };

    const current = {
      ...baseline,
      awsBedrockMaster: {
        products: [
          { sku: 'BEDROCK-OLD', modelName: 'OldModel' },
          { sku: 'BEDROCK-NEW-1', modelName: 'Grok 4.7', provider: 'xAI' },
          { sku: 'BEDROCK-NEW-2', modelName: 'Kimi K2 Thinking', provider: 'Moonshot' },
        ],
      },
    };

    const diff = computeLeakDiff(current, baseline);
    assert.strictEqual(diff.channel1.hasChanges, true);
    assert.strictEqual(diff.channel1.newBedrockMaster.length, 2);
  });
});

describe('Leak Tracker — Notifier & Embed Formatter Verification', () => {
  it('should format sleek Anthropic Python SDK embed with amber branding', () => {
    const embed = buildAnthropicPythonSdkEmbed(['claude-mythos-preview', 'claude-fable-5-1']);
    assert.ok(embed.title.includes('Anthropic Python SDK'));
    assert.strictEqual(embed.color, LEAK_CONFIG.colors.anthropic);
    assert.ok(embed.fields[0].value.includes('claude-mythos-preview'));
  });

  it('should format sleek Google Vertex Pricing embed with blue branding', () => {
    const embed = buildGoogleVertexPricingEmbed(['gemini-4-argon', 'gemini-3.8-flash']);
    assert.ok(embed.title.includes('Vertex AI Pricing Table'));
    assert.strictEqual(embed.color, LEAK_CONFIG.colors.google);
    assert.ok(embed.fields[0].value.includes('gemini-4-argon'));
  });

  it('should format sleek AWS Bedrock Master embed with orange branding', () => {
    const embed = buildAwsBedrockMasterEmbed([{ sku: 'SKU-01', modelName: 'Grok 4.7', provider: 'xAI' }], '20261111');
    assert.ok(embed.title.includes('AWS Bedrock (Master)'));
    assert.strictEqual(embed.color, LEAK_CONFIG.colors.aws);
    assert.ok(embed.fields[0].name.includes('Grok 4.7'));
  });
});
