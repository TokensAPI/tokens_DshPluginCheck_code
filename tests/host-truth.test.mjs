/* ============================================================
 * HOST-12…15 拿宿主自己验自己(判定对拍,不启动宿主)
 * ============================================================
 * 本工具的 M6/M7/M17 是把上游 app-boot 的判定**照抄一份**下来的 —— 照抄的
 * 东西会漂,而且漂了没人知道:0.4.5 就是这么在 DSH 0.2.1 上两头判错的
 * (engines.dsh 成了唯一裁判,我们还只认 peer)。纯逻辑用例只能证明"我们
 * 自己前后一致",证明不了"跟宿主一致"。
 *
 * 所以这一组直接从真实 staged 宿主里 import 上游的
 * `evaluatePluginCompatibility`,拿同一批清单跟我们的判定对拍:宿主拦 ⇔
 * 我们报 error。上游下次再改判定口径,这里会红,而不是等用户装完打不开
 * 才发现。
 *
 * 与 HOST-01…11(tests/host-contract.test.mjs)的分工:那组要起一个真实
 * 宿主、把插件装进去真调;这组只需要宿主的模块,所以在本进程里 import,
 * 便宜得多。两组同属 `npm run check:host`,共用同一个 `DSH_HOST_ROOT`。
 *
 * 本插件**不订阅任何会话事件**(它只注册一个会话内工具),所以这里没有
 * "事件名交集"那条路子 —— 按 T0047 A″ 的口径,只断言它真正依赖的东西。
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

import { detectHostRuntime } from '../lib/cowork-plugin.mjs'
import { checkEnginesDsh, checkPeerRanges, hostBlocksPeerMismatch } from '../lib/semver-rules.mjs'
import { SKIP_WITHOUT_HOST, forEachHost, hostRequire, hostRoots, hostRuntimeVersion } from './support/live-host.mjs'

const skip = SKIP_WITHOUT_HOST

/** 每个配置的宿主一份句柄;没有宿主时整组按 NOT EXECUTED 跳过。 */
const hosts = skip === false
  ? hostRoots().map(root => ({ root, version: hostRuntimeVersion(root), require: hostRequire(root) }))
  : []

const load = (host, spec) => import(pathToFileURL(host.require.resolve(spec)).href)

/** 宿主口径:undefined = 放行,否则这一行会被 preflight 停用。 */
function hostBlocks(evaluate, manifest, runtime) {
  try {
    return evaluate(manifest, {}, runtime) !== undefined
  } catch {
    // 形状不对时上游抛错,compatibility-preflight 的 denial() 把抛错也当拒绝。
    return true
  }
}

/** 本工具口径:M17 + M7 里有没有 error。 */
function toolBlocks(manifest, runtime) {
  return [...checkEnginesDsh(manifest, runtime), ...checkPeerRanges(manifest, runtime)]
    .some(finding => finding.level === 'error')
}

/** 每一项都是真实插件写得出来的清单形状。 */
const CASES = [
  ['peer 覆盖到下一个大版本', { peerDependencies: { '@deepseek-ai/dsh-tools': '>=0.1.0-rc.8 <1.0.0-0' } }],
  ['peer 窄上界(放宽前的旧口径)', { peerDependencies: { '@deepseek-ai/dsh-tools': '>=0.1.0-rc.8 <0.3.0-0' } }],
  ['peer 只到 0.1(本包 0.4.4 踩的坑)', { peerDependencies: { '@deepseek-ai/dsh-tools': '0.1.0-rc.8 || 0.1.3-alpha.1' } }],
  ['peer 空范围', { peerDependencies: { '@deepseek-ai/dsh-tools': '' } }],
  ['peer 非法范围', { peerDependencies: { '@deepseek-ai/dsh-tools': 'not-a-range' } }],
  ['peer workspace:*', { peerDependencies: { '@deepseek-ai/dsh-tools': 'workspace:*' } }],
  ['只有 cordis peer(宿主不比对它)', { peerDependencies: { '@deepseek-ai/cordis': '4.0.4' } }],
  ['engines 只有 node,peer 过时', {
    engines: { node: '>=22.0.0' },
    peerDependencies: { '@deepseek-ai/dsh-tools': '0.1.0-rc.8' },
  }],
  ['engines.dsh 覆盖 + peer 过时', {
    engines: { dsh: '>=0.1.0 <1.0.0-0' },
    peerDependencies: { '@deepseek-ai/dsh-tools': '0.1.0-rc.8' },
  }],
  ['engines.dsh 不覆盖 + peer 覆盖', {
    engines: { dsh: '^0.1.0' },
    peerDependencies: { '@deepseek-ai/dsh-tools': '>=0.1.0-rc.8 <1.0.0-0' },
  }],
  ['engines.dsh workspace:*', { engines: { dsh: 'workspace:*' } }],
  ['engines.dsh 空字符串', { engines: { dsh: '' } }],
  ['engines.dsh 不是字符串', { engines: { dsh: 5 } }],
  ['engines 不是对象', { engines: 'node' }],
  ['dsh.engine(本工具自家约定,上游不读)', { dsh: { engine: '^0.1.0' } }],
  ['什么都不声明', {}],
]

