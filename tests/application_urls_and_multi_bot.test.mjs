import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  extractApplicationUrls,
  cleanAndValidateUrl,
  categorizeUrl,
} from '../reverse-tracker/extraction/urls.mjs';
import { TelegramClient } from '../reverse-tracker/telegram/client.mjs';
import { generateReportBundle } from '../reverse-tracker/reports/bundle.mjs';

test('cleanAndValidateUrl extracts valid URLs and rejects noise and local assets', () => {
  // Valid endpoints
  assert.equal(
    cleanAndValidateUrl('https://downloads.claude.ai/model-catalogue/v1/catalog.json\','),
    'https://downloads.claude.ai/model-catalogue/v1/catalog.json'
  );
  assert.equal(
    cleanAndValidateUrl('"https://api.openai.com/v1/chat/completions";'),
    'https://api.openai.com/v1/chat/completions'
  );
  assert.equal(
    cleanAndValidateUrl('https://cursor.com/api/download/appcast.xml)'),
    'https://cursor.com/api/download/appcast.xml'
  );
  assert.equal(
    cleanAndValidateUrl('/model-catalogue/v1/catalog.json'),
    '/model-catalogue/v1/catalog.json'
  );
  assert.equal(
    cleanAndValidateUrl('/v1/models/preview'),
    '/v1/models/preview'
  );

  // Noise rejection
  assert.equal(cleanAndValidateUrl('http://www.w3.org/2000/svg'), null, 'Must reject W3C XML namespace');
  assert.equal(cleanAndValidateUrl('http://schemas.microsoft.com/office'), null, 'Must reject schema namespace');
  assert.equal(cleanAndValidateUrl('http://localhost:8080/api'), null, 'Must reject localhost');
  assert.equal(cleanAndValidateUrl('https://127.0.0.1/test'), null, 'Must reject 127.0.0.1');
  assert.equal(cleanAndValidateUrl('https://github.com/facebook/react'), null, 'Must reject GitHub repo URL');
  assert.equal(cleanAndValidateUrl('https://cdn.example.com/logo.svg'), null, 'Must reject static SVG asset');
  assert.equal(cleanAndValidateUrl('https://cdn.example.com/icon.ico'), null, 'Must reject static ICO asset');
  assert.equal(cleanAndValidateUrl('/Users/john/Desktop/app.js'), null, 'Must reject local user path');
  assert.equal(cleanAndValidateUrl('/node_modules/lodash/index.js'), null, 'Must reject node_modules path');
});

test('categorizeUrl correctly groups URLs into operational categories', () => {
  assert.equal(
    categorizeUrl('https://downloads.claude.ai/model-catalogue/v1/catalog.json'),
    'CATALOG_AND_UPDATES'
  );
  assert.equal(
    categorizeUrl('https://persistent.oaistatic.com/sidecar-channel/mac-sparkle.xml'),
    'CATALOG_AND_UPDATES'
  );
  assert.equal(
    categorizeUrl('https://api.anthropic.com/v1/models'),
    'MODEL_AND_AI_APIS'
  );
  assert.equal(
    categorizeUrl('https://generativelanguage.googleapis.com/v1beta/models'),
    'MODEL_AND_AI_APIS'
  );
  assert.equal(
    categorizeUrl('https://service.internal.openai.com/v1/canary'),
    'INTERNAL_AND_STAGING'
  );
  assert.equal(
    categorizeUrl('https://featuregates.org/v1/download_specs'),
    'CATALOG_AND_UPDATES' // matches download_specs
  );
  assert.equal(
    categorizeUrl('https://statsigapi.net/v1/initialize'),
    'REMOTE_CONFIG_AND_FLAGS'
  );
  assert.equal(
    categorizeUrl('https://storage.googleapis.com/claude-desktop-releases/latest.yml'),
    'CATALOG_AND_UPDATES' // matches latest.yml
  );
});

