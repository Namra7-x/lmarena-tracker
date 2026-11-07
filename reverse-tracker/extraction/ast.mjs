/**
 * JavaScript AST Intelligence Engine (Section 6 & Open-World Discovery)
 * Uses Acorn to parse minified JS, CommonJS, and ES Modules.
 * Folds constant binary expressions, resolves template literals and arrays,
 * and extracts model slots, arbitrary peer codenames, feature gates, rollout configs,
 * A/B experiments, internal RPCs, and unknown candidates with exact source offsets.
 */

import * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import {
  CATEGORIES,
  ACTIVATION_STATUS,
  isValidModelIdentifier,
  isValidFeatureFlag,
} from '../finder/rules.mjs';
import { evaluateNoise, COMMON_UI_THEMES } from '../finder/noise.mjs';

const MODEL_PROPERTY_NAMES = new Set([
  'model',
  'models',
  'model_slug',
  'modelslug',
  'model_id',
  'modelid',
  'model_name',
  'modelname',
  'model_identifier',
  'default_model',
  'defaultmodel',
  'fallbackmodel',
  'fallback_model',
  'reasoningmodel',
  'reasoning_model',
  'evalmodel',
  'eval_model',
  'chat_model',
  'chatmodel',
  'active_model',
  'activemodel',
  'primary_model',
  'primarymodel',
  'subagent_model',
  'subagentmodel',
  'selected_model',
  'selectedmodel',
  'target_model',
  'targetmodel',
  'base_model',
  'basemodel',
  'custom_model',
  'custommodel',
  'agent_model',
  'agentmodel',
  'code_model',
  'codemodel',
  'fast_model',
  'fastmodel',
  'vision_model',
  'visionmodel',
  'thinking_model',
  'thinkingmodel',
  'orchestrator_model',
  'orchestratormodel',
  'embedding_model',
  'embeddingmodel',
]);

const GATE_FUNCTION_NAMES = new Set([
  'checkgate',
  'variation',
  'getexperiment',
  'isfeatureenabled',
  'usefeatureflag',
  'useexperiment',
  'isenabled',
  'canuse',
  'hasfeature',
  'getfeatureflag',
  'getfeatureflagvalue',
  'getfeatureflagpayload',
  'checkfeature',
  'isfeatureactive',
  'evaluategate',
  'evalgate',
  'getexperimentvalue',
  'getconfig',
  'isgateopen',
  'checkexperiment',
  'istoggled',
  'featuretoggled',
  'hasentitlement',
  'isentitled',
]);

const NETWORK_FUNCTION_NAMES = new Set([
  'fetch',
  'websocket',
  'request',
  'get',
  'post',
  'put',
  'connect',
  'send',
  'open',
  'createclient',
  'createconnection',
  'dial',
]);

const KNOWN_MODEL_ANCHORS = /^(?:gpt|claude|gemini|o[1-9]|deepseek|codex|devin|cursor|droid|qwen|grok|llama|mistral|kimi|lyria|imagen|chinchilla|palm|titan|flux|sora|whisper)-/i;
const KNOWN_EXPLICIT_MODELS = /^(?:o1|o3|o4|o5)(?:-(?:mini|preview|pro|plus|low|medium|high|max|turbo|instruct|eval|chat))?$/i;

const AI_HYPERPARAMS = new Set([
  'context_window',
  'contextwindow',
  'max_tokens',
  'maxtokens',
  'input_cost',
  'output_cost',
  'supports_thinking',
  'thinking_budget',
  'reasoning_effort',
  'temperature',
  'top_p',
  'stop_sequences',
]);

const ROLLOUT_CONFIG_PROPS = new Set([
  'rollout',
  'rolloutpercentage',
  'percentage',
  'samplerate',
  'trafficallocation',
  'variants',
  'variant',
  'treatments',
  'defaultvalue',
  'conditions',
  'targeting',
  'enabled',
  'isactive',
]);

