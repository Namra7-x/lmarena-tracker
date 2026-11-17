import test from 'node:test';
import assert from 'node:assert/strict';

import { splitTelegramText } from '../reverse-tracker/telegram/client.mjs';
import { formatCompletionMessage } from '../reverse-tracker/telegram/formatter.mjs';
import { matchSignalsInText } from '../reverse-tracker/finder/rules.mjs';
import { extractSignalsFromAst } from '../reverse-tracker/extraction/ast.mjs';

function count(value, needle) {
  return value.split(needle).length - 1;
}

test('long HTML messages split on balanced tags without exceeding Telegram limits', () => {
  const lines = ['<b>REPORT HEADER</b>'];
  for (let i = 0; i < 180; i++) {
    lines.push(`• <b>model_id:</b> <code>model-${i}-${'x'.repeat(80)}</code>`);
  }
  lines.push(`<blockquote expandable>${lines.slice(1, 40).join('\n')}</blockquote>`);

  const chunks = splitTelegramText(lines.join('\n'), 900);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 4096);
    assert.equal(count(chunk, '<b>'), count(chunk, '</b>'), 'balanced bold tags');
    assert.equal(count(chunk, '<code>'), count(chunk, '</code>'), 'balanced code tags');
    assert.equal(count(chunk, '<blockquote'), count(chunk, '</blockquote>'), 'balanced blockquote tags');
  }
});

test('completion includes early signals when there are no major or high signals', () => {
  const msg = formatCompletionMessage({
    componentName: 'Codex CLI',
    family: 'openai',
    oldVersion: '0.1.0',
    newVersion: '0.2.0',
    scanId: 'CX-20261116-001',
    moreFindings: [
      { category: 'feature_flag', value: 'enable_agentic_flow', score: 42 },
    ],
    leakCount: 1,
    coverage: { coverageState: 'COMPLETE' },
  });

  assert.ok(msg.includes('EARLY SIGNALS'));
  assert.ok(msg.includes('enable_agentic_flow'));
  assert.ok(!msg.includes('No early leak signals'));
});

test('pricing tables are extracted from minified JSON and AST catalog objects', () => {
  const text = '{"model":"gpt-5-preview","input_price":2.5,"output_price":10,"context_window":200000}';
  const textFindings = matchSignalsInText(text, 'catalog.json');
  const textPricing = textFindings.find((f) => f.category === 'pricing');
  assert.ok(textPricing, 'JSON pricing row found');
  assert.match(textPricing.value, /gpt-5-preview/);
  assert.match(textPricing.value, /input \$2\.5\/1M/);
  assert.match(textPricing.value, /output \$10\/1M/);
  assert.ok(textFindings.some((f) => f.category === 'model_id' && f.value === 'gpt-5-preview'));

  const js = `
    const catalog = [
      { model: "claude-3-5-sonnet", input_price: 3, output_price: 15, context_window: 200000 },
    ];
  `;
  const astFindings = extractSignalsFromAst(js, 'catalog.js');
  const astPricing = astFindings.find((f) => f.category === 'pricing');
  assert.ok(astPricing, 'AST pricing row found');
  assert.match(astPricing.value, /claude-3-5-sonnet/);
  assert.equal(astPricing.related.inputPrice, 3);
  assert.equal(astPricing.related.outputPrice, 15);
});
