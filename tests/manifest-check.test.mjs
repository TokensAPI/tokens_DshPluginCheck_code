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

// ---- M14/M15:只看清单,两条路径共用 -------------------------------
// 这两条落在 checkManifestFields 里,所以 cross-path 对拍自动覆盖它们;
// 这里只钉具体判定。

const fieldRules = (manifest, rule) => checkManifestFields(manifest, undefined)
  .filter(finding => finding.rule === rule)

test('M14:publishConfig.registry 未声明判 warning', () => {
  assert.equal(fieldRules(BASE, 'M14-publish-target').length, 1)
})

test('M14:不断言具体 Registry —— 发到公共 npm 是合法选择,不报', () => {
  const pub = { ...BASE, publishConfig: { registry: 'https://registry.npmjs.org/' } }
  assert.deepEqual(fieldRules(pub, 'M14-publish-target'), [])
  const priv = { ...BASE, publishConfig: { registry: 'https://npm.tokensapi.ai/' } }
  assert.deepEqual(fieldRules(priv, 'M14-publish-target'), [])
})

test('M14:registry 不是 https URL 判 warning', () => {
  for (const registry of ['npm.tokensapi.ai', 'http://npm.tokensapi.ai/', 42]) {
    assert.equal(fieldRules({ ...BASE, publishConfig: { registry } }, 'M14-publish-target').length, 1, String(registry))
  }
})

const MARKET_OK = {
  displayName: { 'zh-CN': '体检', 'en-US': 'Check' },
  summary: { 'zh-CN': '中文简介', 'en-US': 'English summary' },
}

test('M15:双语文案齐全则不报', () => {
  assert.deepEqual(fieldRules({ ...BASE, tokenscowork: MARKET_OK }, 'M15-market-i18n'), [])
})

test('M15:tokenscowork 未声明判 warning', () => {
  assert.equal(fieldRules(BASE, 'M15-market-i18n').length, 1)
})

test('M15:把中文复制进 en-US 要被抓住', () => {
  const copied = {
    displayName: { 'zh-CN': '体检', 'en-US': '体检' },
    summary: { 'zh-CN': '中文简介', 'en-US': ' 中文简介 ' },
  }
  const found = fieldRules({ ...BASE, tokenscowork: copied }, 'M15-market-i18n')
  assert.equal(found.length, 2)
  for (const finding of found) assert.match(finding.message, /逐字相同/u)
})

test('M15:缺 locale、空串、形状不对都判 warning', () => {
  const cases = [
    { displayName: { 'zh-CN': '体检' }, summary: MARKET_OK.summary },
    { displayName: { 'zh-CN': '体检', 'en-US': '   ' }, summary: MARKET_OK.summary },
    { displayName: 'Check', summary: MARKET_OK.summary },
    { summary: MARKET_OK.summary },
  ]
  for (const tokenscowork of cases) {
    assert.ok(fieldRules({ ...BASE, tokenscowork }, 'M15-market-i18n').length >= 1, JSON.stringify(tokenscowork))
  }
})

// ---- M16:声明了 license 要有正文 ---------------------------------
// LICENSE 被 npm 无条件打进 tarball,所以解包目录里也判(与 M13 不同)。

const m16 = (dir, options) => rules(checkManifest(dir, options), 'warning').filter(r => r === 'M16-license-file')

test('M16:声明了 license 但没有正文文件,判 warning', () => {
  const dir = fixture(BASE)
  try {
    assert.deepEqual(m16(dir), ['M16-license-file'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('M16:有正文文件则不报,LICENCE/.md 拼法都认', () => {
  for (const name of ['LICENSE', 'LICENCE', 'LICENSE.md', 'LICENSE.txt']) {
    const dir = fixture(BASE)
    try {
      writeFileSync(join(dir, name), 'MIT')
      assert.deepEqual(m16(dir), [], name)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }
})

test('M16:没声明 license 就不是它的事(那是 M9)', () => {
  const { license, ...noLicense } = BASE
  const dir = fixture(noLicense)
  try {
    assert.deepEqual(m16(dir), [])
    assert.ok(rules(checkManifest(dir), 'warning').includes('M9-license'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('M16:解包目录也判 —— LICENSE 本来就在包里', () => {
  const dir = fixture(BASE)
  try {
    assert.deepEqual(m16(dir, { workspace: false }), ['M16-license-file'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ---- M13:有没有测试 ------------------------------------------
// 只影响仓库能不能自证改动没坏,不影响能不能装入宿主,所以与 M9-license
// 同级判 warning。判 error 会把合格插件挡在市场门外。

const m13 = dir => rules(checkManifest(dir), 'warning').filter(rule => rule === 'M13-tests')

test('M13:没有 scripts.test 判 warning', () => {
  const dir = fixture(BASE)
  try {
    assert.deepEqual(m13(dir), ['M13-tests'])
    assert.deepEqual(rules(checkManifest(dir), 'error'), [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('M13:npm init 的占位命令等同于没有测试', () => {
  const dir = fixture({ ...BASE, scripts: { test: 'echo "Error: no test specified" && exit 1' } })
  try {
    assert.deepEqual(m13(dir), ['M13-tests'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('M13:有命令但目录里没有测试文件,仍判 warning', () => {
  const dir = fixture({ ...BASE, scripts: { test: 'node --test' } })
  try {
    assert.deepEqual(m13(dir), ['M13-tests'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('M13:命令与测试文件都在则不报;常见目录和源码内后缀都认', () => {
  for (const place of [['tests', 'a.test.mjs'], ['__tests__', 'b.spec.ts'], ['src', 'c.test.js']]) {
    const dir = fixture({ ...BASE, scripts: { test: 'node --test' } })
    try {
      mkdirSync(join(dir, place[0]), { recursive: true })
      writeFileSync(join(dir, place[0], place[1]), '')
      assert.deepEqual(m13(dir), [], `${place[0]}/${place[1]} 应被认作测试文件`)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }
})

test('M13:解包目录(--package)不判,tests/ 本来就不在包里', () => {
  const dir = fixture({ ...BASE, scripts: { test: 'node --test' } })
  try {
    assert.deepEqual(rules(checkManifest(dir, { workspace: false }), 'warning').filter(r => r === 'M13-tests'), [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('M13:node_modules 里的测试文件不算数', () => {
  const dir = fixture({ ...BASE, scripts: { test: 'node --test' } })
  try {
    mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'dep', 'x.test.js'), '')
    assert.deepEqual(m13(dir), ['M13-tests'])
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
