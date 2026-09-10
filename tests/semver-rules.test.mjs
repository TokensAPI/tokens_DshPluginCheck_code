import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkEngine, checkIdentity, checkPeerRanges, versionSatisfies } from '../lib/semver-rules.mjs'

const rules = (findings, level) => findings.filter(f => f.level === level).map(f => f.rule)

/**
 * 这一组全部是 0.3.4 的手写迷你 SemVer **实测判错**的范围:它只认完整
 * 三段版本号,于是把这些完全合法的 npm 范围判成"不可识别"(null),
 * 而注册表路径把 null 映射成 error —— 合格插件被判不合格。
 */
test('迷你 SemVer 判错的合法范围现在一律认得', () => {
  for (const range of ['>=1.2', '1.x', '1.2', '1.2.0 - 2.0.0', '>=0.1 <0.2', '*', '']) {
    assert.equal(versionSatisfies('1.2.3', range), range === '>=0.1 <0.2' ? false : true, `range=${range}`)
  }
  assert.equal(versionSatisfies('0.1.3-alpha.1', '>=0.1 <0.2'), true)
})

test('真正不合法的范围仍返回 null(保持既有对外契约)', () => {
  assert.equal(versionSatisfies('1.0.0', 'not-a-range'), null)
  assert.equal(versionSatisfies('1.0.0', 'workspace:*'), null)
  assert.equal(versionSatisfies('1.0.0', 'latest'), null)
  assert.equal(versionSatisfies('not-a-version', '^1.0.0'), null)
})

test('预发布运行时必须能落进普通范围(includePrerelease)', () => {
  // 目标运行时长期是 0.1.3-alpha.1 这种预发布版。不带 includePrerelease
  // 时 semver 会把它排除在任何范围之外,得出"谁都不兼容"的荒谬结论。
  assert.equal(versionSatisfies('0.1.3-alpha.1', '>=0.1.0 <0.2.0'), true)
  assert.equal(versionSatisfies('0.1.3-alpha.1', '^0.1.0'), true)
})

test('M1:name/version 缺失或非法是 error,预发布是 warning', () => {
  assert.deepEqual(rules(checkIdentity({}), 'error'), ['M1-manifest', 'M1-manifest'])
  assert.deepEqual(rules(checkIdentity({ name: '@x/a', version: '1.0' }), 'error'), ['M1-manifest'])
  const pre = checkIdentity({ name: '@x/a', version: '1.0.0-rc.1' })
  assert.deepEqual(rules(pre, 'error'), [])
  assert.deepEqual(rules(pre, 'warning'), ['M1-manifest'])
})

test('M6:范围合法性与覆盖判定分开,runtime 可省略', () => {
  const manifest = { dsh: { engine: '>=0.1 <0.2' } }
  assert.deepEqual(checkEngine(manifest, undefined), [])
  assert.deepEqual(checkEngine(manifest, '0.1.3-alpha.1'), [])
  assert.deepEqual(rules(checkEngine(manifest, '0.3.0'), 'error'), ['M6-engine'])
  assert.deepEqual(rules(checkEngine({ dsh: { engine: 'latest' } }), 'error'), ['M6-engine'])
  assert.deepEqual(rules(checkEngine({}), 'warning'), ['M6-engine'])
})

test('M7:@deepseek-ai/cordis 的范围同样要校验(0.3.4 完全漏掉)', () => {
  const findings = checkPeerRanges({
    peerDependencies: { '@deepseek-ai/cordis': 'not-a-range' },
  }, '0.1.3-alpha.1')
  assert.deepEqual(rules(findings, 'error'), ['M7-peer-range'])
})

test('M7:cordis 自成 4.x 版本线,不拿它跟 DSH 运行时比"是否包含"', () => {
  // 本包自己的清单就是这个形状。把 M7 的覆盖判定一并放开到 cordis 会
  // 立刻产生一条"4.0.1 || 4.0.2 不含 0.1.3-alpha.1"的假 warning。
  const findings = checkPeerRanges({
    peerDependencies: { '@deepseek-ai/cordis': '4.0.1 || 4.0.2' },
  }, '0.1.3-alpha.1')
  assert.deepEqual(findings, [])
})

test('M7:非核心 peer 不参与判定,不含目标运行时只是 warning', () => {
  const findings = checkPeerRanges({
    peerDependencies: { react: 'whatever', '@deepseek-ai/dsh-tools': '0.1.0-rc.8' },
  }, '0.1.3-alpha.1')
  assert.deepEqual(rules(findings, 'error'), [])
  assert.deepEqual(rules(findings, 'warning'), ['M7-peer-range'])
})

test('M7:未给 runtime 时只判范围合法性', () => {
  const findings = checkPeerRanges({ peerDependencies: { '@deepseek-ai/dsh-tools': '0.1.0-rc.8' } }, undefined)
  assert.deepEqual(findings, [])
})
