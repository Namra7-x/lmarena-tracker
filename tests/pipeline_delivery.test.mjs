import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { detectChanges } from '../reverse-tracker/pipeline/detect.mjs';
import { performScan, selectArtifacts } from '../reverse-tracker/pipeline/scan.mjs';
import { loadComponentState } from '../reverse-tracker/state/store.mjs';

// These tests intentionally inject a downloader/extractor so they never touch
// the network. The checkpoint helper is a no-op outside Actions anyway.
process.env.DISABLE_STATE_CHECKPOINT = 'true';

const COMPONENT = 'codex-cli';

function makeCandidate(version) {
  return {
    componentId: COMPONENT,
    family: 'openai',
    version,
    stableVersion: version,
    versionScheme: 'semver',
    releaseId: `@openai/codex@${version}`,
    channel: 'stable',
    artifacts: [
      {
        target: 'all',
        url: `https://registry.npmjs.org/@openai/codex/-/codex-${version}.tgz`,
        format: 'tgz',
        type: 'tarball',
      },
    ],
    metadata: { npmPublished: '2026-11-16T00:00:00.000Z' },
  };
}

function makeExtractor({ withFlag = false } = {}) {
  return () => {
    const lines = [
      '{"model":"gpt-5-preview","input_price":2.5,"output_price":10,"context_window":200000}',
    ];
    if (withFlag) lines.push('enable_agentic_flow');
    return {
      files: [
        {
          path: 'package/catalog.json',
          buffer: Buffer.from(lines.join('\n'), 'utf8'),
          priority: 1,
        },
      ],
      status: {
        coverageState: 'COMPLETE',
        analyzers: {
          sevenZip: 'skipped',
          asar: 'skipped',
          tar: 'completed',
          zip: 'skipped',
        },
        error: null,
      },
    };
  };
}

function makeDownloader() {
  return async (artifact) => ({
    buffer: Buffer.from('fake artifact', 'utf8'),
    size: 13,
    sha256: 'a'.repeat(64),
    target: artifact.target,
    url: artifact.url,
    format: artifact.format,
  });
}

class FakeTelegram {
  constructor() {
    this.messages = [];
    this.documents = [];
    this.failDocuments = new Set();
  }

  getTopicId() {
    return undefined;
  }

  async sendMessage(text, options = {}) {
    this.messages.push({ text, options });
    return { ok: true, result: { message_id: this.messages.length } };
  }

  async sendDocument(filePath, caption = '') {
    const name = path.basename(filePath);
    if (this.failDocuments.has(name)) {
      return { ok: false, error: 'forced upload failure' };
    }
    this.documents.push({ name, filePath, caption });
    return { ok: true, result: { message_id: this.documents.length } };
  }
}

function makeTempDirs(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `tracker-pipeline-${label}-`));
  return {
    root,
    stateDir: path.join(root, 'state'),
    reportsDir: path.join(root, 'reports'),
  };
}

async function initBaseline(stateDir, version = '0.1.0') {
  return detectChanges(null, {
    stateDir,
    components: [COMPONENT],
    fetcher: async () => makeCandidate(version),
  });
}

function cleanup(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // Best-effort test cleanup.
  }
}

test('scan delivers the fixed six-file bundle, advances state, and does not re-alert', async () => {
  const { root, stateDir, reportsDir } = makeTempDirs('happy');
  try {
    await initBaseline(stateDir, '0.1.0');
    const tg = new FakeTelegram();
    const result = await performScan(COMPONENT, {
      candidate: makeCandidate('0.2.0'),
      stateDir,
      reportsDir,
      telegramClient: tg,
      downloadArtifact: makeDownloader(),
      extractArtifact: makeExtractor(),
    });

    assert.equal(result.coverageState, 'COMPLETE');
    assert.equal(result.delivery.status, 'DELIVERED');
    assert.equal(result.pendingDelivery, null);
    assert.equal(tg.documents.length, 6, 'fixed six-file report bundle');
    assert.deepEqual(
      tg.documents.map((doc) => doc.name).sort(),
      [
        'diff.txt',
        'leaks.txt',
        'models-and-pricing.txt',
        'scan-summary.txt',
        'strings.txt',
        'urls.txt',
      ].sort(),
    );

    const state = loadComponentState(stateDir, COMPONENT);
    assert.equal(state.version, '0.2.0');
    assert.equal(state.deliveredVersion, '0.2.0');
    assert.equal(state.pendingDelivery, null);
    assert.equal(state.coverageState, 'COMPLETE');

    const alerts = tg.messages.filter((m) => m.text.includes('Version Change'));
    assert.equal(alerts.length, 1, 'one immediate alert');

    const changes = await detectChanges(null, {
      stateDir,
      components: [COMPONENT],
      fetcher: async () => makeCandidate('0.2.0'),
    });
    assert.equal(changes.length, 0, 'same release must not re-alert');
    assert.equal(
      tg.messages.filter((m) => m.text.includes('Version Change')).length,
      1,
    );
  } finally {
    cleanup(root);
  }
});

