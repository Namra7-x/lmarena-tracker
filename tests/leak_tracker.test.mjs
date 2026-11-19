import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeLeakDiff } from '../leak-tracker/diff.mjs';
import {
  buildGcpSkuEmbed,
  buildAzureFoundryEmbed,
  buildAwsBedrockPricingEmbed,
  buildAzureRetailPricesEmbed,
  buildJumpstartProprietaryEmbed,
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
      awsBedrockPricing: { version: '20261119', products: [{ sku: 'BEDROCK-001', modelName: 'Claude Fable 5.2' }] },
      azureRetailPrices: [{ productName: 'Azure OpenAI GPT6', skuName: 'GPT 6.2 Chat' }],
      jumpstartProprietary: [{ modelId: 'voyage-code-3', version: '0.0.1' }],
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
      awsBedrockPricing: { version: '20261119', products: [{ sku: 'BEDROCK-001', modelName: 'Claude Fable' }] },
      azureRetailPrices: [{ productName: 'GPT6', skuName: 'Standard' }],
      jumpstartProprietary: [{ modelId: 'voyage-code-3', version: '0.0.1' }],
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

  it('should detect new GCP SKUs and route to Channel 1', () => {
    const baseline = {
      gcpSkus: [{ skuId: 'SKU-001', description: 'Gemini 2.5 Flash' }],
      azureFoundryModels: [],
      awsBedrockPricing: { products: [] },
      azureRetailPrices: [],
      jumpstartProprietary: [],
      openaiCodexModels: [],
      openaiCommits: [],
      openaiOpenapiYaml: { modelEnums: [] },
    };

    const current = {
      ...baseline,
      gcpSkus: [
        { skuId: 'SKU-001', description: 'Gemini 2.5 Flash' },
        { skuId: 'SKU-002', description: 'Gemini 4 Neon Global Audio Input', category: 'Vertex AI', service: 'C7E2', filter: 'token' },
      ],
    };

    const diff = computeLeakDiff(current, baseline);
    assert.strictEqual(diff.hasChanges, true);
    assert.strictEqual(diff.channel1.hasChanges, true);
    assert.strictEqual(diff.channel2.hasChanges, false);
    assert.strictEqual(diff.channel1.newGcpSkus.length, 1);
    assert.strictEqual(diff.channel1.newGcpSkus[0].skuId, 'SKU-002');
  });

  it('should detect new OpenAI Codex model slugs and route to Channel 2', () => {
    const baseline = {
      gcpSkus: [],
      azureFoundryModels: [],
      awsBedrockPricing: { products: [] },
      azureRetailPrices: [],
      jumpstartProprietary: [],
      openaiCodexModels: [{ slug: 'gpt-6.1-sol' }],
      openaiCommits: [],
      openaiOpenapiYaml: { modelEnums: [] },
    };

    const current = {
      ...baseline,
      openaiCodexModels: [
        { slug: 'gpt-6.1-sol' },
        { slug: 'gpt-6.2-sol', preferWebsockets: true, defaultVerbosity: 'low' },
      ],
    };

    const diff = computeLeakDiff(current, baseline);
    assert.strictEqual(diff.hasChanges, true);
    assert.strictEqual(diff.channel1.hasChanges, false);
    assert.strictEqual(diff.channel2.hasChanges, true);
    assert.strictEqual(diff.channel2.newCodexModels.length, 1);
    assert.strictEqual(diff.channel2.newCodexModels[0].slug, 'gpt-6.2-sol');
  });

  it('should detect new Azure Retail price rows and route to Channel 1', () => {
    const baseline = {
      gcpSkus: [],
      azureFoundryModels: [],
      awsBedrockPricing: { products: [] },
      azureRetailPrices: [{ productName: 'Azure OpenAI GPT5', skuName: 'GPT 5.1 Chat' }],
      jumpstartProprietary: [],
      openaiCodexModels: [],
      openaiCommits: [],
      openaiOpenapiYaml: { modelEnums: [] },
    };

    const current = {
      ...baseline,
      azureRetailPrices: [
        { productName: 'Azure OpenAI GPT5', skuName: 'GPT 5.1 Chat' },
        { productName: 'Azure OpenAI GPT6', skuName: 'GPT 6.2 Chat Gl', retailPrice: 15.0, unitOfMeasure: '1M tokens' },
      ],
    };

    const diff = computeLeakDiff(current, baseline);
    assert.strictEqual(diff.channel1.hasChanges, true);
    assert.strictEqual(diff.channel1.newAzureRetail.length, 1);
    assert.strictEqual(diff.channel1.newAzureRetail[0].productName, 'Azure OpenAI GPT6');
  });

  it('should detect new OpenAI OpenAPI commit and route to Channel 2', () => {
    const baseline = {
      gcpSkus: [],
      azureFoundryModels: [],
      awsBedrockPricing: { products: [] },
      azureRetailPrices: [],
      jumpstartProprietary: [],
      openaiCodexModels: [],
      openaiCommits: [{ id: 'commit-001' }],
      openaiOpenapiYaml: { modelEnums: [] },
    };

    const current = {
      ...baseline,
      openaiCommits: [
        { id: 'commit-002', title: 'Update default model from gpt-6-astra to gpt-6.2-astra', updated: '2026-11-19T01:28:03Z' },
        { id: 'commit-001', title: 'Initial' },
      ],
    };

    const diff = computeLeakDiff(current, baseline);
    assert.strictEqual(diff.channel2.hasChanges, true);
    assert.strictEqual(diff.channel2.newOpenaiCommits.length, 1);
    assert.strictEqual(diff.channel2.newOpenaiCommits[0].id, 'commit-002');
  });
});

