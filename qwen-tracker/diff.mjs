/**
 * Qwen Cloud State Differ
 * Compares current remote state against previous snapshot.
 */

/**
 * Normalizes objects for stable equality checking.
 */
function sortedObject(obj = {}) {
  const sorted = {};
  for (const k of Object.keys(obj).sort()) {
    sorted[k] = obj[k];
  }
  return sorted;
}

/**
 * Calculates differences between old snapshot and current models.
 */
export function diffQwenState(currentModelsMap, previousSnapshot = null) {
  const events = {
    added: [],
    removed: [],
    priceChanges: [],
    contextChanges: [],
    featureChanges: [],
    capabilityChanges: [],
  };

  if (!previousSnapshot || !previousSnapshot.models) {
    return events;
  }

  const prevModels = previousSnapshot.models || {};
  const currentModelIds = new Set(currentModelsMap.keys());
  const prevModelIds = new Set(Object.keys(prevModels));

  // 1. Detect newly added models
  for (const [modelId, current] of currentModelsMap) {
    if (!prevModelIds.has(modelId)) {
      events.added.push(current);
      continue;
    }

    const prev = prevModels[modelId];

    // 2. Check Pricing Changes
    const prevPricing = prev.pricing || {};
    const currPricing = current.pricing || {};
    const allPriceKeys = new Set([...Object.keys(prevPricing), ...Object.keys(currPricing)]);
    const priceDiffs = [];

    for (const key of Array.from(allPriceKeys).sort()) {
      const oldVal = prevPricing[key];
      const newVal = currPricing[key];
      if (oldVal === undefined) {
        priceDiffs.push({ key, type: 'ADDED', value: newVal });
      } else if (newVal === undefined) {
        priceDiffs.push({ key, type: 'REMOVED', value: oldVal });
      } else if (oldVal !== newVal) {
        priceDiffs.push({ key, type: 'CHANGED', oldVal, newVal });
      }
    }

    if (priceDiffs.length > 0) {
      events.priceChanges.push({
        model: current,
        diffs: priceDiffs,
      });
    }

    // 3. Check Context & Token Limits Changes
    const prevInfo = prev.modelInfo || {};
    const currInfo = current.modelInfo || {};
    const contextDiffs = [];

    const tokenFields = [
      'contextWindow',
      'maxInputTokens',
      'maxOutputTokens',
      'maxReasoningTokens',
      'reasoningMaxInputTokens',
      'reasoningMaxOutputTokens',
    ];

    for (const field of tokenFields) {
      if (prevInfo[field] !== currInfo[field] && (prevInfo[field] || currInfo[field])) {
        contextDiffs.push({
          field,
          oldVal: prevInfo[field] || 0,
          newVal: currInfo[field] || 0,
        });
      }
    }

    if (contextDiffs.length > 0) {
      events.contextChanges.push({
        model: current,
        diffs: contextDiffs,
      });
    }

    // 4. Check Features Added/Removed
    const prevFeat = new Set(prev.features || []);
    const currFeat = new Set(current.features || []);
    const addedFeat = (current.features || []).filter((f) => !prevFeat.has(f));
    const removedFeat = (prev.features || []).filter((f) => !currFeat.has(f));

    if (addedFeat.length > 0 || removedFeat.length > 0) {
      events.featureChanges.push({
        model: current,
        added: addedFeat,
        removed: removedFeat,
      });
    }

    // 5. Check Capabilities Changes (e.g. Reasoning, VU)
    const prevCaps = new Set(prev.capabilities || []);
    const currCaps = new Set(current.capabilities || []);
    const addedCaps = (current.capabilities || []).filter((c) => !prevCaps.has(c));

    if (addedCaps.length > 0) {
      events.capabilityChanges.push({
        model: current,
        added: addedCaps,
      });
    }
  }

  // 6. Detect removed models
  for (const modelId of prevModelIds) {
    if (!currentModelIds.has(modelId)) {
      events.removed.push(prevModels[modelId]);
    }
  }

  return events;
}

/**
 * Checks whether any significant events were found.
 */
export function hasEvents(events) {
  return (
    events.added.length > 0 ||
    events.removed.length > 0 ||
    events.priceChanges.length > 0 ||
    events.contextChanges.length > 0 ||
    events.featureChanges.length > 0 ||
    events.capabilityChanges.length > 0
  );
}
