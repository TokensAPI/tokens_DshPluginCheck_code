import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// The market reads `tokenscowork`; the dsh Plugins page reads only `locale/<lang>.json`. Both must say the same thing.
const root = new URL('../', import.meta.url);
const read = (path) => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
const manifest = read('package.json');

test('dsh plugin page shows the same bilingual metadata as the market', () => {
  for (const [lang, key] of [['en', 'en-US'], ['zh', 'zh-CN']]) {
    const { meta } = read(`locale/${lang}.json`);
    assert.equal(meta.title, manifest.tokenscowork.displayName[key]);
    assert.equal(meta.description, manifest.tokenscowork.summary[key]);
    for (const text of [meta.title, meta.description]) assert.ok(typeof text === 'string' && text.trim());
  }
  const [en, zh] = ['en', 'zh'].map((lang) => read(`locale/${lang}.json`).meta);
  assert.notEqual(en.title, zh.title);
  assert.notEqual(en.description, zh.description);
});

test('locale files are exported and packed', () => {
  assert.equal(manifest.exports['./locale/*.json'], './locale/*.json');
  assert.equal(manifest.exports['./package.json'], './package.json');
  const [{ files }] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root, encoding: 'utf8', shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'ignore'],
  }));
  const packed = new Set(files.map(({ path }) => path));
  for (const path of ['package.json', 'locale/en.json', 'locale/zh.json']) assert.ok(packed.has(path), path);
});
