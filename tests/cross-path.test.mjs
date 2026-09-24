/* ============================================================
 * 两条执行路径的对拍
 * ============================================================
 * CLI 走 checkManifest(读盘),会话内 plugin_check(package=…) 走
 * checkPublishedManifest(读 registry 版本文档)。0.3.4 时这两条各写
 * 各的规则,同一个包能拿到相反结论 —— 一条说合格、一条说 M6-engine
 * error。这份测试是"不许再漂"的闸门:凡是只看清单就能判的规则,两边
 * 必须逐条一致。
 *
 * 允许的差异只有"要看工作区才能判"的那几条(M10-secrets、M13-tests):
 * registry 路径没有工作区。这是有意的,写在 docs/CHECKS.md §1,也在这里
 * 显式豁免。
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkManifest } from '../lib/manifest-check.mjs'
import { checkPublishedManifest } from '../lib/registry-check.mjs'

/** 补丁行始终指向本包自身,免得包名类用例顺带引出 M5(那不是本测试要比的东西)。 */
const patchFor = manifest => `- insert:
    - id: fixture-main
      name: '${manifest.name ?? '@fixture/plugin'}'
`

/**
 * 只看清单就能判的规则集之外的两类,不参与对拍:
 *  - M10-secrets 要扫工作区文件,M13-tests 要看 tests/ 与 scripts.test,
 *    而 tests/ 不进 tarball,registry 路径两者都看不到;
 *  - M5-row-scope / M11-row-identity 要读补丁内容,registry 路径靠
 *    checkPublishedPackage 取 tarball 才有,checkPublishedManifest 不含。
 */
const DISK_ONLY = new Set(['M10-secrets', 'M13-tests', 'M5-row-scope', 'M11-row-identity'])

const comparable = findings => findings
  .filter(f => !DISK_ONLY.has(f.rule))
  .map(f => `${f.level}:${f.rule}`)
  .sort()

/** 在临时目录里落盘一份插件,跑目录路径,再跑注册表路径,比对。 */
function bothPaths(manifest, runtime) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-plugin-check-crosspath-'))
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    writeFileSync(join(dir, 'cordis.patch.yml'), patchFor(manifest))
    const disk = checkManifest(dir, { runtime })
    const registry = checkPublishedManifest(manifest, runtime)
    return { disk: disk.findings, registry }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const BASE = {
  name: '@fixture/plugin',
  version: '1.0.0',
  license: 'MIT',
  engines: { node: '>=22' },
  peerDependencies: { '@deepseek-ai/dsh-tools': '0.1.0-rc.8 || 0.1.3-alpha.1' },
  dsh: { engine: '>=0.1.0-rc.8 <0.2.0', bundle: { patch: './cordis.patch.yml' } },
}

/**
 * 每个用例都是 0.3.4 上两条路径**实际给出不同结论**的形状,
 * 或者一旦某天有人只改一边就会立刻炸掉的形状。
 */
const CASES = [
  ['合格清单', BASE],
  ['npm 合法但迷你 SemVer 不认的 engine 范围', { ...BASE, dsh: { ...BASE.dsh, engine: '>=0.1 <0.2' } }],
  ['连字符范围', { ...BASE, dsh: { ...BASE.dsh, engine: '0.1.0 - 0.2.0' } }],
  ['name 缺失', { ...BASE, name: undefined }],
  ['version 非法', { ...BASE, version: '1.0' }],
  ['预发布版本', { ...BASE, version: '1.0.0-rc.1' }],
  ['包名不合规', { ...BASE, name: '@Fixture/Plugin' }],
  ['包名在上游黑名单里', { ...BASE, name: 'dsh-community-market' }],
  ['核心包进 dependencies', { ...BASE, dependencies: { '@deepseek-ai/cordis': '0.1.0' } }],
  ['cordis peer 范围写坏', { ...BASE, peerDependencies: { '@deepseek-ai/cordis': 'not-a-range' } }],
  ['生命周期脚本', { ...BASE, scripts: { postinstall: 'node evil.js' } }],
  ['engines.node 与宿主无交集', { ...BASE, engines: { node: '>=18 <20' } }],
  ['license 未声明', { ...BASE, license: undefined }],
  ['dsh.client 声明写坏', { ...BASE, dsh: { ...BASE.dsh, client: { platform: 'web' } } }],
  ['误抄宿主侧字段', { ...BASE, dsh: { ...BASE.dsh, profile: {}, moduleFallback: {} } }],
]

for (const [label, manifest] of CASES) {
  test(`两条路径结论一致: ${label}`, () => {
    const { disk, registry } = bothPaths(manifest, '0.1.3-alpha.1')
    assert.deepEqual(comparable(disk), comparable(registry))
  })
}

test('未给 runtime 时两条路径也一致,且不会凭空产生 M6/M7 error', () => {
  const { disk, registry } = bothPaths(BASE, undefined)
  assert.deepEqual(comparable(disk), comparable(registry))
  assert.deepEqual(disk.filter(f => f.level === 'error'), [])
  assert.deepEqual(registry.filter(f => f.level === 'error'), [])
})
