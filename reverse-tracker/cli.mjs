#!/usr/bin/env node
/**
 * Early Feature & Major Signal Finder — Unified CLI Runner
 *
 * The heavy lifting lives in pipeline/detect.mjs and pipeline/scan.mjs. This
 * file is intentionally thin so the workflow commands stay stable.
 */

import { FAMILIES, COMPONENTS } from './registry/components.mjs';
import { detectChanges } from './pipeline/detect.mjs';
import { performScan } from './pipeline/scan.mjs';

function parseOption(args, name) {
  const prefix = `--${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) || null;
}

async function handleDetect(familyId = null) {
  return detectChanges(familyId);
}

async function handleScan(componentId, options = {}) {
  return performScan(componentId, options);
}

async function handleTestRun(familyId = null, specificCompId = null, options = {}) {
  console.log(`\n🧪 [Test Run] One-time pipeline test (Family: ${familyId || 'ALL'})...`);
  const componentsToTest = specificCompId
    ? [specificCompId]
    : familyId
      ? (FAMILIES[familyId]?.components || [])
      : Object.keys(COMPONENTS);

  console.log(`📋 Components queued (${componentsToTest.length}): ${componentsToTest.join(', ')}`);

  const results = [];
  for (const compId of componentsToTest) {
    try {
      console.log(`\n--- [Test Run] Scanning ${compId} ---`);
      const scanRes = await handleScan(compId, {
        force: true,
        isTestRun: true,
        bypassDedup: Boolean(options.bypassDedup),
      });
      results.push({ componentId: compId, success: true, scanRes });
    } catch (err) {
      console.error(`✗ [Test Run Error] Failed testing ${compId}: ${err.message}`);
      results.push({ componentId: compId, success: false, error: err.message });
    }
  }

  console.log(`\n🎉 [Test Run] Completed for ${familyId || 'ALL'}.`);
  return results;
}

function printChanges(changes) {
  if (changes.length === 0) {
    console.log('\nAll components up-to-date.');
    return;
  }

  console.log(`\nFound ${changes.length} changed component(s):`);
  for (const change of changes) {
    const suffix = change.resume ? ' (resume delivery)' : '';
    console.log(
      `  • ${change.componentId}: ${change.baseline?.version || 'none'} -> ${change.candidate.version}${suffix}`,
    );
  }
}

const args = process.argv.slice(2);
const command = args[0] || 'detect';

async function main() {
  if (command === 'detect') {
    const familyArg = parseOption(args, 'family') || args[1] || null;
    const changes = await handleDetect(familyArg);
    printChanges(changes);
    return;
  }

  if (command === 'scan') {
    const compId = parseOption(args, 'component') || args[1] || 'codex-cli';
    const forceFlag = args.includes('--force') || args.includes('--test-run');
    // A manual scan/test is an explicit request to send again. Do not let the
    // previous test-run dedup guard silently turn it into a no-op.
    const bypassDedup = args.includes('--bypass-dedup') || forceFlag;
    const result = await handleScan(compId, {
      force: forceFlag,
      isTestRun: forceFlag,
      bypassDedup,
    });
    console.log(`Scan ${result.scanId} finished with coverage ${result.coverageState}.`);
    return;
  }

  if (command === 'test-run') {
    const familyArg = parseOption(args, 'family');
    const compArg = parseOption(args, 'component');
    const bypassDedup = args.includes('--bypass-dedup');
    await handleTestRun(familyArg, compArg, { bypassDedup });
    return;
  }

  if (command === 'run') {
    const familyArg = parseOption(args, 'family');
    const isForcedTest = args.includes('--test-run') || args.includes('--force') || process.env.FORCE_TEST_RUN === 'true';

    if (isForcedTest) {
      console.log(`🧪 Forced test run requested for family: ${familyArg || 'ALL'}...`);
      await handleTestRun(familyArg, null, { bypassDedup: true });
      return;
    }

    const changes = await handleDetect(familyArg);
    printChanges(changes);

    for (const change of changes) {
      try {
        await handleScan(change.componentId, {
          candidate: change.candidate,
          isTestRun: false,
          skipAlert: Boolean(change.skipAlert),
        });
      } catch (scanErr) {
        console.error(`✗ Error processing ${change.componentId}: ${scanErr.message}`);
      }
    }
    return;
  }

  if (command === 'sdk' || command === 'sdk:scan') {
    const { runSdkTracker } = await import('./sdk/tracker.mjs');
    const forceFlag = args.includes('--force') || args.includes('--force-alert') || args.includes('--test-run');
    await runSdkTracker({ forceAlert: forceFlag });
    return;
  }

  console.log(
    `Unknown command: ${command}. Usage: node cli.mjs [detect|scan|run|test-run|sdk] [--family=<id>] [--component=<id>] [--force]`,
  );
}

main().catch((err) => {
  console.error('Fatal CLI Error:', err);
  process.exit(1);
});
