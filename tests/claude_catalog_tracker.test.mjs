/**
 * Unit Tests for Claude Model Catalog Tracker
 * Verifies catalog normalization, multi-surface model aggregation, deep diff engine,
 * Discord embed generation, and Telegram HTML formatting.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { extractCatalogData } from '../claude-tracker/extractor.mjs';
import { computeCatalogDiff } from '../claude-tracker/diff.mjs';
import {
  buildClaudeDiscordEmbed,
  formatClaudeTelegramSummary,
} from '../claude-tracker/notifier.mjs';

// Sample mock raw catalog matching official downloads.claude.ai schema
const mockRawCatalog = {
  $schema: 'https://downloads.claude.ai/model-catalog/v1/schema.json',
  schema_version: 1,
  version: 5394,
  issued_at: '2026-11-19T09:08:09Z',
  expires_at: '2026-11-26T09:08:09Z',
  key_id: 'claude-code-release-signing-key',
  surfaces: {
    cc: {
      model_selector_state: [
        {
          id: 'cc',
          model: 'claude-opus-5-5',
          thinking: { type: 'effort', effort: 'medium' },
        },
      ],
      model_selector_config: {
        0: {
          id: '0',
          provider_alias_targets: {
            opus: {
              default: 'claude-opus-5-5',
              per_provider: { bedrock: 'claude-opus-5-5' },
            },
            sonnet: {
              default: 'claude-sonnet-5-5',
            },
          },
          models: [
            {
              id: 'claude-opus-5-5',
              name: 'Opus 5.5',
              short_name: 'Opus',
              description: 'Flagship frontier model',
              section: 'main',
              capabilities: {
                compass: true,
                web_search: true,
                mm_images: true,
              },
              thinking: {
                type: 'effort',
                effort_options: [
                  { id: 'low', name: 'Low' },
                  { id: 'medium', name: 'Medium' },
                  { id: 'high', name: 'High' },
                  { id: 'xhigh', name: 'Extra' },
                  { id: 'max', name: 'Max' },
                ],
              },
              min_claude_code_version: '2.1.280',
              runtime: {
                max_input_tokens: 1000000,
                max_output_tokens: 128000,
                effort_levels: ['low', 'medium', 'high', 'xhigh', 'max'],
                default_effort: 'medium',
                family: 'opus',
              },
              offered_on: ['first_party', 'bedrock', 'vertex'],
            },
            {
              id: 'claude-sonnet-4-6',
              name: 'Sonnet 4.6',
              section: 'main',
              runtime: {
                max_input_tokens: 200000,
                max_output_tokens: 64000,
                family: 'sonnet',
              },
              offered_on: ['first_party'],
            },
          ],
        },
      },
    },
    chat: {
      model_selector_state: [
        {
          id: 'chat',
          model: 'claude-sonnet-4-6',
        },
      ],
      model_selector_config: {
        0: {
          models: [
            {
              id: 'claude-opus-5-5',
              name: 'Opus 5.5',
              voice_model: 'claude-opus-5',
            },
            {
              id: 'claude-sonnet-4-6',
              name: 'Sonnet 4.6',
            },
          ],
        },
      },
    },
  },
};

describe('Claude Model Catalog Extractor', () => {
  it('should parse envelope metadata and unique models across surfaces', () => {
    const extracted = extractCatalogData(mockRawCatalog);

    assert.equal(extracted.version, 5394);
    assert.equal(extracted.keyId, 'claude-code-release-signing-key');
    assert.equal(extracted.totalModels, 2);
    assert.deepEqual(extracted.surfaces, ['cc', 'chat']);

    // Model aggregation across surfaces (cc + chat)
    const opus = extracted.modelsById['claude-opus-5-5'];
    assert.ok(opus);
    assert.equal(opus.name, 'Opus 5.5');
    assert.equal(opus.family, 'opus');
    assert.equal(opus.maxInputTokens, 1000000);
    assert.equal(opus.maxOutputTokens, 128000);
    assert.deepEqual(opus.surfaces, ['cc', 'chat']);
    assert.equal(opus.voiceModel, 'claude-opus-5');
    assert.equal(opus.minClaudeCodeVersion, '2.1.280');
    assert.ok(opus.capabilities.includes('compass'));
    assert.ok(opus.capabilities.includes('web_search'));

    // Surface Defaults
    assert.equal(extracted.surfaceDefaults.cc, 'claude-opus-5-5');
    assert.equal(extracted.surfaceDefaults.chat, 'claude-sonnet-4-6');

    // Provider Aliases
    assert.equal(extracted.providerAliases.opus.default, 'claude-opus-5-5');
    assert.equal(extracted.providerAliases.opus.per_provider.bedrock, 'claude-opus-5-5');
  });

  it('should reject malformed raw catalog payloads', () => {
    assert.throws(() => extractCatalogData(null), /expected object/);
    assert.throws(() => extractCatalogData('invalid string'), /expected object/);
  });
});

describe('Claude Model Catalog Diff Engine', () => {
  it('should handle initial baseline calibration with zero noise', () => {
    const current = extractCatalogData(mockRawCatalog);
    const diff = computeCatalogDiff(current, null);

    assert.equal(diff.isFirstRun, true);
    assert.equal(diff.hasChanges, false);
    assert.equal(diff.newModels.length, 0);
  });

  it('should detect identical catalogs as zero changes (Cache Hit)', () => {
    const current = extractCatalogData(mockRawCatalog);
    const diff = computeCatalogDiff(current, current);

    assert.equal(diff.isFirstRun, false);
    assert.equal(diff.hasChanges, false);
    assert.equal(diff.versionChanged, false);
    assert.equal(diff.newModels.length, 0);
  });

  it('should detect new model addition and version bump', () => {
    const previous = extractCatalogData(mockRawCatalog);

    // Create next version with a new model
    const updatedRaw = JSON.parse(JSON.stringify(mockRawCatalog));
    updatedRaw.version = 5395;
    updatedRaw.surfaces.cc.model_selector_config[0].models.push({
      id: 'claude-fable-5-2',
      name: 'Fable 5.2',
      runtime: {
        family: 'fable',
        max_input_tokens: 1000000,
        max_output_tokens: 128000,
      },
    });

    const current = extractCatalogData(updatedRaw);
    const diff = computeCatalogDiff(current, previous);

    assert.equal(diff.hasChanges, true);
    assert.equal(diff.versionChanged, true);
    assert.equal(diff.previousVersion, 5394);
    assert.equal(diff.currentVersion, 5395);
    assert.equal(diff.newModels.length, 1);
    assert.equal(diff.newModels[0].id, 'claude-fable-5-2');
  });

  it('should detect context window and capability expansions on existing models', () => {
    const previous = extractCatalogData(mockRawCatalog);

    const updatedRaw = JSON.parse(JSON.stringify(mockRawCatalog));
    const sonnet = updatedRaw.surfaces.cc.model_selector_config[0].models.find(
      (m) => m.id === 'claude-sonnet-4-6'
    );
    sonnet.runtime.max_output_tokens = 128000;
    sonnet.runtime.capabilities = ['compass', 'agentic_tools'];

    const current = extractCatalogData(updatedRaw);
    const diff = computeCatalogDiff(current, previous);

    assert.equal(diff.hasChanges, true);
    assert.equal(diff.specChanges.length, 1);
    assert.equal(diff.specChanges[0].id, 'claude-sonnet-4-6');
    assert.ok(diff.specChanges[0].changes.some((c) => c.includes('Max output tokens changed')));
  });

  it('should detect active surface default model shifts', () => {
    const previous = extractCatalogData(mockRawCatalog);

    const updatedRaw = JSON.parse(JSON.stringify(mockRawCatalog));
    updatedRaw.surfaces.chat.model_selector_state[0].model = 'claude-opus-5-5';

    const current = extractCatalogData(updatedRaw);
    const diff = computeCatalogDiff(current, previous);

    assert.equal(diff.hasChanges, true);
    assert.equal(diff.surfaceDefaultChanges.length, 1);
    assert.equal(diff.surfaceDefaultChanges[0].surface, 'chat');
    assert.equal(diff.surfaceDefaultChanges[0].previous, 'claude-sonnet-4-6');
    assert.equal(diff.surfaceDefaultChanges[0].current, 'claude-opus-5-5');
  });

  it('should detect provider alias target updates', () => {
    const previous = extractCatalogData(mockRawCatalog);

    const updatedRaw = JSON.parse(JSON.stringify(mockRawCatalog));
    updatedRaw.surfaces.cc.model_selector_config[0].provider_alias_targets.sonnet.default = 'claude-sonnet-4-6';

    const current = extractCatalogData(updatedRaw);
    const diff = computeCatalogDiff(current, previous);

    assert.equal(diff.hasChanges, true);
    assert.equal(diff.aliasTargetChanges.length, 1);
    assert.equal(diff.aliasTargetChanges[0].alias, 'sonnet');
    assert.equal(diff.aliasTargetChanges[0].previous, 'claude-sonnet-5-5');
    assert.equal(diff.aliasTargetChanges[0].current, 'claude-sonnet-4-6');
  });
});

describe('Claude Model Catalog Notifier & Formatters', () => {
  it('should generate valid Discord embed adhering to field size limits', () => {
    const catalog = extractCatalogData(mockRawCatalog);
    const diff = {
      isFirstRun: false,
      hasChanges: true,
      versionChanged: true,
      previousVersion: 5393,
      currentVersion: 5394,
      newModels: [catalog.models[0]],
      removedModels: [],
      specChanges: [
        {
          id: 'claude-opus-5-5',
          name: 'Opus 5.5',
          changes: ['Expanded context to 1M tokens'],
        },
      ],
      surfaceDefaultChanges: [
        {
          surface: 'chat',
          previous: 'claude-sonnet-4-6',
          current: 'claude-opus-5-5',
        },
      ],
      aliasTargetChanges: [
        {
          alias: 'opus',
          provider: 'default',
          previous: 'claude-opus-4-6',
          current: 'claude-opus-5-5',
        },
      ],
      totalModels: catalog.totalModels,
    };

    const embed = buildClaudeDiscordEmbed(diff, catalog);

    assert.ok(embed.title.includes('New Model'));
    assert.equal(embed.color, 0xd97706);
    assert.ok(embed.fields.length >= 6);

    for (const f of embed.fields) {
      assert.ok(f.name.length <= 256, `Field name too long: ${f.name}`);
      assert.ok(f.value.length <= 1024, `Field value too long in: ${f.name}`);
    }
  });

  it('should format clean Telegram HTML text strictly within 4000 character limit', () => {
    const catalog = extractCatalogData(mockRawCatalog);
    const diff = {
      isFirstRun: false,
      hasChanges: true,
      versionChanged: true,
      previousVersion: 5393,
      currentVersion: 5394,
      newModels: catalog.models,
      removedModels: [],
      specChanges: [
        {
          id: 'claude-opus-5-5',
          name: 'Opus 5.5',
          changes: ['Expanded output to 128k'],
        },
      ],
      surfaceDefaultChanges: [],
      aliasTargetChanges: [],
      totalModels: catalog.totalModels,
    };

    const text = formatClaudeTelegramSummary(diff, catalog);

    assert.ok(text.length < 4000, `Telegram text length (${text.length}) exceeds 4000 limit`);
    assert.ok(text.includes('<b>CLAUDE MODEL CATALOG'));
    assert.ok(text.includes('claude-opus-5-5'));
    assert.ok(text.includes('downloads.claude.ai/model-catalog/v1/catalog.json'));
    // Ensure tags are balanced
    assert.equal((text.match(/<b>/g) || []).length, (text.match(/<\/b>/g) || []).length);
    assert.equal((text.match(/<code>/g) || []).length, (text.match(/<\/code>/g) || []).length);
  });
});