test('completion suppresses persistent signals while leaks.txt keeps full history tags', async () => {
  const { root, stateDir, reportsDir } = makeTempDirs('diff');
  try {
    await initBaseline(stateDir, '0.1.0');
    const first = new FakeTelegram();
    await performScan(COMPONENT, {
      candidate: makeCandidate('0.1.0'),
      stateDir,
      reportsDir,
      telegramClient: first,
      downloadArtifact: makeDownloader(),
      extractArtifact: makeExtractor(),
      isTestRun: true,
      bypassDedup: true,
    });

    const second = new FakeTelegram();
    const result = await performScan(COMPONENT, {
      candidate: makeCandidate('0.2.0'),
      stateDir,
      reportsDir,
      telegramClient: second,
      downloadArtifact: makeDownloader(),
      extractArtifact: makeExtractor({ withFlag: true }),
    });

    const completion = second.messages.find((m) => m.text.includes('ANALYSIS COMPLETE'));
    assert.ok(completion, 'completion message delivered');
    assert.ok(
      !completion.text.includes('gpt-5-preview'),
      'persistent model must not be re-alerted',
    );
    assert.ok(
      completion.text.includes('enable_agentic_flow'),
      'new feature signal is reported',
    );

    const leaksPath = result.reportBundle.telegramFiles.find((file) => file.endsWith('leaks.txt'));
    const leaks = fs.readFileSync(leaksPath, 'utf8');
    assert.match(leaks, /\[PERSISTENT\][\s\S]{0,300}Finding:\s+gpt-5-preview/);
    assert.match(leaks, /\[NEW\][\s\S]{0,300}Finding:\s+enable_agentic_flow/);
    assert.ok(leaks.includes('[NEW]'), 'new signals are labelled');
  } finally {
    cleanup(root);
  }
});

test('failed document upload pauses advancement and retries without a second alert', async () => {
  const { root, stateDir, reportsDir } = makeTempDirs('retry');
  try {
    await initBaseline(stateDir, '0.1.0');
    const tg = new FakeTelegram();
    tg.failDocuments.add('leaks.txt');

    const first = await performScan(COMPONENT, {
      candidate: makeCandidate('0.2.0'),
      stateDir,
      reportsDir,
      telegramClient: tg,
      downloadArtifact: makeDownloader(),
      extractArtifact: makeExtractor(),
    });
    assert.equal(first.coverageState, 'COMPLETE');
    assert.equal(first.delivery.status, 'PARTIAL');
    assert.ok(first.pendingDelivery);
    assert.equal(first.pendingDelivery.status, 'DELIVERY_FAILED');

    let state = loadComponentState(stateDir, COMPONENT);
    assert.equal(state.version, '0.1.0', 'baseline did not advance on delivery failure');
    assert.equal(state.alertedVersion, '0.2.0');
    assert.equal(state.pendingDelivery.status, 'DELIVERY_FAILED');
    assert.equal(
      tg.messages.filter((m) => m.text.includes('Version Change')).length,
      1,
    );

    tg.failDocuments.clear();
    const second = await performScan(COMPONENT, {
      candidate: makeCandidate('0.2.0'),
      stateDir,
      reportsDir,
      telegramClient: tg,
      downloadArtifact: makeDownloader(),
      extractArtifact: makeExtractor(),
    });
    assert.equal(second.delivery.status, 'DELIVERED');
    assert.equal(second.pendingDelivery, null);
    assert.equal(
      tg.messages.filter((m) => m.text.includes('Version Change')).length,
      1,
      'resume must not re-send the immediate alert',
    );

    state = loadComponentState(stateDir, COMPONENT);
    assert.equal(state.version, '0.2.0');
    assert.equal(state.deliveredVersion, '0.2.0');
    assert.equal(state.pendingDelivery, null);
  } finally {
    cleanup(root);
  }
});