function isUiList(values) {
  if (!Array.isArray(values) || values.length === 0) return false;
  return values.every((v) => {
    if (typeof v !== 'string') return false;
    const lower = v.toLowerCase();
    return (
      COMMON_UI_THEMES.has(lower) ||
      /^(?:xs|sm|md|lg|xl|2xl|red|blue|green|gray|black|white)$/i.test(lower)
    );
  });
}

/**
 * Strips JSX tags from source string to allow Acorn to parse code with JSX components.
 */
function stripJsxTags(code) {
  return code
    .replace(/<[A-Za-z0-9_$]+(?:\s+[^>]*?)?(?:\/>|>(?:[\s\S]*?<\/[A-Za-z0-9_$]+>))/g, ' null ')
    .replace(/<\/?[A-Za-z0-9_$]+(?:\s+[^>]*?)?\/?>/g, ' null ');
}

/**
 * Safely parse JavaScript code into an AST with module, script, CommonJS, and JSX fallback.
 */
export function parseJsAst(code) {
  if (!code || typeof code !== 'string') return null;

  const baseOptions = {
    ecmaVersion: 'latest',
    allowReturnOutsideFunction: true,
    allowHashBang: true,
    allowAwaitOutsideFunction: true,
    allowImportExportEverywhere: true,
    locations: true,
  };

  // 1. Try ES Module
  try {
    return acorn.parse(code, { ...baseOptions, sourceType: 'module' });
  } catch {
    // 2. Cascade to CommonJS / Script
    try {
      return acorn.parse(code, { ...baseOptions, sourceType: 'script' });
    } catch {
      // 3. Try JSX-stripped fallback
      try {
        const sanitized = stripJsxTags(code);
        return acorn.parse(sanitized, { ...baseOptions, sourceType: 'module' });
      } catch {
        try {
          const sanitized = stripJsxTags(code);
          return acorn.parse(sanitized, { ...baseOptions, sourceType: 'script' });
        } catch {
          return null;
        }
      }
    }
  }
}

/**
 * Recursively fold compile-time constant string additions (e.g. "/api/" + "v1" -> "/api/v1")
 * or fully-resolved static template literals.
 */
export function foldBinaryExpression(node) {
  if (!node) return null;
  if (node.type === 'Literal') {
    return typeof node.value === 'string' ? node.value : null;
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = foldBinaryExpression(node.left);
    const right = foldBinaryExpression(node.right);
    if (left !== null && right !== null) {
      return left + right;
    }
  }
  if (node.type === 'TemplateLiteral') {
    let result = '';
    const quasis = node.quasis || [];
    const expressions = node.expressions || [];
    for (let i = 0; i < quasis.length; i++) {
      result += quasis[i].value.cooked || quasis[i].value.raw || '';
      if (i < expressions.length) {
        const foldedExpr = foldBinaryExpression(expressions[i]);
        if (foldedExpr === null) return null;
        result += foldedExpr;
      }
    }
    return result;
  }
  return null;
}

/**
 * Extract signals, endpoints, models, experiments, and flags from JavaScript AST.
 * Returns an array of findings with attached .unknownCandidates property.
 */