describe('Leak Tracker — Notifier & Embed Formatters', () => {
  it('should build a valid GCP SKU embed with correct branding and links', () => {
    const sampleSkus = [
      { skuId: 'C1ED-5DE3', category: 'Gemini API', description: 'Gemini 4 Neon audio input', service: 'AEFD', filter: 'token' },
    ];
    const embed = buildGcpSkuEmbed(sampleSkus);

    assert.ok(embed.title.includes('Google Cloud SKU'));
    assert.strictEqual(embed.url, 'https://cloud.google.com/skus');
    assert.strictEqual(embed.color, LEAK_CONFIG.colors.google);
    assert.ok(embed.fields.length >= 1);
    assert.ok(embed.fields[0].value.includes('Gemini 4 Neon'));
  });

  it('should build a valid OpenAI Codex embed with correct branding and links', () => {
    const sampleModels = [
      { slug: 'gpt-6.2-astra', preferWebsockets: true, defaultVerbosity: 'low', applyPatchToolType: 'freeform' },
    ];
    const embed = buildOpenaiCodexEmbed(sampleModels);

    assert.ok(embed.title.includes('OpenAI Codex'));
    assert.strictEqual(embed.url, 'https://github.com/openai/codex/blob/main/codex-rs/models-manager/models.json');
    assert.strictEqual(embed.color, LEAK_CONFIG.colors.codex);
    assert.ok(embed.fields[0].name.includes('gpt-6.2-astra'));
  });

  it('should resolve correct webhook environment variable priority for channels', () => {
    const origEnv = { ...process.env };
    try {
      delete process.env.API_DISCORD_WEBHOOK_URL;
      delete process.env.API_TRACKER_DISCORD_WEBHOOK_URL;
      delete process.env.QWEN_DISCORD_WEBHOOK_URL;
      delete process.env.EARLY_RADAR_DISCORD_WEBHOOK_URL;
      delete process.env.RADAR_DISCORD_WEBHOOK_URL;
      delete process.env.DISCORD_WEBHOOK_URL;

      assert.strictEqual(getWebhookUrl('earlyModel'), null);
      assert.strictEqual(getWebhookUrl('commitAnalysis'), null);

      process.env.QWEN_DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/qwen-channel';
      process.env.EARLY_RADAR_DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/commits-channel';

      assert.strictEqual(getWebhookUrl('earlyModel'), 'https://discord.com/api/webhooks/qwen-channel');
      assert.strictEqual(getWebhookUrl('commitAnalysis'), 'https://discord.com/api/webhooks/commits-channel');
    } finally {
      process.env = origEnv;
    }
  });
});