test('failed acquisition keeps the alert checkpoint and resumes without alerting again', async () => {
  const { root, stateDir, reportsDir } = makeTempDirs('resume');
  try {
    await initBaseline(stateDir, '0.1.0');
    const tg = new FakeTelegram();
    let failDownload = true;
    const downloader = async (artifact) => {
      if (failDownload) throw new Error('simulated CDN failure');
      return makeDownloader()(artifact);
    };

    const first = await performScan(COMPONENT, {
      candidate: makeCandidate('0.2.0'),
      stateDir,
      reportsDir,
      telegramClient: tg,
      downloadArtifact: downloader,
      extractArtifact: makeExtractor(),
    });
    assert.equal(first.coverageState, 'FAILED');
    assert.ok(first.pendingDelivery);
    assert.equal(first.pendingDelivery.status, 'PARTIAL');
    assert.equal(tg.documents.length, 6, 'empty reports are still delivered');
    assert.equal(
      tg.messages.filter((m) => m.text.includes('Version Change')).length,
      1,
    );

    const changes = await detectChanges(null, {
      stateDir,
      components: [COMPONENT],
      fetcher: async () => makeCandidate('0.2.0'),
    });
    assert.equal(changes.length, 1);
    assert.equal(changes[0].resume, true);

    failDownload = false;
    const second = await performScan(COMPONENT, {
      candidate: makeCandidate('0.2.0'),
      stateDir,
      reportsDir,
      telegramClient: tg,
      downloadArtifact: downloader,
      extractArtifact: makeExtractor(),
    });
    assert.equal(second.coverageState, 'COMPLETE');
    assert.equal(second.pendingDelivery, null);
    assert.equal(
      tg.messages.filter((m) => m.text.includes('Version Change')).length,
      1,
      'resume must reuse the existing alert checkpoint',
    );

    const state = loadComponentState(stateDir, COMPONENT);
    assert.equal(state.version, '0.2.0');
    assert.equal(state.deliveredVersion, '0.2.0');
  } finally {
    cleanup(root);
  }
});

test('selectArtifacts prioritizes Linux tarball for desktop apps and dedupes CLI architectures', () => {
  const desktopCandidate = {
    artifacts: [
      { target: 'darwin-arm64', url: 'https://example.com/Devin-darwin-arm64.dmg' },
      { target: 'darwin-x64', url: 'https://example.com/Devin-darwin-x64.dmg' },
      { target: 'win32-x64', url: 'https://example.com/DevinSetup-x64.exe' },
      { target: 'win32-arm64', url: 'https://example.com/DevinSetup-arm64.exe' },
      { target: 'linux-x64', url: 'https://example.com/Devin-linux-x64.tar.gz' },
    ],
  };
  const selectedDesktop = selectArtifacts(desktopCandidate, { type: 'desktop' });
  assert.equal(selectedDesktop.length, 1);
  assert.equal(selectedDesktop[0].target, 'linux-x64');

  const cliCandidate = {
    artifacts: [
      { target: 'darwin-arm64', url: 'https://example.com/cli-darwin-arm64' },
      { target: 'darwin-x64', url: 'https://example.com/cli-darwin-x64' },
      { target: 'win32-x64', url: 'https://example.com/cli-win32-x64.exe' },
      { target: 'linux-x64', url: 'https://example.com/cli-linux-x64' },
      { target: 'linux-arm64', url: 'https://example.com/cli-linux-arm64' },
    ],
  };
  const selectedCli = selectArtifacts(cliCandidate, { type: 'cli' });
  assert.equal(selectedCli.length, 3);
  const targets = selectedCli.map((a) => a.target).sort();
  assert.deepEqual(targets, ['darwin-arm64', 'linux-x64', 'win32-x64']);
});
