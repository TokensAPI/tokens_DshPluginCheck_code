/* ============================================================
 * HOST-01…11 真实宿主契约:插件用到的每个宿主接口各真调一次
 * ============================================================
 * 口径(agent-hub T0047 A/A′/A″):
 *  - 只断言**本插件真正依赖的东西**。它注册一个会话内工具,就这一件事:
 *    `@deepseek-ai/dsh-tools` 的 `defineTool`、`ctx.tools` 服务的
 *    register / schemas / executionMode / execute、`inject: ['tools']`、
 *    自己 `cordis.patch.yml` 那一行、以及 `createRequire` 能从插件自己的
 *    位置解析到宿主的运行时包。它**不**订阅会话事件、**不**发网关调用、
 *    **不**注册 slot,所以这里没有那几类断言 —— 宿主的事件词表大小、
 *    endpoint 全清单之类一律不碰,宿主新增什么都算兼容。
 *  - 形状校验交给宿主自己:返回值由宿主按我们声明的 `output.schema` 校验、
 *    内容由宿主调 `output.render` 产出、兼容判定由宿主自己的
 *    `evaluatePluginCompatibility` 下,不手写期望对象。
 *  - 没有宿主时每条显式 NOT EXECUTED,不伪造通过(`npm run check:host`
 *    此时退出码非 0)。
 *
 * 跑法:`npm run check:host`(只认 `DSH_HOST_ROOT` = staged 宿主的
 * `dsh-plugin-desktop` 目录;多个宿主用 `DSH_HOST_ROOTS`,";" 分隔)。
 * 有效性复核:`npm run check:host -- --mutate <名字>`,见 tests/support/mutations.mjs。
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { HOST_NODE_ENGINES } from '../lib/contract.mjs'
import { hostBlocksPeerMismatch } from '../lib/semver-rules.mjs'
import {
  PACKAGE_NAME,
  REAL_DSH_HOME,
  SKIP_WITHOUT_HOST,
  forEachHost,
  inside,
  liveHostReports,
  liveValue,
} from './support/live-host.mjs'

const skip = SKIP_WITHOUT_HOST

/** 这份包真实声明的参数;宿主投影给模型的 schema 必须带着它们。 */
const DECLARED_PARAMETERS = ['path', 'package', 'version']

test('HOST-01 真实加载器解析到的是本次装进去的那份包,不是宿主自带的副本', { skip }, async () => {
  const reports = await liveHostReports()
  forEachHost(reports, (report) => {
    const resolved = liveValue(report, 'plugin.resolved')
    // 登录插件踩过:把宿主 node_modules 整体链到 profile 前面,加载器解析到
    // 宿主钉住的旧副本,用例全绿却测的不是待测代码。所以这是第一条断言。
    assert.ok(inside(resolved.manifestPath, report.home) || inside(resolved.manifestPath, report.realHome),
      `解析到的 ${PACKAGE_NAME} 在 ${resolved.manifestPath},不在本次的临时 $DSH_HOME 里`)
    assert.ok(!inside(resolved.manifestPath, report.root),
      `解析到的是宿主自己树里的那份:${resolved.manifestPath}`)
    // 反过来,插件用到的运行时包必须解析到**宿主的**那一份:运行时包用
    // module-local Symbol,多一份物理副本就对不上宿主的服务注册。
    assert.equal(resolved.toolsResolvedFromPlugin, resolved.toolsResolvedFromHost,
      '插件解析到的 @deepseek-ai/dsh-tools 不是宿主那一份')
  })
})

test('HOST-02 真实加载器挂起插件,宿主的 ctx.tools 收下了它注册的工具', { skip }, async () => {
  const reports = await liveHostReports()
  forEachHost(reports, (report) => {
    const registered = liveValue(report, 'tools.registered')
    assert.equal(registered.name, 'plugin_check')
    assert.equal(registered.hasExecute, true, '宿主拿到的定义没有 execute')
    assert.equal(registered.hasRender, true, '宿主拿到的定义没有 output.render')
    // 宿主把我们声明的 `{ type: 'json' }` 规范化成它自己的内部形状,所以
    // 只断言"输出契约被收下了";它到底被规范化成什么,HOST-04 用一次真实
    // 调用来验 —— 宿主拿这份 schema 校验返回值,不通过会直接判 isError。
    assert.equal(registered.hasOutputSchema, true, '宿主拿到的定义没有 output.schema')
  })
})