export function extractSignalsFromAst(code, filePath = '') {
  if (!code || typeof code !== 'string') return [];

  const ast = parseJsAst(code);
  if (!ast) return [];

  const findings = [];
  const unknownCandidates = [];
  const seen = new Set();
  const seenUnknowns = new Set();
  const localVariables = new Map();

  function addFinding(category, value, node, rawExpression = '', options = {}) {
    if (!value || typeof value !== 'string') return;
    const clean = value.trim();
    if (clean.length < 2 || clean.length > 500) return;

    if (evaluateNoise(clean).isNoise) return;

    const key = `${category}:${clean}`;
    if (seen.has(key)) return;
    seen.add(key);

    const start = node?.start || 0;
    const end = node?.end || start;
    const context = code.slice(Math.max(0, start - 80), Math.min(code.length, end + 80)).replace(/[\r\n]+/g, ' ');

    findings.push({
      category,
      value: clean,
      offset: {
        start,
        end,
        line: node?.loc?.start?.line || 1,
        column: node?.loc?.start?.column || 0,
      },
      context,
      rawExpression: rawExpression || clean,
      filePath,
      origin: 'ast',
      discoveryMethod: options.discoveryMethod || 'ast_walker',
      activationStatus: options.activationStatus || ACTIVATION_STATUS.REFERENCED,
      related: options.related || null,
      status: 'accepted',
    });
  }

  function addUnknownCandidate(value, node, reason = '', contextHint = '') {
    if (!value || typeof value !== 'string') return;
    const clean = value.trim();
    if (clean.length < 3 || clean.length > 120) return;
    if (evaluateNoise(clean).isNoise) return;
    if (seenUnknowns.has(clean) || seen.has(clean)) return;
    seenUnknowns.add(clean);

    const start = node?.start || 0;
    const end = node?.end || start;
    const context = code.slice(Math.max(0, start - 60), Math.min(code.length, end + 60)).replace(/[\r\n]+/g, ' ');

    unknownCandidates.push({
      value: clean,
      filePath,
      offset: {
        start,
        end,
        line: node?.loc?.start?.line || 1,
        column: node?.loc?.start?.column || 0,
      },
      context,
      reason,
      contextHint,
      activationStatus: ACTIVATION_STATUS.UNKNOWN,
    });
  }

  // Pre-pass: collect local string constant declarations for local data flow tracking
  walk.simple(ast, {
    VariableDeclarator(node) {
      if (node.id?.type === 'Identifier' && node.init) {
        const folded = foldBinaryExpression(node.init) || (node.init.type === 'Literal' && typeof node.init.value === 'string' ? node.init.value : null);
        if (folded && typeof folded === 'string') {
          localVariables.set(node.id.name, folded);
        }
      }
    },
  });

  walk.simple(ast, {
    // 1. Folded Binary Additions (e.g. "https://api." + "example.com")
    BinaryExpression(node) {
      if (node.operator === '+') {
        const folded = foldBinaryExpression(node);
        if (folded && typeof folded === 'string') {
          if (/^(?:https?:\/\/|wss?:\/\/|\/api\/|\/v[0-9]+|\/internal\/)/i.test(folded)) {
            addFinding(CATEGORIES.ENDPOINT_DOMAIN, folded, node, 'BinaryExpression(+)');
          }
        }
      } else if (node.operator === '===' || node.operator === '==') {
        // Binary equality comparison (e.g. model === 'Cactus', gate === 'exp_feature')
        function checkBinaryEquality(left, right) {
          let identName = '';
          if (left.type === 'Identifier') {
            identName = left.name.toLowerCase();
          } else if (left.type === 'MemberExpression' && left.property) {
            identName = (left.property.name || left.property.value || '').toString().toLowerCase();
          }

          const strVal = foldBinaryExpression(right) || (right.type === 'Literal' && typeof right.value === 'string' ? right.value : null);

          if (strVal && identName) {
            if (/model|engine|provider|llm/i.test(identName) && isValidModelIdentifier(strVal)) {
              addFinding(CATEGORIES.MODEL_ID, strVal, right, `BinaryCompare(${identName})`, {
                discoveryMethod: 'ast_binary_equality_model',
                activationStatus: ACTIVATION_STATUS.REFERENCED,
              });
            } else if (/gate|flag|feature|canary/i.test(identName) && isValidFeatureFlag(strVal)) {
              addFinding(CATEGORIES.FEATURE_FLAG, strVal, right, `BinaryCompare(${identName})`, {
                discoveryMethod: 'ast_binary_equality_flag',
                activationStatus: ACTIVATION_STATUS.REFERENCED,
              });
            } else if (/experiment|variant|bucket/i.test(identName)) {
              addFinding(CATEGORIES.EXPERIMENT, strVal, right, `BinaryCompare(${identName})`, {
                discoveryMethod: 'ast_binary_equality_experiment',
                activationStatus: ACTIVATION_STATUS.REFERENCED,
              });
            }
          }
        }

        checkBinaryEquality(node.left, node.right);
        checkBinaryEquality(node.right, node.left);
      }
    },

    // 2. Template Literals (static quasis prefixes or fully folded URLs)
    TemplateLiteral(node) {
      const fullFolded = foldBinaryExpression(node);
      if (fullFolded && /^(?:https?:\/\/|wss?:\/\/|\/api\/|\/v[0-9]+|\/internal\/)/i.test(fullFolded)) {
        addFinding(CATEGORIES.ENDPOINT_DOMAIN, fullFolded, node, 'TemplateLiteral(folded)');
        return;
      }

      if (node.quasis && node.quasis.length > 0) {
        const staticPrefix = node.quasis[0].value.cooked || node.quasis[0].value.raw || '';
        if (/^(?:https?:\/\/|wss?:\/\/|\/api\/|\/v[0-9]+|\/internal\/)/i.test(staticPrefix)) {
          addFinding(CATEGORIES.ENDPOINT_DOMAIN, staticPrefix, node, 'TemplateLiteral(prefix)');
        }
      }
    },

    // 3. Object Properties (e.g. { defaultModel: "gemini-3.8-flash-tts", models: [...] })
    Property(node) {
      if (!node.key) return;
      const keyName = (node.key.name || node.key.value || '').toString().toLowerCase();

      if (MODEL_PROPERTY_NAMES.has(keyName)) {
        const modelVal = foldBinaryExpression(node.value) || (node.value.type === 'Literal' ? node.value.value : null);
        if (modelVal && typeof modelVal === 'string') {
          addFinding(CATEGORIES.MODEL_ID, modelVal, node.value, `Property(${keyName})`, {
            discoveryMethod: 'ast_property_model',
            activationStatus: ACTIVATION_STATUS.CONFIGURED,
          });
        } else if (node.value && node.value.type === 'ArrayExpression' && Array.isArray(node.value.elements)) {
          for (const el of node.value.elements) {
            const elVal = foldBinaryExpression(el) || (el?.type === 'Literal' ? el.value : null);
            if (elVal && typeof elVal === 'string') {
              addFinding(CATEGORIES.MODEL_ID, elVal, el, `PropertyArray(${keyName})`, {
                discoveryMethod: 'ast_property_model_array',
                activationStatus: ACTIVATION_STATUS.CONFIGURED,
              });
            }
          }
        }
      }
    },

    // 4. Array Peer Clustering (extract arbitrary unannounced codenames peer-clustered with known models)
    ArrayExpression(node) {
      if (!Array.isArray(node.elements) || node.elements.length < 2) return;

      const strItems = [];
      for (const el of node.elements) {
        if (!el) continue;
        const folded = foldBinaryExpression(el) || (el.type === 'Literal' && typeof el.value === 'string' ? el.value : null);
        if (folded && typeof folded === 'string') {
          strItems.push({ val: folded.trim(), node: el });
        }
      }

      if (strItems.length >= 2) {
        const vals = strItems.map((s) => s.val);
        const hasAnchor = vals.some((v) => KNOWN_MODEL_ANCHORS.test(v) || KNOWN_EXPLICIT_MODELS.test(v));

        if (hasAnchor && !isUiList(vals)) {
          for (const item of strItems) {
            if (isValidModelIdentifier(item.val)) {
              addFinding(CATEGORIES.MODEL_ID, item.val, item.node, 'ArrayPeerCollection', {
                discoveryMethod: 'ast_array_peer_cluster',
                activationStatus: ACTIVATION_STATUS.CONFIGURED,
                related: { peerModels: vals.filter((v) => v !== item.val) },
              });
            } else {
              addUnknownCandidate(item.val, item.node, 'peer_array_with_anchor_models', `Peer array: ${vals.slice(0, 5).join(', ')}`);
            }
          }
        }
      }
    },

    // 5. Switch-Case Statements (conditional model selection, feature toggles, and experiment variants)
    SwitchStatement(node) {
      let discName = '';
      if (node.discriminant?.type === 'Identifier') {
        discName = node.discriminant.name.toLowerCase();
      } else if (node.discriminant?.type === 'MemberExpression' && node.discriminant.property) {
        discName = (node.discriminant.property.name || node.discriminant.property.value || '').toString().toLowerCase();
      }

      if (!discName) return;

      const isModelDisc = /model|engine|provider|llm|ai_model|chat_model|active_model|selected_model/i.test(discName);
      const isFlagDisc = /gate|flag|feature|canary|toggle/i.test(discName);
      const isExpDisc = /experiment|variant|bucket|treatment|ab_test/i.test(discName);

      if (!isModelDisc && !isFlagDisc && !isExpDisc) return;

      for (const cs of node.cases || []) {
        if (!cs.test) continue;
        const cVal = foldBinaryExpression(cs.test) || (cs.test.type === 'Literal' && typeof cs.test.value === 'string' ? cs.test.value : null);
        if (!cVal || typeof cVal !== 'string') continue;

        if (isModelDisc && isValidModelIdentifier(cVal)) {
          addFinding(CATEGORIES.MODEL_ID, cVal, cs.test, `SwitchCase(${discName})`, {
            discoveryMethod: 'ast_switch_case_model',
            activationStatus: ACTIVATION_STATUS.REFERENCED,
            related: { discriminant: discName },
          });
        } else if (isFlagDisc && isValidFeatureFlag(cVal)) {
          addFinding(CATEGORIES.FEATURE_FLAG, cVal, cs.test, `SwitchCase(${discName})`, {
            discoveryMethod: 'ast_switch_case_flag',
            activationStatus: ACTIVATION_STATUS.REFERENCED,
            related: { discriminant: discName },
          });
        } else if (isExpDisc) {
          addFinding(CATEGORIES.EXPERIMENT, cVal, cs.test, `SwitchCase(${discName})`, {
            discoveryMethod: 'ast_switch_case_experiment',
            activationStatus: ACTIVATION_STATUS.REFERENCED,
            related: { discriminant: discName },
          });
        } else {
          addUnknownCandidate(cVal, cs.test, `switch_case_${discName}`, `Switch branch testing ${discName}`);
        }
      }
    },

    // 6. Object Configuration Detection (AI Hyperparameters, Rollouts, Hidden CLI commands)
    ObjectExpression(node) {
      if (!Array.isArray(node.properties)) return;

      const propMap = new Map();
      for (const p of node.properties) {
        if (!p.key) continue;
        const k = (p.key.name || p.key.value || '').toString().toLowerCase();
        propMap.set(k, p);
      }

      // A. Hidden CLI Command Detection
      const hiddenProp = propMap.get('hidden');
      if (hiddenProp) {
        const isHidden = hiddenProp.value?.type === 'Literal' && Boolean(hiddenProp.value.value);
        if (isHidden) {
          const nameProp = propMap.get('name') || propMap.get('command') || propMap.get('flags');
          if (nameProp) {
            const cmdName = foldBinaryExpression(nameProp.value) || (nameProp.value?.type === 'Literal' && typeof nameProp.value.value === 'string' ? nameProp.value.value : null);
            if (cmdName) {
              addFinding(CATEGORIES.HIDDEN_COMMAND, cmdName, nameProp, 'HiddenCliObject', {
                discoveryMethod: 'ast_cli_hidden',
                activationStatus: ACTIVATION_STATUS.CONFIGURED,
              });
            }
          }
        }
      }

      // B. AI Hyperparameter Configuration (detects models configured with context_window, max_tokens)
      let hyperparamCount = 0;
      for (const hp of AI_HYPERPARAMS) {
        if (propMap.has(hp)) hyperparamCount++;
      }

      if (hyperparamCount >= 1) {
        const idProp = propMap.get('id') || propMap.get('name') || propMap.get('model') || propMap.get('slug') || propMap.get('model_id');
        if (idProp) {
          const mVal = foldBinaryExpression(idProp.value) || (idProp.value?.type === 'Literal' && typeof idProp.value.value === 'string' ? idProp.value.value : null);
          if (mVal && isValidModelIdentifier(mVal)) {
            addFinding(CATEGORIES.MODEL_ID, mVal, idProp, 'ObjectHyperparameterConfig', {
              discoveryMethod: 'ast_hyperparam_object',
              activationStatus: ACTIVATION_STATUS.CONFIGURED,
              related: { hyperparameters: Array.from(propMap.keys()).filter((k) => AI_HYPERPARAMS.has(k)) },
            });
          }
        }
      }

      // C. Experiment & Feature Rollout Configuration
      let rolloutPropCount = 0;
      for (const rp of ROLLOUT_CONFIG_PROPS) {
        if (propMap.has(rp)) rolloutPropCount++;
      }

      if (rolloutPropCount >= 1) {
        const idProp = propMap.get('id') || propMap.get('name') || propMap.get('key') || propMap.get('flag') || propMap.get('experiment') || propMap.get('gate');
        if (idProp) {
          const flagName = foldBinaryExpression(idProp.value) || (idProp.value?.type === 'Literal' && typeof idProp.value.value === 'string' ? idProp.value.value : null);
          if (flagName && isValidFeatureFlag(flagName)) {
            let status = ACTIVATION_STATUS.CONFIGURED;
            const enabledProp = propMap.get('enabled') || propMap.get('isactive');
            if (enabledProp?.value?.type === 'Literal' && enabledProp.value.value === true) {
              status = ACTIVATION_STATUS.ENABLED;
            }

            const rolloutProp = propMap.get('rollout') || propMap.get('rolloutpercentage') || propMap.get('percentage');
            let rolloutPct = null;
            if (rolloutProp?.value?.type === 'Literal' && typeof rolloutProp.value.value === 'number') {
              rolloutPct = rolloutProp.value.value;
              if (rolloutPct === 100) status = ACTIVATION_STATUS.ENABLED;
            }

            const isExp = propMap.has('variants') || propMap.has('treatments') || rolloutProp !== undefined || /exp_|experiment/i.test(flagName);
            const category = isExp ? CATEGORIES.EXPERIMENT : CATEGORIES.FEATURE_FLAG;

            addFinding(category, flagName, idProp, 'RolloutConfigObject', {
              discoveryMethod: 'ast_config_object',
              activationStatus: status,
              related: { rolloutPercentage: rolloutPct },
            });
          }
        }
      }
    },

    // 7. Variable Declarations
    VariableDeclarator(node) {
      if (!node.id || node.id.type !== 'Identifier' || !node.init) return;
      const varName = node.id.name.toLowerCase();

      // Model slots in variables
      if (MODEL_PROPERTY_NAMES.has(varName) || /_model$|^model_|_model_|^default_model|^chat_model/i.test(varName)) {
        const val = foldBinaryExpression(node.init) || (node.init.type === 'Literal' ? node.init.value : null);
        if (val && typeof val === 'string' && isValidModelIdentifier(val)) {
          addFinding(CATEGORIES.MODEL_ID, val, node.init, `Variable(${node.id.name})`, {
            discoveryMethod: 'ast_variable_model',
            activationStatus: ACTIVATION_STATUS.CONFIGURED,
          });
        }
      }

      // Arrays of models or flags
      if (node.init.type === 'ArrayExpression' && Array.isArray(node.init.elements)) {
        if (/models?|engines?|catalog(?:ue)?/i.test(varName)) {
          for (const el of node.init.elements) {
            const elVal = foldBinaryExpression(el) || (el?.type === 'Literal' ? el.value : null);
            if (elVal && typeof elVal === 'string' && isValidModelIdentifier(elVal)) {
              addFinding(CATEGORIES.MODEL_ID, elVal, el, `ModelArray(${node.id.name})`, {
                discoveryMethod: 'ast_variable_array_model',
                activationStatus: ACTIVATION_STATUS.CONFIGURED,
              });
            }
          }
        } else if (/flags?|gates?|experiments?/i.test(varName)) {
          for (const el of node.init.elements) {
            const elVal = foldBinaryExpression(el) || (el?.type === 'Literal' ? el.value : null);
            if (elVal && typeof elVal === 'string' && isValidFeatureFlag(elVal)) {
              const cat = /experiment/i.test(varName) ? CATEGORIES.EXPERIMENT : CATEGORIES.FEATURE_FLAG;
              addFinding(cat, elVal, el, `FlagArray(${node.id.name})`, {
                discoveryMethod: 'ast_variable_array_flag',
                activationStatus: ACTIVATION_STATUS.CONFIGURED,
              });
            }
          }
        }
      }
    },

    // 8. Assignment Expressions
    AssignmentExpression(node) {
      if (!node.left || !node.right) return;
      let propName = '';
      if (node.left.type === 'MemberExpression' && node.left.property) {
        propName = (node.left.property.name || node.left.property.value || '').toString().toLowerCase();
      }

      if (MODEL_PROPERTY_NAMES.has(propName)) {
        const val = foldBinaryExpression(node.right) || (node.right.type === 'Literal' ? node.right.value : null);
        if (val && typeof val === 'string' && isValidModelIdentifier(val)) {
          addFinding(CATEGORIES.MODEL_ID, val, node.right, `Assignment(${propName})`, {
            discoveryMethod: 'ast_assignment_model',
            activationStatus: ACTIVATION_STATUS.CONFIGURED,
          });
        }
      }
    },

    // 9. Call Expressions (Gate functions, variation calls, experiments, network endpoints)
    CallExpression(node) {
      if (!node.callee) return;
      let fnName = '';
      if (node.callee.type === 'Identifier') {
        fnName = node.callee.name.toLowerCase();
      } else if (node.callee.type === 'MemberExpression' && node.callee.property) {
        fnName = (node.callee.property.name || '').toLowerCase();
      }

      if (GATE_FUNCTION_NAMES.has(fnName) && node.arguments && node.arguments.length > 0) {
        let flagVal = foldBinaryExpression(node.arguments[0]) || (node.arguments[0].type === 'Literal' ? node.arguments[0].value : null);

        // Local data flow resolution: if argument is a variable identifier, resolve it
        if (!flagVal && node.arguments[0].type === 'Identifier') {
          flagVal = localVariables.get(node.arguments[0].name) || null;
        }

        if (flagVal && typeof flagVal === 'string' && isValidFeatureFlag(flagVal)) {
          // Determine activation status from second argument (default value / fallback)
          let activationStatus = ACTIVATION_STATUS.REFERENCED;
          let defaultValue = null;

          if (node.arguments.length >= 2) {
            const arg1 = node.arguments[1];
            if (arg1.type === 'Literal') {
              defaultValue = arg1.value;
              if (arg1.value === true) {
                activationStatus = ACTIVATION_STATUS.ENABLED;
              } else if (arg1.value === false) {
                activationStatus = ACTIVATION_STATUS.CONFIGURED;
              }
            } else {
              activationStatus = ACTIVATION_STATUS.CONFIGURED;
            }
          }

          const isExp = /experiment|ab_test|variation/i.test(fnName) || /^(?:exp_|experiment_)/i.test(flagVal);
          const category = isExp ? CATEGORIES.EXPERIMENT : CATEGORIES.FEATURE_FLAG;

          addFinding(category, flagVal, node.arguments[0], `Call(${fnName})`, {
            discoveryMethod: 'ast_call_gate',
            activationStatus,
            related: { function: fnName, defaultValue },
          });
        }
      } else if (NETWORK_FUNCTION_NAMES.has(fnName) && node.arguments && node.arguments.length > 0) {
        let arg0 = foldBinaryExpression(node.arguments[0]) || (node.arguments[0].type === 'Literal' ? node.arguments[0].value : null);
        if (!arg0 && node.arguments[0].type === 'Identifier') {
          arg0 = localVariables.get(node.arguments[0].name) || null;
        }

        if (arg0 && typeof arg0 === 'string' && /^(?:https?:\/\/|wss?:\/\/|\/)/i.test(arg0)) {
          addFinding(CATEGORIES.ENDPOINT_DOMAIN, arg0, node.arguments[0], `Call(${fnName})`, {
            discoveryMethod: 'ast_network_call',
            activationStatus: ACTIVATION_STATUS.REFERENCED,
          });
        }
      }
    },
  });

  // Attach unknownCandidates array directly to findings so callers can access both without breaking array interface
  findings.unknownCandidates = unknownCandidates;
  return findings;
}
