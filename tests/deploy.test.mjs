// Guards the packaging, not the logic. The app is deployed twice — an nginx
// image for Unraid and a staged directory for GitHub Pages — and both list the
// files to copy by hand. Adding a module and forgetting one of those lists
// produces a site that 404s on load, which no unit test would catch.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const html = read('index.html');
const dockerfile = read('Dockerfile');
const workflow = read('.github/workflows/pages.yml');
const srcFiles = readdirSync(join(ROOT, 'src')).filter((f) => f.endsWith('.js'));

test('every module in src/ is reachable from the import graph', () => {
  const entry = read('src/app.js');
  const allSource = srcFiles.map((f) => read(`src/${f}`)).join('\n');
  for (const file of srcFiles) {
    if (file === 'app.js') continue;
    assert.ok(
      allSource.includes(`./${file}`) || entry.includes(`./${file}`),
      `src/${file} is never imported — dead file or a missing wire-up`,
    );
  }
});

test('index.html references only files that exist', () => {
  const refs = [...html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)].map((m) => m[1]);
  assert.ok(refs.length >= 2, 'expected at least the stylesheet and the entry script');
  for (const ref of refs) {
    assert.doesNotThrow(() => read(ref), `index.html references missing file ${ref}`);
  }
});

test('the Docker image copies every runtime asset', () => {
  for (const asset of ['index.html', 'styles.css']) {
    assert.ok(dockerfile.includes(asset), `Dockerfile does not copy ${asset}`);
  }
  assert.ok(/COPY\s+src\s+/.test(dockerfile), 'Dockerfile does not copy the src directory');
  assert.ok(dockerfile.includes('nginx.conf'), 'Dockerfile does not copy nginx.conf');
});

test('the Pages workflow stages every runtime asset', () => {
  for (const asset of ['index.html', 'styles.css']) {
    assert.ok(workflow.includes(asset), `Pages workflow does not stage ${asset}`);
  }
  assert.ok(/cp -r src /.test(workflow), 'Pages workflow does not stage the src directory');
});

test('the Pages workflow runs the tests before deploying', () => {
  assert.ok(workflow.includes('node --test'), 'workflow does not run the test suite');
  assert.ok(/needs:\s*test/.test(workflow), 'deploy job does not depend on the test job');
});

test('nginx serves .js with a JavaScript content type', () => {
  const conf = read('nginx.conf');
  // A wrong MIME type here means the browser refuses every ES module and the
  // page silently renders nothing.
  assert.match(conf, /application\/javascript\s+js/, 'nginx.conf must map .js to application/javascript');
});

test('no source file imports a bare package — the app must stay dependency-free', () => {
  for (const file of srcFiles) {
    const source = read(`src/${file}`);
    const imports = [...source.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    for (const spec of imports) {
      assert.ok(
        spec.startsWith('./') || spec.startsWith('../'),
        `src/${file} imports "${spec}" — the browser build has no bundler or node_modules`,
      );
    }
  }
});

test('no stray API keys or secrets are committed', () => {
  const config = read('src/config.js');
  const keyFields = [...config.matchAll(/(\w*(?:ApiKey|Token|Secret)\w*)\s*:\s*'([^']*)'/g)];
  assert.ok(keyFields.length > 0, 'expected the optional paid-key placeholders to exist');
  for (const [, field, value] of keyFields) {
    assert.equal(value, '', `${field} must ship empty, found a value`);
  }
});
