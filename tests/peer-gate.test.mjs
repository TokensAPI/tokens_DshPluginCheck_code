/* ============================================================
 * M7 的硬拦判级(DSH 0.2 起)
 * ============================================================
 * 本包 0.4.4 自己踩过这个坑:peer 只写到 DSH 0.1,装进 TokensCowork 0.6
 * (DSH 0.2.0-rc.2)后被宿主在启动时停用,而当时的 M7 只报一条 warning,
 * CLI 退出码仍是 0。所以这一组用例盯两件事:
 *  1. 会被宿主拦的情况必须判 error,0.1 上的同一条仍是 warning;
 *  2. **本包自己的清单**在三条产品线的运行时上都过得去(回归闸门)。
 * 锚点见 lib/contract.mjs 的「DSH 0.2 的 peer 硬拦」。
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import semver from 'semver'
import { PEER_GATE_SINCE, isGatedPeer, isRuntimeVersioned } from '../lib/contract.mjs'
import { checkEngine, checkPeerRanges, coversNextMajor, hostBlocksPeerMismatch } from '../lib/semver-rules.mjs'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const of = (findings, level) => findings.filter(finding => finding.level === level)

/** 三条产品线实际装的 DSH 运行时:0.5.x、0.6.x、0.7.0。 */
const PRODUCT_RUNTIMES = ['0.1.5-rc.2', '0.2.0-rc.2', '0.2.1-rc.2']

test('硬拦从 0.2 的预发布版就开始,0.1 的运行时没有这道闸', () => {
  for (const runtime of ['0.1.0-rc.8', '0.1.3-alpha.1', '0.1.5-rc.2', '0.1.9']) {
    assert.equal(hostBlocksPeerMismatch(runtime), false, runtime)
  }
  for (const runtime of ['0.2.0-rc.1', '0.2.0-rc.2', '0.2.0', '0.3.0']) {
    assert.equal(hostBlocksPeerMismatch(runtime), true, runtime)
  }
  // 没给运行时、或给了个不是版本号的东西,都不能凭空判死。
  for (const runtime of [undefined, '', 'latest']) assert.equal(hostBlocksPeerMismatch(runtime), false, String(runtime))
  assert.equal(semver.valid(PEER_GATE_SINCE) !== null, true)
})

test('M7:peer 不含目标运行时,在 0.2 上是 error,在 0.1 上还是 warning', () => {
  const stale = { peerDependencies: { '@deepseek-ai/dsh-tools': '0.1.0-rc.8 || 0.1.3-alpha.1' } }
  const blocked = checkPeerRanges(stale, '0.2.0-rc.2')
  assert.deepEqual(of(blocked, 'error').map(finding => finding.rule), ['M7-peer-range'])
  // 措辞要让人能直接动手:说清后果在哪看、怎么修。
  assert.match(of(blocked, 'error')[0].message, /停用/u)
  assert.match(of(blocked, 'error')[0].message, /标准错误输出/u)
  assert.match(of(blocked, 'error')[0].message, /allow-version/u)
  // 0.4.4 的 peer 连 0.5.x 实际装的 0.1.5-rc.2 都没写进去,只是 0.1 没有闸、
  // 不匹配也照样加载,所以一直没人发现。
  const legacy = checkPeerRanges(stale, '0.1.5-rc.2')
  assert.deepEqual(of(legacy, 'error'), [])
  assert.deepEqual(of(legacy, 'warning').map(finding => finding.rule), ['M7-peer-range'])
})

test('M7:cordis 不参与硬拦,范围不含运行时也不升级判级', () => {
  // 宿主只看 @deepseek-ai/dsh 与 @deepseek-ai/dsh-*,cordis 自成 4.x 版本线。
  assert.deepEqual(checkPeerRanges({ peerDependencies: { '@deepseek-ai/cordis': '4.0.1 || 4.0.4' } }, '0.2.0-rc.2'), [])
})

