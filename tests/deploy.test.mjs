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

  // One exception, made deliberately and by name. This is a keyless static
  // site: there is no server to hold a secret, so a key that must work on
  // GitHub Pages has to be in the bundle. `heliusApiKey` is a free-tier key
  // whose worst case is someone spending the rate limit. Every other field
  // still has to ship empty, so this stays a real guard against an accidental
  // paste rather than a hole that swallows the next one.
  const DELIBERATELY_PUBLIC = new Set(['heliusApiKey']);

  for (const [, field, value] of keyFields) {
    if (DELIBERATELY_PUBLIC.has(field)) continue;
    assert.equal(value, '', `${field} must ship empty, found a value`);
  }
});

test('sized spans are blockified, or they render at zero width', () => {
  const css = read('styles.css');
  // Width and height do not apply to inline elements. Any span-based bar or
  // dot that sets a size must also set a display, or it silently vanishes —
  // exactly the bug that hid the score bars.
  const sizedSelectors = ['.bar-fill', '.bar-track'];
  for (const sel of sizedSelectors) {
    const block = new RegExp(`\\${sel}\\s*\\{[^}]*\\}`, 's');
    const match = css.match(block);
    assert.ok(match, `${sel} rule not found in styles.css`);
    assert.match(match[0], /display:\s*(block|flex|inline-block|grid)/,
      `${sel} sets a size but no display — it will render at zero`);
  }
});

test('the CSP allows exactly the hosts the code calls, and no more', () => {
  const csp = html.match(/Content-Security-Policy"\s+content="([^"]+)"/s);
  assert.ok(csp, 'index.html must carry a Content-Security-Policy meta tag');
  const connectSrc = csp[1].match(/connect-src([^;]+);/s)[1];

  // Every https host referenced by the source must be permitted, or the
  // browser blocks the request at runtime with no server-side warning.
  const sourceHosts = new Set();
  for (const file of srcFiles) {
    for (const m of read(`src/${file}`).matchAll(/https:\/\/([a-z0-9.-]+)/gi)) {
      const host = m[1].toLowerCase();
      // Links the user clicks are navigations, not fetches — not connect-src.
      if (/dexscreener\.com$|birdeye\.so$|jup\.ag$/.test(host) && !host.startsWith('api.') && !host.startsWith('lite-api.')) continue;
      if (host === 'rugcheck.xyz' || host === 'example.invalid') continue;
      sourceHosts.add(host);
    }
  }
  for (const host of sourceHosts) {
    assert.ok(connectSrc.includes(host), `CSP connect-src is missing ${host}`);
  }
  assert.ok(!/connect-src[^;]*\*/.test(csp[1]), 'connect-src must not use a wildcard');
  assert.match(csp[1], /default-src\s+'none'/, 'default-src should deny by default');
});

test('nginx.conf is structurally sound and serves the app correctly', () => {
  const conf = read('nginx.conf');
  // There is no nginx binary in CI to -t this against, and the container is the
  // one deployment path that cannot be exercised by these tests, so check the
  // things that would break it silently.
  assert.equal(
    (conf.match(/\{/g) || []).length,
    (conf.match(/\}/g) || []).length,
    'unbalanced braces would stop nginx from starting',
  );
  assert.match(conf, /listen\s+80;/, 'must listen on the port the Dockerfile exposes');
  assert.match(conf, /root\s+\/usr\/share\/nginx\/html;/, 'root must match the Dockerfile COPY target');
  assert.match(conf, /index\s+index\.html;/);
  // A redefined types block replaces the default MIME map entirely, so every
  // type the app actually serves has to be listed.
  const types = conf.match(/types\s*\{([^}]+)\}/s);
  assert.ok(types, 'types block not found');
  for (const [ext, type] of [['html', 'text/html'], ['css', 'text/css'], ['js', 'application/javascript']]) {
    assert.ok(
      new RegExp(`${type}\\s+[^;]*\\b${ext}\\b`).test(types[1]),
      `types block does not map .${ext} to ${type}`,
    );
  }
  assert.match(conf, /try_files/, 'needs a try_files fallback');
});

test('the Dockerfile exposes the port nginx listens on', () => {
  assert.match(dockerfile, /EXPOSE\s+80/);
  assert.match(dockerfile, /FROM\s+nginx:/, 'expected an nginx base image');
  // COPY targets must line up with the root in nginx.conf.
  assert.match(dockerfile, /\/usr\/share\/nginx\/html/);
});

test('docker-compose maps a host port to the container port', () => {
  const compose = read('docker-compose.yml');
  assert.match(compose, /"\d+:80"/, 'compose must publish container port 80');
  assert.match(compose, /restart:\s*unless-stopped/, 'an Unraid container should come back after a reboot');
});
