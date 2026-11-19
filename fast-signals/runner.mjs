#!/usr/bin/env node
/**
 * Fast Signals Unified Orchestrator
 * Runs all lightweight API, benchmark, SDK type, and Hugging Face monitors
 * concurrently via non-blocking async execution in under 3 seconds.
 */

import { runTracker as runApiTracker } from '../api-tracker/tracker.mjs';
import { runRadar } from '../early-radar/radar.mjs';
import { runHfTracker } from '../hf-tracker/tracker.mjs';
import { runSdkTracker } from '../reverse-tracker/sdk/tracker.mjs';
import { runDesignTracker } from '../design-arena/design_tracker.mjs';
import { runClaudeCatalogTracker } from '../claude-tracker/tracker.mjs';
import { runLeakTracker } from '../leak-tracker/tracker.mjs';

export async function runAllFastSignals(options = {}) {
  const startTime = Date.now();
  console.log('⚡ [Fast Signals] Starting parallel scan across all 7 lightweight monitors...');

  const tasks = [
    { name: 'API Signal Tracker', fn: () => runApiTracker(options) },
    { name: 'Early Signal Radar', fn: () => runRadar(options) },
    { name: 'Hugging Face Tracker', fn: () => runHfTracker(options) },
    { name: 'Official AI SDK Tracker', fn: () => runSdkTracker(options) },
    { name: 'DesignArena Tracker', fn: () => runDesignTracker(options) },
    { name: 'Claude Model Catalog Tracker', fn: () => runClaudeCatalogTracker(options) },
    { name: 'Leak & Pre-Release Tracker', fn: () => runLeakTracker(options) },
  ];

  const results = await Promise.allSettled(
    tasks.map(async (task) => {
      const t0 = Date.now();
      try {
        await task.fn();
        const duration = ((Date.now() - t0) / 1000).toFixed(2);
        return { name: task.name, ok: true, duration };
      } catch (err) {
        const duration = ((Date.now() - t0) / 1000).toFixed(2);
        return { name: task.name, ok: false, duration, error: err.message };
      }
    })
  );

  let successCount = 0;
  for (const res of results) {
    if (res.status === 'fulfilled' && res.value.ok) {
      successCount++;
      console.log(`  ✓ ${res.value.name} (${res.value.duration}s)`);
    } else {
      const val = res.status === 'fulfilled' ? res.value : { name: 'Unknown', error: res.reason?.message };
      console.warn(`  ⚠️ ${val.name} completed with warning (${val.duration || 0}s): ${val.error}`);
    }
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`⚡ [Fast Signals] Finished ${successCount}/${tasks.length} tracks in ${totalTime}s.`);
}

if (process.argv[1] && process.argv[1].endsWith('runner.mjs')) {
  runAllFastSignals().catch((err) => {
    console.warn('[Fast Signals] Runner caught error:', err.message);
    process.exit(0);
  });
}
