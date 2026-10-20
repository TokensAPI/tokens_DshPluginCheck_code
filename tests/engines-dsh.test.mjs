/* ============================================================
 * M17:engines.dsh —— DSH 0.2.1 起宿主唯一看的兼容声明
 * ============================================================
 * 0.2.1 把 app-boot 的兼容判定改成两段:清单里有 engines.dsh 就只按它判、
 * dsh peer 全部不看;没有才退回逐个比对 peer。0.2.0 的 app-boot 完全不读
 * engines 字段。所以同一份清单在 0.6 与 0.7 上会得出相反结论,而本工具
 * 0.4.5 只认 peer,于是在 0.2.1 上两头都判错:
 *  1. engines.dsh 没覆盖运行时 → 宿主停用,工具一声不响(漏判,最危险);
 *  2. engines.dsh 覆盖了、peer 过时 → 宿主放行,工具判 error(假阳性)。
 * 这一组用例把两个方向都钉住,并保证 0.2.0 / 0.1 上的判级一个字不变
 * (0.6 和 0.5 的用户还在用)。
 * 真实宿主上的对拍见 tests/host-truth.test.mjs。
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ENGINES_GATE_SINCE } from '../lib/contract.mjs'
import {
  checkEnginesDsh,
  checkPeerRanges,
  checkVersionRules,
  hostReadsEnginesDsh,
  peersDecideCompatibility,
  readEnginesDsh,
} from '../lib/semver-rules.mjs'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const of = (findings, level) => findings.filter(finding => finding.level === level)
const levels = findings => findings.map(finding => `${finding.level}:${finding.rule}`)

/** 三条产品线实际装的 DSH 运行时:0.5.x、0.6.x、0.7.0。 */
const PRODUCT_RUNTIMES = ['0.1.5-rc.2', '0.2.0-rc.2', '0.2.1-rc.2']

test('engines.dsh 的闸门从 0.2.1 的预发布版开始,0.2.0 不读这个字段', () => {
  for (const runtime of ['0.1.5-rc.2', '0.2.0-rc.1', '0.2.0-rc.2', '0.2.0', '0.2.1-rc.0']) {
    assert.equal(hostReadsEnginesDsh(runtime), runtime === '0.2.1-rc.0', runtime)
  }
  for (const runtime of ['0.2.1-rc.2', '0.2.1', '0.2.2', '0.3.0']) {
    assert.equal(hostReadsEnginesDsh(runtime), true, runtime)
  }
  for (const runtime of [undefined, '', 'latest']) {
    assert.equal(hostReadsEnginesDsh(runtime), false, String(runtime))
  }
})

test('readEnginesDsh 照抄上游的读法:自有属性、engines 必须是普通对象', () => {
  assert.deepEqual(readEnginesDsh({}), { state: 'absent' })
  assert.deepEqual(readEnginesDsh({ engines: { node: '>=22' } }), { state: 'absent' })
  assert.deepEqual(readEnginesDsh({ engines: { dsh: '^0.2.0' } }), { state: 'declared', range: '^0.2.0' })
  assert.deepEqual(readEnginesDsh({ engines: { dsh: '' } }), { state: 'declared', range: '' })
  // 上游 objectOf 明确拒绝 null 与数组,两者都会抛。
  for (const engines of [null, [], 'node', 5]) {
    assert.deepEqual(readEnginesDsh({ engines }), { state: 'malformed-engines' }, JSON.stringify(engines))
  }
  for (const dsh of [5, null, {}, ['^0.2.0']]) {
    assert.deepEqual(readEnginesDsh({ engines: { dsh } }), { state: 'malformed-range' }, JSON.stringify(dsh))
  }
  // 继承来的字段上游不看(Object.hasOwn),我们也不看。
  assert.deepEqual(readEnginesDsh(Object.create({ engines: { dsh: '^0.2.0' } })), { state: 'absent' })
})

test('M17:engines.dsh 不含运行时,在 0.2.1 上是 error,在 0.2.0 上只是 warning', () => {
  const stale = { engines: { dsh: '^0.1.0' } }
  const blocked = checkEnginesDsh(stale, '0.2.1-rc.2')
  assert.deepEqual(of(blocked, 'error').map(finding => finding.rule), ['M17-engines-dsh'])
  // 措辞要让人能直接动手:后果在哪看、怎么修。
  assert.match(of(blocked, 'error')[0].message, /停用/u)
  assert.match(of(blocked, 'error')[0].message, /标准错误输出/u)
  assert.match(of(blocked, 'error')[0].message, /allow-version/u)
  // 0.2.0 的宿主不读这个字段,判死就是假阳性;但一定要提示,因为用户升级即生效。
  const ignored = checkEnginesDsh(stale, '0.2.0-rc.2')
  assert.deepEqual(of(ignored, 'error'), [])
  assert.equal(of(ignored, 'warning').length, 2)
  assert.ok(of(ignored, 'warning').some(finding => finding.message.includes(ENGINES_GATE_SINCE)))
})

test('M17:workspace: 的等价只对 peer 成立,写进 engines.dsh 一律算不满足', () => {
  for (const range of ['workspace:^', 'workspace:~', 'workspace:*']) {
    const findings = checkEnginesDsh({ engines: { dsh: range } }, '0.2.1-rc.2')
    assert.deepEqual(of(findings, 'error').map(finding => finding.rule), ['M17-engines-dsh'], range)
    // 这条最容易写错:作者以为 peer 那套等价照样管用。
    assert.match(of(findings, 'error')[0].message, /peer/u, range)
  }
})