test('extractApplicationUrls parses mixed binary buffer and extracts categorized endpoints', () => {
  const binaryContent = Buffer.from(
    'garbage\x00\x01\x02' +
    'const CATALOG = "https://downloads.claude.ai/model-catalogue/v1/catalog.json";' +
    '\x00\x00some_noise\x00\x00' +
    'endpoint: "https://api.anthropic.com/v1/models/preview",' +
    'w3c: "http://www.w3.org/2000/svg",' +
    'icon: "https://assets.claude.ai/favicon.ico",' +
    'route: "/model-catalogue/v1/catalog.json"'
  );

  const urls = extractApplicationUrls(binaryContent);
  const urlStrings = urls.map((u) => u.url);

  assert.ok(urlStrings.includes('https://downloads.claude.ai/model-catalogue/v1/catalog.json'));
  assert.ok(urlStrings.includes('https://api.anthropic.com/v1/models/preview'));
  assert.ok(urlStrings.includes('/model-catalogue/v1/catalog.json'));

  // Noise must not be present
  assert.ok(!urlStrings.includes('http://www.w3.org/2000/svg'), 'Must not include W3C namespace');
  assert.ok(!urlStrings.includes('https://assets.claude.ai/favicon.ico'), 'Must not include favicon icon');
});

test('TelegramClient resolves family-specific bot tokens and falls back gracefully', () => {
  // Test OpenAI / ChatGPT bot token resolution
  process.env.TELEGRAM_BOT_TOKEN_OPENAI = 'bot-openai-12345';
  process.env.TELEGRAM_BOT_TOKEN_ANTHROPIC = 'bot-claude-67890';
  process.env.TELEGRAM_TOKEN = 'fallback-token-00000';
  process.env.TELEGRAM_CHAT_ID = '-1001234567890';

  const clientOpenAI = new TelegramClient(null, null, 'openai');
  assert.equal(clientOpenAI.token, 'bot-openai-12345');

  const clientAnthropic = new TelegramClient(null, null, 'anthropic');
  assert.equal(clientAnthropic.token, 'bot-claude-67890');

  // Fallback test
  const clientGoogle = new TelegramClient(null, null, 'google');
  assert.equal(clientGoogle.token, 'fallback-token-00000', 'Must fallback to general token');

  // Cleanup
  delete process.env.TELEGRAM_BOT_TOKEN_OPENAI;
  delete process.env.TELEGRAM_BOT_TOKEN_ANTHROPIC;
  delete process.env.TELEGRAM_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
});

test('generateReportBundle produces categorized urls.txt with new endpoints highlighted', () => {
  const tmpDir = path.join(os.tmpdir(), `tracker-urls-test-${Date.now()}`);

  const scanData = {
    scanId: 'CD-20261107-001',
    componentId: 'claude-desktop',
    family: 'anthropic',
    version: '0.8.2',
    oldVersion: '0.8.1',
    diffResults: {
      newFindings: [],
      persistentFindings: [],
      removedFindings: [],
      reintroducedFindings: [],
    },
    scoredFindings: [],
    urlsInventory: [
      { url: 'https://downloads.claude.ai/model-catalogue/v1/catalog.json', category: 'CATALOG_AND_UPDATES' },
      { url: 'https://api.anthropic.com/v1/models', category: 'MODEL_AND_AI_APIS' },
    ],
    newUrls: [
      { url: 'https://downloads.claude.ai/model-catalogue/v1/catalog.json', category: 'CATALOG_AND_UPDATES' },
    ],
    platformAsymmetry: { macOnly: [], winOnly: [] },
    coverage: { percentage: 100, macOk: true, winOk: true },
    totalExtractedStrings: 10,
    artifactInventory: [],
  };

  const bundle = generateReportBundle(tmpDir, scanData);

  assert.ok(fs.existsSync(path.join(tmpDir, 'urls.txt')));
  assert.ok(bundle.telegramFiles.some((f) => f.endsWith('urls.txt')), 'urls.txt must be included in telegramFiles');

  const urlsContent = fs.readFileSync(path.join(tmpDir, 'urls.txt'), 'utf8');
  assert.ok(urlsContent.includes('APPLICATION ENDPOINTS & ROUTES INVENTORY'));
  assert.ok(urlsContent.includes('NEWLY INTRODUCED ENDPOINTS IN THIS RELEASE'));
  assert.ok(urlsContent.includes('https://downloads.claude.ai/model-catalogue/v1/catalog.json'));
  assert.ok(urlsContent.includes('CATALOG & AUTO-UPDATE FEEDS'));
  assert.ok(urlsContent.includes('MODEL & INFERENCE APIS'));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
