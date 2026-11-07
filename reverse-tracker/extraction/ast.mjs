/**
 * JavaScript AST Intelligence Engine (Section 6)
 * Uses Acorn to parse minified JS, CommonJS, and ES Modules.
 * Folds constant binary expressions, resolves template literals and arrays,
 * and extracts model slots, feature flags, and API/WebSocket routes with exact source offsets.
 */

import * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import { CATEGORIES } from '../finder/rules.mjs';

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
    // If all expressions can be statically evaluated, reconstruct the whole string
    let result = '';
    const quasis = node.quasis || [];
    const expressions = node.expressions || [];
    for (let i = 0; i < quasis.length; i++) {
      result += quasis[i].value.cooked || quasis[i].value.raw || '';
      if (i < expressions.length) {
        const foldedExpr = foldBinaryExpression(expressions[i]);
        if (foldedExpr === null) return null; // Contains dynamic runtime variable
        result += foldedExpr;
      }
    }
    return result;
  }
  return null;
}

/**
 * Extract signals, endpoints, models, and flags from JavaScript AST.
 * Returns an array of { category, value, offset, context, rawExpression, filePath, origin, status }.
 */
export function extractSignalsFromAst(code, filePath = '') {
  if (!code || typeof code !== 'string') return [];

  const ast = parseJsAst(code);
  if (!ast) return [];

  const findings = [];
  const seen = new Set();

  function addFinding(category, value, node, rawExpression = '') {
    if (!value || typeof value !== 'string') return;
    const clean = value.trim();
    if (clean.length < 2 || clean.length > 500) return;

    const key = `${category}:${clean}`;
    if (seen.has(key)) return;
    seen.add(key);

    const start = node.start || 0;
    const end = node.end || start;
    const context = code.slice(Math.max(0, start - 60), Math.min(code.length, end + 60)).replace(/[\r\n]+/g, ' ');

    findings.push({
      category,
      value: clean,
      offset: {
        start,
        end,
        line: node.loc?.start?.line || 1,
        column: node.loc?.start?.column || 0,
      },
      context,
      rawExpression: rawExpression || clean,
      filePath,
      origin: 'ast',
      status: 'accepted',
    });
  }

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
          addFinding(CATEGORIES.MODEL_ID, modelVal, node.value, `Property(${keyName})`);
        } else if (node.value && node.value.type === 'ArrayExpression' && Array.isArray(node.value.elements)) {
          // Array of model identifiers: { models: ["claude-4.0-sonnet", "o3-mini"] }
          for (const el of node.value.elements) {
            const elVal = foldBinaryExpression(el) || (el?.type === 'Literal' ? el.value : null);
            if (elVal && typeof elVal === 'string') {
              addFinding(CATEGORIES.MODEL_ID, elVal, el, `PropertyArray(${keyName})`);
            }
          }
        }
      }
    },

    // 4. Variable Declarations (e.g. const DEFAULT_MODEL = "...", const AVAILABLE_MODELS = [...])
    VariableDeclarator(node) {
      if (!node.id || node.id.type !== 'Identifier' || !node.init) return;
      const varName = node.id.name.toLowerCase();

      // Check if variable name indicates a model slot
      if (MODEL_PROPERTY_NAMES.has(varName) || /_model$|^model_|_model_|^default_model|^chat_model/i.test(varName)) {
        const val = foldBinaryExpression(node.init) || (node.init.type === 'Literal' ? node.init.value : null);
        if (val && typeof val === 'string') {
          addFinding(CATEGORIES.MODEL_ID, val, node.init, `Variable(${node.id.name})`);
        }
      }

      // Check if variable is an array of models or flags
      if (node.init.type === 'ArrayExpression' && Array.isArray(node.init.elements)) {
        if (/models?|engines?|catalog(?:ue)?/i.test(varName)) {
          for (const el of node.init.elements) {
            const elVal = foldBinaryExpression(el) || (el?.type === 'Literal' ? el.value : null);
            if (elVal && typeof elVal === 'string') {
              addFinding(CATEGORIES.MODEL_ID, elVal, el, `ModelArray(${node.id.name})`);
            }
          }
        } else if (/flags?|gates?|experiments?/i.test(varName)) {
          for (const el of node.init.elements) {
            const elVal = foldBinaryExpression(el) || (el?.type === 'Literal' ? el.value : null);
            if (elVal && typeof elVal === 'string') {
              addFinding(CATEGORIES.FEATURE_FLAG, elVal, el, `FlagArray(${node.id.name})`);
            }
          }
        }
      }
    },

    // 5. Assignment Expressions (e.g. config.model = "...", this.endpoint = "...")
    AssignmentExpression(node) {
      if (!node.left || !node.right) return;
      let propName = '';
      if (node.left.type === 'MemberExpression' && node.left.property) {
        propName = (node.left.property.name || node.left.property.value || '').toString().toLowerCase();
      }

      if (MODEL_PROPERTY_NAMES.has(propName)) {
        const val = foldBinaryExpression(node.right) || (node.right.type === 'Literal' ? node.right.value : null);
        if (val && typeof val === 'string') {
          addFinding(CATEGORIES.MODEL_ID, val, node.right, `Assignment(${propName})`);
        }
      }
    },

    // 6. Feature Flag & Endpoint Calls (e.g. checkGate("canary_feature"), fetch("https://..."))
    CallExpression(node) {
      if (!node.callee) return;
      let fnName = '';
      if (node.callee.type === 'Identifier') {
        fnName = node.callee.name.toLowerCase();
      } else if (node.callee.type === 'MemberExpression' && node.callee.property) {
        fnName = (node.callee.property.name || '').toLowerCase();
      }

      if (GATE_FUNCTION_NAMES.has(fnName) && node.arguments && node.arguments.length > 0) {
        const arg0 = foldBinaryExpression(node.arguments[0]) || (node.arguments[0].type === 'Literal' ? node.arguments[0].value : null);
        if (arg0 && typeof arg0 === 'string') {
          addFinding(CATEGORIES.FEATURE_FLAG, arg0, node.arguments[0], `Call(${fnName})`);
        }
      } else if (NETWORK_FUNCTION_NAMES.has(fnName) && node.arguments && node.arguments.length > 0) {
        const arg0 = foldBinaryExpression(node.arguments[0]) || (node.arguments[0].type === 'Literal' ? node.arguments[0].value : null);
        if (arg0 && typeof arg0 === 'string' && /^(?:https?:\/\/|wss?:\/\/|\/)/i.test(arg0)) {
          addFinding(CATEGORIES.ENDPOINT_DOMAIN, arg0, node.arguments[0], `Call(${fnName})`);
        }
      }
    },
  });

  return findings;
}