test('M17:空范围与形状错误都是"装了打不开"', () => {
  const empty = checkEnginesDsh({ engines: { dsh: '' } }, '0.2.1-rc.2')
  assert.deepEqual(of(empty, 'error').map(finding => finding.rule), ['M17-engines-dsh'])
  assert.match(of(empty, 'error')[0].message, /空字符串/u)
  // 形状不对时上游直接抛,preflight 把抛错也当拒绝 —— 后果一样是整行停用。
  for (const manifest of [{ engines: 'node' }, { engines: { dsh: 5 } }]) {
    const findings = checkEnginesDsh(manifest, '0.2.1-rc.2')
    assert.deepEqual(of(findings, 'error').map(finding => finding.rule), ['M17-engines-dsh'], JSON.stringify(manifest))
    assert.match(of(findings, 'error')[0].message, /cannot be validated/u)
  }
})

test('M17:覆盖了运行时也要提示"两条产品线判定相反"', () => {
  const findings = checkEnginesDsh({ engines: { dsh: '>=0.1.0 <0.3.0-0' } }, '0.2.1-rc.2')
  assert.deepEqual(of(findings, 'error'), [])
  assert.deepEqual(levels(findings), ['warning:M17-engines-dsh'])
  assert.match(findings[0].message, /只按它判/u)
  assert.match(findings[0].message, /0\.2\.0 及以下/u)
})

test('M17:没声明 engines.dsh 就什么都不报(绝大多数插件的形状)', () => {
  for (const runtime of PRODUCT_RUNTIMES) {
    assert.deepEqual(checkEnginesDsh({}, runtime), [], runtime)
    assert.deepEqual(checkEnginesDsh({ engines: { node: '>=22.0.0' } }, runtime), [], runtime)
  }
})

test('M7:engines.dsh 一出现,0.2.1 上的 peer 判定就得降级,0.2.0 上照旧判死', () => {
  const shape = {
    engines: { dsh: '>=0.1.0 <0.3.0-0' },
    peerDependencies: { '@deepseek-ai/dsh-tools': '0.1.0-rc.8' },
  }
  assert.equal(peersDecideCompatibility(shape, '0.2.1-rc.2'), false)
  assert.equal(peersDecideCompatibility(shape, '0.2.0-rc.2'), true)
  // 0.2.1:宿主不看 peer,判 error 是假阳性;但不能闷掉 0.6 上的后果。
  const relaxed = checkPeerRanges(shape, '0.2.1-rc.2')
  assert.deepEqual(of(relaxed, 'error'), [])
  assert.deepEqual(levels(relaxed), ['warning:M7-peer-range'])
  assert.match(relaxed[0].message, /engines\.dsh/u)
  assert.match(relaxed[0].message, /0\.2\.0 及以下/u)
  // 0.2.0:peer 仍是唯一裁判,一个字不变。
  assert.deepEqual(of(checkPeerRanges(shape, '0.2.0-rc.2'), 'error').map(finding => finding.rule), ['M7-peer-range'])
})

test('M7:engines.dsh 形状不对时宿主在读 peer 之前就拒掉整行,peer 不再是裁判', () => {
  for (const engines of ['node', { dsh: 5 }]) {
    const shape = { engines, peerDependencies: { '@deepseek-ai/dsh-tools': '0.1.0-rc.8' } }
    assert.equal(peersDecideCompatibility(shape, '0.2.1-rc.2'), false, JSON.stringify(engines))
    assert.deepEqual(of(checkPeerRanges(shape, '0.2.1-rc.2'), 'error'), [], JSON.stringify(engines))
  }
})

test('M7:engines 里只有 node 时 peer 仍是唯一裁判(最常见的清单形状)', () => {
  const shape = {
    engines: { node: '>=22.0.0' },
    peerDependencies: { '@deepseek-ai/dsh-tools': '0.1.0-rc.8' },
  }
  assert.equal(peersDecideCompatibility(shape, '0.2.1-rc.2'), true)
  assert.deepEqual(of(checkPeerRanges(shape, '0.2.1-rc.2'), 'error').map(finding => finding.rule), ['M7-peer-range'])
})

test('M7:被 engines.dsh 顶掉时,空范围与 workspace: 也要留下 0.6 的提示', () => {
  for (const range of ['', 'workspace:*']) {
    const shape = {
      engines: { dsh: '>=0.1.0 <0.3.0-0' },
      peerDependencies: { '@deepseek-ai/dsh-tools': range },
    }
    const findings = checkPeerRanges(shape, '0.2.1-rc.2')
    assert.deepEqual(of(findings, 'error'), [], range)
    // 关键:不能因为这个运行时不拦就一条都不报 —— 0.6 上它照样被停用。
    assert.equal(findings.length, 1, range)
    assert.equal(findings[0].level, 'warning', range)
  }
})

test('M17 落在共用实现里,两条执行路径自动都有', () => {
  const shape = { name: '@demo/plugin', version: '1.0.0', engines: { dsh: '^0.1.0' } }
  assert.ok(checkVersionRules(shape, '0.2.1-rc.2').some(finding => finding.rule === 'M17-engines-dsh'))
})

test('回归闸门:本包自己的清单在三条产品线的运行时上都零 error', () => {
  // 本包不声明 engines.dsh(声明了就会在 0.6 上被忽略、在 0.7 上成为唯一裁判),
  // 所以三条线都靠 peer 判定。
  assert.deepEqual(readEnginesDsh(manifest), { state: 'absent' })
  for (const runtime of PRODUCT_RUNTIMES) {
    assert.deepEqual(of(checkVersionRules(manifest, runtime), 'error'), [], `${runtime} 上有 error`)
  }
})
