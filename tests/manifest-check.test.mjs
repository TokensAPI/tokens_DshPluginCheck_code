import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkManifest, checkManifestFields } from '../lib/manifest-check.mjs'

const GOOD_PATCH = `- insert:
    - id: fixture-plugin
      name: '@fixture/plugin'
`

function fixture(manifest, patch = GOOD_PATCH) {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-check-fixture-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, undefined, 2))
  if (patch !== undefined) writeFileSync(join(dir, 'cordis.patch.yml'), patch)
  return dir
}

const BASE = {
  name: '@fixture/plugin',
  version: '1.0.0',
  license: 'MIT',
  engines: { node: '>=22' },
  peerDependencies: { '@deepseek-ai/cordis': '^4.0.0' },
  dsh: { bundle: { patch: './cordis.patch.yml' } },
}

function rules(result, level) {
  return result.findings.filter(finding => finding.level === level).map(finding => finding.rule)
}

test('合格清单只剩 engine 待补的提示', () => {
  const dir = fixture(BASE)
  try {
    const result = checkManifest(dir)
    assert.deepEqual(rules(result, 'error'), [])
    assert.ok(rules(result, 'warning').includes('M6-engine'))
    assert.equal(result.rows?.length, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('生命周期脚本逐个标注(受控安装已不再因此拒绝,故为 warning)', () => {
  const dir = fixture({ ...BASE, scripts: { postinstall: 'node evil.js', prepack: 'ok' } })
  try {
    const result = checkManifest(dir)
    assert.deepEqual(rules(result, 'error'), [])
    assert.ok(rules(result, 'warning').includes('M2-lifecycle'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('核心运行时进 dependencies 判为双内核错误', () => {
  const dir = fixture({ ...BASE, dependencies: { '@deepseek-ai/dsh-tools': '0.1.0-rc.8' } })
  try {
    assert.ok(rules(checkManifest(dir), 'error').includes('M3-core-peer'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('补丁行越出包命名空间被拒', () => {
  const dir = fixture(BASE, `- insert:
    - id: hostile
      name: 'some-other-package'
`)
  try {
    assert.ok(rules(checkManifest(dir), 'error').includes('M5-row-scope'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('engine 与目标运行时不相交是 error,peer 不含目标是 warning', () => {
  const dir = fixture({
    ...BASE,
    dsh: { ...BASE.dsh, engine: '>=0.1.0 <0.1.2' },
    peerDependencies: { ...BASE.peerDependencies, '@deepseek-ai/dsh-tools': '0.1.0-rc.8' },
  })
  try {
    const result = checkManifest(dir, { runtime: '0.1.3-alpha.1' })
    assert.ok(rules(result, 'error').includes('M6-engine'))
    assert.ok(rules(result, 'warning').includes('M7-peer-range'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('engine 覆盖目标运行时则通过', () => {
  const dir = fixture({ ...BASE, dsh: { ...BASE.dsh, engine: '>=0.1.3-alpha.1 <0.2.0' } })
  try {
    const result = checkManifest(dir, { runtime: '0.1.3-alpha.1' })
    assert.ok(!rules(result, 'error').includes('M6-engine'))
    assert.ok(!rules(result, 'warning').includes('M6-engine'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('补丁缺失、不可解析、空行分别报错', () => {
  const missing = fixture({ ...BASE, dsh: { bundle: { patch: './nope.yml' } } }, undefined)
  const broken = fixture(BASE, '{not yaml')
  const empty = fixture(BASE, '[]\n')
  try {
    assert.ok(rules(checkManifest(missing), 'error').includes('M4-bundle'))
    assert.ok(rules(checkManifest(broken), 'error').includes('M4-bundle'))
    assert.ok(rules(checkManifest(empty), 'error').includes('M4-bundle'))
  } finally {
    for (const dir of [missing, broken, empty]) rmSync(dir, { recursive: true, force: true })
  }
})

test('files 白名单里的凭据样式文件被拒', () => {
  const dir = fixture({ ...BASE, files: ['lib', '.env.production'] })
  try {
    assert.ok(rules(checkManifest(dir), 'error').includes('M10-secrets'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ---- M4:补丁路径形状(逐字对齐上游 safeBundlePatch) --------------
// 这些写法 0.3.4 全部放行:包能装、能跑、体检全绿,但市场受控安装的
// 验证器一律拒绝 —— 用户端永远只看到手动安装命令。
const patchRules = patch => checkManifestFields({ ...BASE, dsh: { bundle: { patch } } }, undefined)
  .filter(finding => finding.rule === 'M4-bundle')

test('M4:上游会拒的补丁路径形状一律判 error', () => {
  const bad = ['../outside/patch.yml', '/abs/patch.yml', 'dist\\patch.yml', './a//b.yml', './c:/patch.yml', `./${'x'.repeat(600)}.yml`]
  for (const patch of bad) {
    const findings = patchRules(patch)
    assert.equal(findings.length, 1, `patch=${patch}`)
    assert.equal(findings[0].level, 'error', `patch=${patch}`)
  }
})

test('M4:合法形状放行,包括不带 ./ 前缀与多层嵌套', () => {
  for (const patch of ['./cordis.patch.yml', 'cordis.patch.yml', './deep/nested/ok.yml']) {
    assert.deepEqual(patchRules(patch), [], `patch=${patch}`)
  }
})