test('HOST-03 宿主投影给模型的 schema 带着插件声明的参数', { skip }, async () => {
  const reports = await liveHostReports()
  forEachHost(reports, (report) => {
    const schema = liveValue(report, 'tools.schema')
    assert.equal(schema.describesPurpose, true, '宿主投影后丢了 description')
    // 只要求**声明的参数都在**;宿主往投影里加字段一律算兼容。
    for (const parameter of DECLARED_PARAMETERS) {
      assert.ok(schema.parameters.includes(parameter),
        `宿主投影的参数里没有 ${parameter}(拿到的是 ${schema.parameters.join('、')})`)
    }
  })
})

test('HOST-04 宿主的执行管线真跑一次 plugin_check(path=…),并按 output.schema 收下返回值', { skip }, async () => {
  const reports = await liveHostReports()
  forEachHost(reports, (report) => {
    const run = liveValue(report, 'tools.execute.path')
    assert.equal(run.isError, false, `宿主把这次调用判成了失败:${JSON.stringify(run.error)}`)
    // 被测目标就是它自己装进来的那份目录,所以这一步同时验了"发布出去的
    // 文件集在真实宿主里跑得动"。
    assert.equal(run.value.package, PACKAGE_NAME)
    assert.equal(run.value.path, run.target)
    assert.ok(Array.isArray(run.value.findings), 'findings 不是数组')
    assert.equal(run.value.ok, true,
      `本包自己在真实宿主上没通过体检:${JSON.stringify(
        run.value.findings.filter(finding => finding.level === 'error'), null, 2)}`)
  })
})

test('HOST-05 宿主按 output.render 产出模型可见内容', { skip }, async () => {
  const reports = await liveHostReports()
  forEachHost(reports, (report) => {
    const run = liveValue(report, 'tools.execute.path')
    const text = run.content.filter(block => block.type === 'text').map(block => block.text).join('')
    assert.ok(text.length > 0, `宿主拿到的内容里没有文本块:${JSON.stringify(run.content)}`)
    // render 的约定是"把结论原样交给模型";解得开、并且带着结论字段即可,
    // 不逐字比对整份 JSON。
    const rendered = JSON.parse(text)
    assert.equal(rendered.ok, run.value.ok)
    assert.equal(rendered.package, PACKAGE_NAME)
  })
})

test('HOST-06 参数互斥的错误被宿主收成 isError 结果,而不是炸穿管线', { skip }, async () => {
  const reports = await liveHostReports()
  forEachHost(reports, (report) => {
    const run = liveValue(report, 'tools.execute.invalid')
    assert.equal(run.isError, true, '既不给 path 也不给 package,宿主居然判成成功')
    // 只断言"有个失败结果"是空转:工具压根没注册时宿主同样回一个失败结果
    // (UNKNOWN_TOOL),这条用例照样绿。所以要认出这是**我们自己**抛的那条。
    assert.notEqual(run.error?.code, 'UNKNOWN_TOOL',
      '这个失败是"宿主不认识这个工具",不是工具自己的参数校验 —— 插件没注册上')
    assert.match(run.error?.message ?? '', /path/u)
    assert.match(run.error?.message ?? '', /package/u)
  })
})

test('HOST-07 isConcurrencySafe 在宿主的调度里就是 parallel', { skip }, async () => {
  const reports = await liveHostReports()
  forEachHost(reports, (report) => {
    // 本插件声明自己可并行;宿主对未声明/声明不合法的一律 fail-closed 成
    // exclusive,所以这条红了就是声明没被宿主认下来。
    assert.equal(liveValue(report, 'tools.executionMode').kind, 'parallel')
  })
})

test('HOST-08 detectHostRuntime 在真实宿主里读出的是宿主自己的版本', { skip }, async () => {
  const reports = await liveHostReports()
  forEachHost(reports, (report) => {
    const run = liveValue(report, 'tools.execute.path')
    // 探测一旦失真,体检会拿错版本去判 M6/M7/M17 的全部结论 —— 0.4.5 就是
    // 这么在 0.2.1 上两头判错的。这里拿的是工具真实用过的那个版本。
    assert.equal(run.value.runtime, report.version,
      '工具用的运行时版本不是宿主自己的版本(探测失真,或退回了兜底常量)')
  })
})

