/**
 * JavaScript AST Intelligence Engine (Section 6)
 * Uses Acorn to parse minified JS, CommonJS, and ES Modules.
 * Folds constant binary expressions, resolves template literal prefixes,
 * and extracts model slots, feature flags, and API/WebSocket routes.
 */

import * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import { CATEGORIES } from '../finder/rules.mjs';

const MODEL_PROPERTY_NAMES = new Set([
  'model',
  'model_slug',
  'model_id',
  'model_name',
  'default_model',
  'defaultmodel',
  'fallbackmodel',
  'reasoningmodel',
  'evalmodel',
  'chat_model',
  'active_model',
  'primary_model',
  'subagent_model',
  'selected_model',
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
]);

const NETWORK_FUNCTION_NAMES = new Set([
  'fetch',
  'websocket',
  'request',
  'get',
  'post',
  'put',
  'connect',
]);

/**
 * Safely parse JavaScript code into an AST with module, script, and CommonJS fallback.
 */
export function parseJsAst(code) {
  if (!code || typeof code !== 'string') return null;

  const baseOptions = {
    ecmaVersion: 'latest',
    allowReturnOutsideFunction: true,
    allowHashBang: true,
    allowAwaitOutsideFunction: true,
    locations: true,
  };

  // 1. Try ES Module
  try {
    return acorn.parse(code, { ...baseOptions, sourceType: 'module' });
  } catch (modErr) {
    // 2. Cascade to CommonJS / Script
    try {
      return acorn.parse(code, { ...baseOptions, sourceType: 'script' });
    } catch (scriptErr) {
      return null;
    }
  }
}

/**
 * Recursively fold compile-time constant string additions (e.g. "/api/" + "v1" -> "/api/v1").
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
  return null;
}

/**
 * Extract signals, endpoints, models, and flags from JavaScript AST.
 * Returns an array of { category, value, offset, context, rawExpression, filePath }.
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
    const context = code.slice(Math.max(0, start - 40), Math.min(code.length, end + 40)).replace(/[\r\n]+/g, ' ');

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

    // 2. Template Literals (static quasis prefixes e.g. `https://internal.google.com/v1/${path}`)
    TemplateLiteral(node) {
      if (node.quasis && node.quasis.length > 0) {
        const staticPrefix = node.quasis[0].value.cooked || node.quasis[0].value.raw || '';
        if (/^(?:https?:\/\/|wss?:\/\/|\/api\/|\/v[0-9]+|\/internal\/)/i.test(staticPrefix)) {
          addFinding(CATEGORIES.ENDPOINT_DOMAIN, staticPrefix, node, 'TemplateLiteral');
        }
      }
    },

    // 3. Object Properties (e.g. { defaultModel: "gemini-3.8-flash-tts" })
    Property(node) {
      if (!node.key) return;
      const keyName = (node.key.name || node.key.value || '').toString().toLowerCase();

      if (MODEL_PROPERTY_NAMES.has(keyName)) {
        const modelVal = foldBinaryExpression(node.value) || (node.value.type === 'Literal' ? node.value.value : null);
        if (modelVal && typeof modelVal === 'string') {
          addFinding(CATEGORIES.MODEL_ID, modelVal, node.value, `Property(${keyName})`);
        }
      }
    },

    // 4. Feature Flag Calls (e.g. checkGate("canary_feature"), variation("exp_123"))
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