test('硬拦的名字判定照抄宿主,比 isRuntimeVersioned 的前缀判断更窄', () => {
  for (const name of ['@deepseek-ai/dsh', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-agent']) {
    assert.equal(isGatedPeer(name), true, name)
  }
  // 前缀判断会把这个也算进来,宿主不看它 —— 不能拿它判死。
  assert.equal(isRuntimeVersioned('@deepseek-ai/dshfoo'), true)
  assert.equal(isGatedPeer('@deepseek-ai/dshfoo'), false)
  assert.equal(isGatedPeer('@deepseek-ai/cordis'), false)
  const findings = checkPeerRanges({ peerDependencies: { '@deepseek-ai/dshfoo': '0.1.0' } }, '0.2.0-rc.2')
  assert.deepEqual(of(findings, 'error'), [])
  assert.deepEqual(of(findings, 'warning').map(finding => finding.rule), ['M7-peer-range'])
})

test('M7:workspace: 三种写法宿主当作当前运行时,不判死但要提示', () => {
  for (const range of ['workspace:^', 'workspace:~', 'workspace:*']) {
    const findings = checkPeerRanges({ peerDependencies: { '@deepseek-ai/dsh-tools': range } }, '0.2.0-rc.2')
    assert.deepEqual(of(findings, 'error'), [], range)
    assert.equal(of(findings, 'warning').length, 1, range)
    assert.match(of(findings, 'warning')[0].message, /monorepo/u)
  }
  // cordis 不走这条等价:它真的要被装出来,workspace: 就是装不出来。
  const cordis = checkPeerRanges({ peerDependencies: { '@deepseek-ai/cordis': 'workspace:*' } }, '0.2.0-rc.2')
  assert.deepEqual(of(cordis, 'error').map(finding => finding.rule), ['M7-peer-range'])
})

test('M7:空范围 semver 当作"全都满足",宿主直接判不兼容', () => {
  const findings = checkPeerRanges({ peerDependencies: { '@deepseek-ai/dsh-tools': '' } }, '0.2.0-rc.2')
  assert.deepEqual(of(findings, 'error').map(finding => finding.rule), ['M7-peer-range'])
  assert.match(of(findings, 'error')[0].message, /空范围|空字符串/u)
  // 0.1 上没有这道闸,维持原来的"只判范围合法性"口径,不要凭空多报。
  assert.deepEqual(checkPeerRanges({ peerDependencies: { '@deepseek-ai/dsh-tools': '' } }, '0.1.3-alpha.1'), [])
})

test('回归闸门:本包自己的 peer 与 engine 覆盖三条产品线的运行时', () => {
  for (const runtime of PRODUCT_RUNTIMES) {
    assert.deepEqual(of(checkPeerRanges(manifest, runtime), 'error'), [], `peer 挡住了 ${runtime}`)
    assert.deepEqual(of(checkEngine(manifest, runtime), 'error'), [], `engine 挡住了 ${runtime}`)
  }
  // 直接按宿主的口径再确认一遍:带 includePrerelease 比对 @deepseek-ai/dsh* 的范围。
  const gated = Object.entries(manifest.peerDependencies).filter(([name]) => isGatedPeer(name))
  assert.ok(gated.length > 0, '清单里至少要声明一个宿主会比对的 peer')
  for (const [name, range] of gated) {
    for (const runtime of PRODUCT_RUNTIMES) {
      assert.equal(semver.satisfies(runtime, range, { includePrerelease: true }), true, `${name}@"${range}" 不含 ${runtime}`)
    }
    // 上界口径(用户 2026-10-22):只挡大版本。0.3 这类未核对过的小版本要
    // **放进来** —— 内核跨 0.x 小版本时,契约全绿的插件不该被迫重发一版;
    // "没核对过"由 C0-contract 的 warning 说,不靠 peer 上界堵。
    assert.equal(semver.satisfies('0.3.0-rc.1', range, { includePrerelease: true }), true,
      `${name}@"${range}" 的上界卡在 0.3 以下 —— 新口径是上界不低于下一个大版本`)
    // 真正要挡的是大版本:1.0 得挡住。
    assert.equal(semver.satisfies('1.0.0', range, { includePrerelease: true }), false,
      `${name}@"${range}" 把 1.0 也放进来了,上界等于没写`)
    assert.equal(coversNextMajor(range, '0.2.1-rc.2'), true, `${name}@"${range}" 覆盖不到下一个大版本`)
  }
})

test('M7:上界卡在 0.x 小版本上要提示放宽,覆盖到大版本则不提示', () => {
  // 旧口径(0.4.6 及以前自己就是这么写的):当下不拦,但下次内核升小版本
  // 就会把插件挡在加载前。
  const narrow = checkPeerRanges(
    { peerDependencies: { '@deepseek-ai/dsh-tools': '>=0.1.0-rc.8 <0.3.0-0' } },
    '0.2.1-rc.2',
  )
  assert.deepEqual(of(narrow, 'error'), [])
  assert.equal(of(narrow, 'warning').length, 1)
  assert.match(of(narrow, 'warning')[0].message, /上界低于下一个大版本/u)
  assert.match(of(narrow, 'warning')[0].message, /1\.0\.0-0/u)
  // 新口径与开区间都不该提示。
  for (const range of ['>=0.1.0-rc.8 <1.0.0-0', '>=0.1.0-rc.8', '>=0.1.0 <2.0.0-0']) {
    assert.deepEqual(checkPeerRanges({ peerDependencies: { '@deepseek-ai/dsh-tools': range } }, '0.2.1-rc.2'), [],
      range)
  }
  // cordis 不是宿主会比对的 peer,也不跟 DSH 同一条版本线 —— 不要拿这条规则
  // 去说它的上界。
  assert.deepEqual(
    checkPeerRanges({ peerDependencies: { '@deepseek-ai/cordis': '>=4.0.1 <4.1.0-0' } }, '0.2.1-rc.2'),
    [],
  )
  // 范围压根不含运行时的那条路径已经有自己的 error/warning,不叠这条提示。
  const outdated = checkPeerRanges(
    { peerDependencies: { '@deepseek-ai/dsh-tools': '0.1.0-rc.8' } },
    '0.2.1-rc.2',
  )
  assert.equal(outdated.filter(finding => /上界低于/u.test(finding.message)).length, 0)
})