test('HOST-09 宿主自己的兼容判定放行本包的真实清单,反向对照必被拦', { skip }, async () => {
  const reports = await liveHostReports()
  forEachHost(reports, (report) => {
    const compat = liveValue(report, 'host.compatibility')
    if (!compat.declared) {
      // 0.1 线的 app-boot 根本没有这道闸 —— 如实报 NOT DECLARED,并钉住
      // 本工具对这件事的判断没有漂。
      assert.match(compat.reason, /NOT DECLARED/u, compat.reason)
      assert.equal(hostBlocksPeerMismatch(report.version), false,
        '宿主没有这道闸,本工具却认为这个运行时会硬拦')
      return
    }
    assert.equal(hostBlocksPeerMismatch(report.version), true,
      '宿主有这道闸,本工具却认为这个运行时不硬拦')
    assert.equal(compat.allowed, true,
      `宿主会把本包停用:${JSON.stringify(compat.verdict, null, 2)}`)
    // 上面那个"放行"可能只是评估器空转,所以同一份清单加一条谁都满足不了
    // 的假 peer 做反向对照:必须报出来,且字段名两代都认。
    assert.equal(compat.sentinelBlocked, true, '假 peer 都放行了,这个评估器在空转')
    assert.deepEqual(compat.sentinelUnmet, ['@deepseek-ai/dsh-nonexistent'])
    assert.ok(['requirements', 'peers'].includes(compat.unmetField),
      `未满足项的字段名是 ${compat.unmetField},两个已知名字都不是`)
  })
})

test('HOST-10 M8 对照的宿主 engines.node 与宿主真实声明一致', { skip }, async () => {
  const reports = await liveHostReports()
  forEachHost(reports, (report) => {
    const engines = liveValue(report, 'host.engines')
    // M8 拿 HOST_NODE_ENGINES 判"插件的 engines.node 与宿主有没有交集",
    // 这个常量是照抄来的,抄件会漂。拿来对照的是**装进去那份副本**里的值,
    // 也就是用户真正拿到的那个。只对当前产品线的宿主断言相等:旧宿主的
    // engines.node 本来就可能不同,那不是漂。
    assert.equal(engines.toolNodeEngines, HOST_NODE_ENGINES,
      '装进去那份副本里的 HOST_NODE_ENGINES 与工作区不一致')
    if (!hostBlocksPeerMismatch(report.version)) return
    assert.equal(engines.node, engines.toolNodeEngines,
      `宿主声明的 engines.node 是 "${engines.node}",本工具照抄的是 "${engines.toolNodeEngines}"`)
  })
})

test('HOST-11 夹具只碰临时目录,一个字节都不碰用户真实的 ~/.dsh', { skip }, async () => {
  const reports = await liveHostReports()
  forEachHost(reports, (report) => {
    const paths = liveValue(report, 'fixture.paths')
    // 联网搜索那次把用户真实的 settings.yaml 改成了测试值,根因是没人断言
    // 路径。这条守卫不看插件做了什么,只看宿主在哪里落地。
    for (const label of ['home', 'realHome', 'profileDir', 'cwd', 'profilesDir', 'installed']) {
      const value = paths[label]
      assert.equal(typeof value, 'string', `探针没报出 ${label}:${paths[`${label}:unreadable`] ?? '缺失'}`)
      assert.ok(inside(value, report.home) || inside(value, report.realHome),
        `${label} 落在临时 $DSH_HOME 之外:${value}`)
      assert.ok(!inside(value, REAL_DSH_HOME),
        `${label} 落进了用户真实的 DSH 家目录:${value}`)
    }
    // 路径断言只能证明"我们以为写在临时目录";这一条证明用户的目录确实
    // 没被动过 —— 启动前后顶层条目的大小与 mtime 必须完全相同。
    assert.deepEqual(report.realHomeAfter, report.realHomeBefore,
      `这次启动动了用户真实的 ${REAL_DSH_HOME}`)
  })
})
