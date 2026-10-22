/* ============================================================
 * 变异:把被测路径弄坏,看用例是不是真的会红
 * ============================================================
 * 一条契约用例最常见的失效方式不是判错,是**空转** —— 断言的那条路径压根
 * 没被执行,或者两边都回落到同一个默认值,被测代码整段删掉照样绿
 * (agent-hub T0047-A 在模型管理、更新插件上各踩过一次)。所以本仓库的
 * 真实宿主契约用例不只跑"原样装进去",还能跑"按名字弄坏某一处再装进去",
 * 并要求指定的那几条用例**必须红**。
 *
 * 做成常驻机制而不是一次性手工实验,是为了下次上游升级改完用例之后,
 * 有效性能一条命令复核:`npm run check:host -- --mutate <名字>`。
 *
 * 每个变异都是一次**精确的字符串替换**,并断言只命中一次 —— 替换不到就
 * 直接报错,免得代码改过之后变异静默失效、看起来像"用例确实红不了"。
 * ============================================================ */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 变异表:名字 → 改哪个文件、怎么改、以及应当因此变红的用例。
 *
 * `expectRed` 只是写给人看的说明与 `--mutate` 的判据,不参与装配。
 */
export const MUTATIONS = {
  'no-register': {
    description: '不把工具注册进宿主注册表(插件入口照样加载)',
    file: 'lib/cowork-plugin.mjs',
    find: 'ctx.tools.register(defineTool({',
    replace: 'const neverRegistered = (defineTool({',
    // HOST-08 也在内:它读的是那次真实调用的返回值,工具不在就没有返回值。
    expectRed: ['HOST-02', 'HOST-03', 'HOST-04', 'HOST-05', 'HOST-06', 'HOST-07', 'HOST-08'],
  },
  'empty-render': {
    description: 'output.render 返回空内容(宿主拿不到可展示的结果)',
    file: 'lib/cowork-plugin.mjs',
    find: "render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],",
    replace: 'render: () => [],',
    expectRed: ['HOST-05'],
  },
  'frozen-runtime': {
    description: '不再向宿主探测运行时版本,一律用兜底常量(0.4.5 判错的形状)',
    file: 'lib/cowork-plugin.mjs',
    find: ': detectHostRuntime() ?? FALLBACK_RUNTIME',
    replace: ': FALLBACK_RUNTIME',
    expectRed: ['HOST-08'],
    /**
     * 兜底常量恰好等于这个宿主的版本,所以在它上面"探测失真"和"探测正常"
     * 的结果一模一样 —— 这不是用例空转,正是**为什么**非得对每条产品线各跑
     * 一次:单看 0.6 这一条线,0.4.5 那类判错永远看不出来。
     */
    blindOn: ['0.2.0-rc.2'],
  },
  'stale-node-engines': {
    description: 'M8 照抄的宿主 engines.node 漂了(抄件过时的形状)',
    file: 'lib/contract.mjs',
    find: "export const HOST_NODE_ENGINES = '^22.19.0 || >=24.0.0'",
    replace: "export const HOST_NODE_ENGINES = '^20.0.0'",
    expectRed: ['HOST-10'],
  },
  'peer-0.1-only': {
    description: 'dsh peer 只写到 0.1(本包 0.4.4 在 0.6 上被停用的那条声明)',
    file: 'package.json',
    // 必须带上包名:`dsh.engine` 写的是同一个范围字符串,只搜范围会命中两次。
    find: '"@deepseek-ai/dsh-tools": ">=0.1.0-rc.8 <1.0.0-0"',
    replace: '"@deepseek-ai/dsh-tools": "0.1.0-rc.8"',
    expectRed: ['HOST-02', 'HOST-03', 'HOST-04', 'HOST-05', 'HOST-06', 'HOST-07', 'HOST-08', 'HOST-09'],
    /** 0.1 线没有这道闸,所以同一个变异在那里本该照常加载 —— 这是它不是误报的证明。 */
    gatedFrom: '0.2.0-rc.0',
  },
}

/**
 * 对装好的那份副本施加一个变异。
 * @param {string} installed - profile 里 `@tokensapi/dsh-plugin-check` 的目录。
 * @param {string} name - MUTATIONS 的键。
 */
export function mutate(installed, name) {
  const spec = MUTATIONS[name]
  if (spec === undefined) {
    throw new Error(`未知变异 ${name};可用:${Object.keys(MUTATIONS).join('、')}`)
  }
  const target = join(installed, spec.file)
  const before = readFileSync(target, 'utf8')
  const occurrences = before.split(spec.find).length - 1
  if (occurrences !== 1) {
    throw new Error(`变异 ${name} 在 ${spec.file} 里命中 ${occurrences} 次(应当恰好 1 次);`
      + '被测代码改过了,变异要跟着改,否则它只是静默失效')
  }
  writeFileSync(target, before.replace(spec.find, spec.replace))
}
