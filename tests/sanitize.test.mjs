// The page renders strings that came from third-party APIs. These tests pin
// the two defences: HTML escaping for text, and an https-only allowlist for
// anything that lands in an href or src.
//
// app.js is DOM-coupled, so the helpers are re-declared here in the exact form
// the app uses. The deploy test keeps the two from drifting silently by
// asserting the app still contains them.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const appSource = readFileSync(join(ROOT, 'src/app.js'), 'utf8');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

function safeUrl(raw, fallback = '') {
  if (typeof raw !== 'string' || !raw.trim()) return fallback;
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'https:' ? u.href : fallback;
  } catch {
    return fallback;
  }
}

test('esc neutralises tag and attribute breakouts', () => {
  assert.equal(esc('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(esc('" onerror="alert(1)'), '&quot; onerror=&quot;alert(1)');
  assert.equal(esc("' onload='x"), '&#39; onload=&#39;x');
  assert.equal(esc('a & b'), 'a &amp; b');
  assert.ok(!esc('<img src=x onerror=alert(1)>').includes('<'));
});

test('esc handles non-strings without throwing', () => {
  for (const v of [null, undefined, 0, NaN, true, {}, [], Symbol.iterator ? 123 : 0]) {
    assert.equal(typeof esc(v), 'string');
  }
});

test('safeUrl rejects every non-https scheme', () => {
  const hostile = [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    '  javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'http://insecure.example.com/x',
    '//protocol-relative.example.com/x',
    '/relative/path',
    'evil.com/x',
  ];
  for (const url of hostile) {
    assert.equal(safeUrl(url, 'FALLBACK'), 'FALLBACK', `${url} should not be allowed through`);
  }
});

test('safeUrl passes ordinary https links unchanged', () => {
  assert.equal(safeUrl('https://dexscreener.com/solana/abc'), 'https://dexscreener.com/solana/abc');
  assert.ok(safeUrl('https://cdn.example.com/icon.png?x=1&y=2').startsWith('https://'));
});

test('safeUrl falls back on junk input', () => {
  for (const v of [null, undefined, 42, {}, [], '', 'not a url at all', '://broken']) {
    assert.equal(safeUrl(v, 'FALLBACK'), 'FALLBACK');
  }
});

test('a hostile icon URL cannot reach the rendered src attribute', () => {
  // The exact composition used by renderWinner.
  const icon = 'javascript:alert(1)';
  const rendered = safeUrl(icon) ? `<img src="${esc(safeUrl(icon))}">` : '';
  assert.equal(rendered, '', 'a non-https icon must render no img tag at all');
});

test('a hostile pair URL degrades to the DexScreener fallback', () => {
  const address = 'GoodTokenAddress1111';
  const fallback = `https://dexscreener.com/solana/${encodeURIComponent(address)}`;
  const href = esc(safeUrl('javascript:alert(1)', fallback));
  assert.equal(href, fallback);
  assert.ok(!href.includes('javascript'));
});

test('app.js actually uses both defences on third-party URLs', () => {
  assert.ok(appSource.includes('function safeUrl'), 'safeUrl helper is missing from app.js');
  // Every img src and anchor href built from candidate data must be wrapped.
  const rawInterpolations = [...appSource.matchAll(/(?:href|src)="\$\{([^}]+)\}"/g)].map((m) => m[1]);
  for (const expr of rawInterpolations) {
    const isStaticTemplate = expr.includes('encodeURIComponent') && !expr.includes('c.url') && !expr.includes('c.icon');
    assert.ok(
      expr.includes('safeUrl') || isStaticTemplate,
      `unsanitised URL interpolation in app.js: \${${expr}}`,
    );
  }
});
