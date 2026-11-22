import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeLeakDiff } from '../leak-tracker/diff.mjs';
import { isGenuineAiModelSku } from '../leak-tracker/fetcher.mjs';
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

  it('should filter out enterprise IT noise and accept genuine AI model pricing lines', () => {
    // 1. Genuine frontier models & modalities -> ACCEPT
    assert.strictEqual(isGenuineAiModelSku({ productName: 'Azure OpenAI GPT5', skuName: '5.4 opt Dz' }), true);
    assert.strictEqual(isGenuineAiModelSku({ productName: 'Azure Grok Models', skuName: 'Grok 4.2 Inp Dzone' }), true);
    assert.strictEqual(isGenuineAiModelSku({ productName: 'Azure OpenAI Media', skuName: 'gpt-realtime-2 Image cd inp Gl' }), true);
    assert.strictEqual(isGenuineAiModelSku({ productName: 'Azure Kimi', skuName: 'K2 Thinking Inp DZ' }), true);
    assert.strictEqual(isGenuineAiModelSku({ productName: 'Cohere Models', skuName: 'Command A Plus Inp DZ' }), true);
    assert.strictEqual(isGenuineAiModelSku({ productName: 'Azure OpenAI', skuName: 'gpt-4.1-ft mdl grdr inpt' }), true);
    assert.strictEqual(isGenuineAiModelSku({ productName: 'Foundry Models', skuName: 'DeepSeek R1 Reasoning Inp' }), true);

    // 2. Legacy enterprise IT / Cognitive Services utilities -> REJECT
    assert.strictEqual(isGenuineAiModelSku({ productName: 'Bing Spell Check v5', skuName: 'S1 Transactions' }), false);
    assert.strictEqual(isGenuineAiModelSku({ productName: 'Emotion', skuName: 'Standard' }), false);
    assert.strictEqual(isGenuineAiModelSku({ productName: 'Form Recognizer', skuName: 'Custom Forms' }), false);
    assert.strictEqual(isGenuineAiModelSku({ productName: 'Speaker Identification', skuName: 'Standard Identification' }), false);
    assert.strictEqual(isGenuineAiModelSku({ productName: 'Custom Speech', skuName: 'Model Training' }), false);
    assert.strictEqual(isGenuineAiModelSku({ productName: 'Anomaly Detector', skuName: 'Standard' }), false);
    assert.strictEqual(isGenuineAiModelSku({ productName: 'Content Moderator', skuName: 'S0' }), false);
    assert.strictEqual(isGenuineAiModelSku({ productName: 'Machine Learning Studio Production Web API', skuName: 'Standard' }), false);
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

  it('should split 28 Azure Retail SKUs across multi-embed chunks with zero omissions', () => {
    const sampleSkus = Array.from({ length: 28 }, (_, i) => ({
      productName: `Azure OpenAI Model ${i + 1}`,
      skuName: `SKU-${i + 1}`,
      retailPrice: 10 + i,
      unitOfMeasure: '1M',
      effectiveStartDate: '2026-11-22T00:00:00Z',
      feedName: 'Foundry Models',
    }));

    const embeds = buildAzureRetailPricesEmbed(sampleSkus);
    assert.strictEqual(embeds.length, 2);

    // Part 1
    assert.ok(embeds[0].title.includes('(28) [Part 1/2]'));
    assert.strictEqual(embeds[0].fields.length, 15);
    assert.ok(embeds[0].fields[0].name.includes('Azure OpenAI Model 1'));
    assert.ok(embeds[0].fields[14].name.includes('Azure OpenAI Model 15'));

    // Part 2
    assert.ok(embeds[1].title.includes('(28) [Part 2/2]'));
    assert.strictEqual(embeds[1].fields.length, 13);
    assert.ok(embeds[1].fields[0].name.includes('Azure OpenAI Model 16'));
    assert.ok(embeds[1].fields[12].name.includes('Azure OpenAI Model 28'));

    // Verify zero truncation / no "+X more" text
    const totalFields = embeds[0].fields.length + embeds[1].fields.length;
    assert.strictEqual(totalFields, 28);
    for (const embed of embeds) {
      for (const field of embed.fields) {
        assert.ok(!field.value.includes('more retail pricing rows'));
      }
    }

    // Verify backward compatibility property access on array
    assert.ok(embeds.title.includes('(28) [Part 1/2]'));
    assert.strictEqual(embeds.color, LEAK_CONFIG.colors.azure);
    assert.strictEqual(embeds.fields.length, 15);
  });
});
