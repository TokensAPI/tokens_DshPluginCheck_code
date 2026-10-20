/* ============================================================
 * 拿宿主自己验自己
 * ============================================================
 * 本工具的 M6/M7/M17 是把上游 app-boot 的判定**照抄一份**下来的 —— 照抄的
 * 东西会漂,而且漂了没人知道:0.4.5 就是这么在 DSH 0.2.1 上两头判错的
 * (engines.dsh 成了唯一裁判,我们还只认 peer)。纯逻辑用例只能证明"我们
 * 自己前后一致",证明不了"跟宿主一致"。
 *
 * 所以这一组直接从真实 staged 宿主里 import 上游的
 * evaluatePluginCompatibility,拿同一批清单跟我们的判定对拍:
 * 宿主拦 ⇔ 我们报 error。上游下次再改判定口径,这里会红,而不是等用户
 * 装完打不开才发现。
 *
 * 用法(本机;CI 上没有宿主,整组自动跳过):
 *   DSH_TEST_RUNTIME=<...>/.build/desktop/dsh-plugin-desktop/package.json \
 *     node --test --test-concurrency=1 tests/host-truth.test.mjs
 * 这个环境变量的含义与 TokensCowork 的插件测试脚本一致。
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { detectHostRuntime } from '../lib/cowork-plugin.mjs'
import { checkEnginesDsh, checkPeerRanges, hostBlocksPeerMismatch } from '../lib/semver-rules.mjs'

const hostManifest = process.env.DSH_TEST_RUNTIME
const skip = hostManifest === undefined || hostManifest === ''
  ? '需要 DSH_TEST_RUNTIME 指向真实宿主的 dsh-plugin-desktop/package.json'
  : false

const hostRequire = skip === false ? createRequire(hostManifest) : undefined
const load = async (spec) => import(pathToFileURL(hostRequire.resolve(spec)))

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
  ['peer 覆盖全区间', { peerDependencies: { '@deepseek-ai/dsh-tools': '>=0.1.0-rc.8 <0.3.0-0' } }],
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
    engines: { dsh: '>=0.1.0 <0.3.0-0' },
    peerDependencies: { '@deepseek-ai/dsh-tools': '0.1.0-rc.8' },
  }],
  ['engines.dsh 不覆盖 + peer 覆盖', {
    engines: { dsh: '^0.1.0' },
    peerDependencies: { '@deepseek-ai/dsh-tools': '>=0.1.0-rc.8 <0.3.0-0' },
  }],
  ['engines.dsh workspace:*', { engines: { dsh: 'workspace:*' } }],
  ['engines.dsh 空字符串', { engines: { dsh: '' } }],
  ['engines.dsh 不是字符串', { engines: { dsh: 5 } }],
  ['engines 不是对象', { engines: 'node' }],
  ['dsh.engine(本工具自家约定,上游不读)', { dsh: { engine: '^0.1.0' } }],
  ['什么都不声明', {}],
]

test('0.1 的宿主里根本没有这道闸(PEER_GATE_SINCE 的前提)', { skip }, async () => {
  const boot = await load('@deepseek-ai/dsh-app-boot')
  const runtime = hostRequire('@deepseek-ai/dsh/package.json').version
  // M7 的整套判级建立在"0.1 的 app-boot 没有 evaluatePluginCompatibility"之上。
  // 这个前提以前只是一次性实测写在注释里,现在由真实宿主每次跑都确认一遍:
  // 有这个函数 ⇔ 我们认为这个运行时会硬拦。
  assert.equal(
    typeof boot.evaluatePluginCompatibility === 'function',
    hostBlocksPeerMismatch(runtime),
    `DSH ${runtime} 上宿主有没有这道闸,与 hostBlocksPeerMismatch 的判断不一致`,
  )
})

test('宿主判定与本工具判级逐条对拍', { skip }, async () => {
  const boot = await load('@deepseek-ai/dsh-app-boot')
  const runtime = hostRequire('@deepseek-ai/dsh/package.json').version
  if (typeof boot.evaluatePluginCompatibility !== 'function') {
    // 0.1 的宿主没有这道闸,没有"宿主判定"可对拍 —— 上一条用例已经把这件事钉住了。
    assert.equal(hostBlocksPeerMismatch(runtime), false)
    return
  }
  const mismatched = []
  for (const [label, shape] of CASES) {
    const manifest = { name: '@demo/plugin', version: '1.0.0', ...shape }
    const host = hostBlocks(boot.evaluatePluginCompatibility, manifest, runtime)
    const tool = toolBlocks(manifest, runtime)
    if (host !== tool) mismatched.push(`${label}: 宿主${host ? '拦' : '放行'} / 本工具${tool ? '判 error' : '放行'}`)
  }
  assert.deepEqual(mismatched, [], `在 DSH ${runtime} 上判定不一致`)
})

test('未满足项的字段名两个都认(0.2.0 叫 peers,0.2.1 改名 requirements)', { skip }, async () => {
  const boot = await load('@deepseek-ai/dsh-app-boot')
  const runtime = hostRequire('@deepseek-ai/dsh/package.json').version
  if (typeof boot.evaluatePluginCompatibility !== 'function') return
  const blocked = boot.evaluatePluginCompatibility(
    { name: '@demo/plugin', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh-tools': '0.1.0-rc.8' } },
    {},
    runtime,
  )
  assert.notEqual(blocked, undefined, '这份清单必须被拦,否则下面的字段断言没有意义')
  // 只读一个名字的脚本会把"被拦"读成"干净通过",所以这里钉住:至少有一个在。
  const unmet = blocked.requirements ?? blocked.peers
  assert.equal(typeof unmet, 'object', '两个字段名都没有 —— 读判定结果的代码要跟着改')
  assert.deepEqual(Object.keys(unmet), ['@deepseek-ai/dsh-tools'])
})

test('宿主契约:插件入口用到的导出都还在', { skip }, async () => {
  // 本插件只注册一个会话内工具,不订阅任何会话事件,所以事件名交集对它不适用;
  // 它真正依赖的是 dsh-tools 的 defineTool,以及 detectHostRuntime 的解析路径。
  const tools = await load('@deepseek-ai/dsh-tools')
  assert.equal(typeof tools.defineTool, 'function', 'dsh-tools 不再导出 defineTool —— 插件一加载就失败')
  const session = await load('@deepseek-ai/dsh-session')
  assert.ok(session.KNOWN_SESSION_EVENT_TYPES instanceof Set)
  assert.ok(session.KNOWN_SESSION_EVENT_TYPES.size > 0)
})

test('detectHostRuntime 在真实宿主上读出的就是宿主自己的版本', { skip }, () => {
  const expected = hostRequire('@deepseek-ai/dsh/package.json').version
  // 兜底常量只在探测失败时用;探测一旦失败,体检会拿错版本去判所有规则。
  assert.equal(detectHostRuntime(hostRequire), expected)
})