test('HOST-12 0.1 的宿主里根本没有这道闸(PEER_GATE_SINCE 的前提)', { skip }, async () => {
  for (const host of hosts) {
    const boot = await load(host, '@deepseek-ai/dsh-app-boot')
    const declared = typeof boot.evaluatePluginCompatibility === 'function'
    // M7 的整套判级建立在"0.1 的 app-boot 没有 evaluatePluginCompatibility"
    // 之上。这个前提以前只是一次性实测写在注释里,现在每次跑都确认一遍:
    // 有这个函数 ⇔ 我们认为这个运行时会硬拦。
    assert.equal(declared, hostBlocksPeerMismatch(host.version),
      `DSH ${host.version}(${host.root})上宿主有没有这道闸,与 hostBlocksPeerMismatch 的判断不一致`)
    if (!declared) {
      // 这一行是写给人看的:0.1 线上"没有判定"不是用例跳过,是宿主的事实。
      console.log(`  NOT DECLARED: DSH ${host.version} 的 app-boot 没有 evaluatePluginCompatibility`)
    }
  }
})

test('HOST-13 宿主判定与本工具 M6/M7/M17 判级逐条对拍', { skip }, async () => {
  for (const host of hosts) {
    const boot = await load(host, '@deepseek-ai/dsh-app-boot')
    if (typeof boot.evaluatePluginCompatibility !== 'function') {
      // 0.1 的宿主没有这道闸,没有"宿主判定"可对拍 —— HOST-12 已经把这件事
      // 钉住了,这里如实记一句,不伪造通过。
      console.log(`  NOT DECLARED: DSH ${host.version} 无 evaluatePluginCompatibility,本宿主无可对拍`)
      continue
    }
    const mismatched = []
    for (const [label, shape] of CASES) {
      const manifest = { name: '@demo/plugin', version: '1.0.0', ...shape }
      const hostVerdict = hostBlocks(boot.evaluatePluginCompatibility, manifest, host.version)
      const toolVerdict = toolBlocks(manifest, host.version)
      if (hostVerdict !== toolVerdict) {
        mismatched.push(`${label}: 宿主${hostVerdict ? '拦' : '放行'} / 本工具${toolVerdict ? '判 error' : '放行'}`)
      }
    }
    assert.deepEqual(mismatched, [], `在 DSH ${host.version}(${host.root})上判定不一致`)
  }
})

test('HOST-14 未满足项的字段名两个都认(0.2.0 叫 peers,0.2.1 改名 requirements)', { skip }, async () => {
  for (const host of hosts) {
    const boot = await load(host, '@deepseek-ai/dsh-app-boot')
    if (typeof boot.evaluatePluginCompatibility !== 'function') {
      console.log(`  NOT DECLARED: DSH ${host.version} 无 evaluatePluginCompatibility`)
      continue
    }
    const blocked = boot.evaluatePluginCompatibility(
      { name: '@demo/plugin', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh-tools': '0.1.0-rc.8' } },
      {},
      host.version,
    )
    assert.notEqual(blocked, undefined, '这份清单必须被拦,否则下面的字段断言没有意义')
    // 只读一个名字的脚本会把"被拦"读成"干净通过",所以这里钉住:至少有一个在。
    const unmet = blocked.requirements ?? blocked.peers
    assert.equal(typeof unmet, 'object', '两个字段名都没有 —— 读判定结果的代码要跟着改')
    assert.deepEqual(Object.keys(unmet), ['@deepseek-ai/dsh-tools'])
  }
})

test('HOST-15 插件入口的值导入在宿主里都还在,且探测读出的是宿主自己的版本', { skip }, async () => {
  for (const host of hosts) {
    // 本插件只对宿主做一次值导入:dsh-tools 的 defineTool。没了它插件一加载
    // 就失败,而 peer 门禁与 tsc 都看不见(宿主包在运行时才解析)。
    const tools = await load(host, '@deepseek-ai/dsh-tools')
    assert.equal(typeof tools.defineTool, 'function',
      `DSH ${host.version} 的 dsh-tools 不再导出 defineTool —— 插件一加载就失败`)
    // 兜底常量只在探测失败时用;探测一旦失败,体检会拿错版本去判所有规则。
    assert.equal(detectHostRuntime(host.require), host.version)
  }
})

test('HOST-16 配置了宿主才算执行过(没有宿主时本组报 NOT EXECUTED)', () => {
  if (skip !== false) {
    console.log(`  ${skip}`)
    // 这一条**不**断言有宿主:`npm test` 在 CI 上没有宿主也不该变红。
    // 退出码非 0 由 `npm run check:host` 负责,见 scripts/check-host.mjs。
    return
  }
  assert.ok(hosts.length > 0)
  for (const host of hosts) console.log(`  EXECUTED on DSH ${host.version} (${host.root})`)
})
