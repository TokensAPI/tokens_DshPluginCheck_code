/* ============================================================
 * 上游契约基线
 * ============================================================
 * 这个工具的每条规则都不是写法偏好,而是照着某个上游版本的真实
 * 行为写下的判定。上游一变,规则可能要跟着变,也可能完全不用变
 * —— 区别只有"回去看一眼"才知道。所以把「照着哪个版本核对的」
 * 做成机器可读的一份数据,跟着每次体检结果一起输出;目标运行时
 * 落在核对过的范围之外时明确说"没核对过",而不是假装照样有效。
 *
 * 每条规则锚在上游哪个文件/行:见 docs/CHECKS.md。
 * 上游升级后的逐条复核流程:见同一文档末尾「上游变动后怎么复核」。
 * ============================================================ */

/** 上游契约基线:最近一次逐条核对上游代码时的事实快照。 */
export const CONTRACT = {
  /** 最近一次逐条核对上游代码的日期。 */
  verifiedAt: '2026-09-10',
  /** 核对时上游各包的版本;规则的判定口径照着这些版本的代码写。 */
  upstream: {
    'dsh-plugin-desktop': '2.0.5',
    'dsh-community-market': '0.1.0-dev.0',
    '@deepseek-ai/cordis': '4.0.2',
    '@deepseek-ai/dsh-tools': '0.1.3-alpha.1',
    pnpm: '11.8.0',
  },
  /** 实际核对过的 DSH 运行时版本。 */
  runtimes: ['0.1.0-rc.8', '0.1.3-alpha.1'],
  /** 核对过的运行时区间;超出只代表未核对,不代表不可用。 */
  runtimeRange: '>=0.1.0-rc.8 <0.2.0',
}

/** 一行人读的基线摘要,供 CLI 抬头与会话内结果展示。 */
export function contractLine() {
  const { upstream } = CONTRACT
  return `契约基线 ${CONTRACT.verifiedAt} · desktop ${upstream['dsh-plugin-desktop']}`
    + ` / market ${upstream['dsh-community-market']}`
    + ` · 已核对运行时 ${CONTRACT.runtimes.join('、')}`
}

/**
 * 目标运行时是否在核对过的范围内。
 * 不做区间数学:只认"确实核对过的那几个版本",别的一律如实说
 * 没核对过 —— 这条提示的价值就在于不替上游的未知变动打包票。
 * @param {string | undefined} runtime - 目标 DSH 运行时版本。
 * @returns {Array<{level: 'warning', rule: string, message: string}>}
 */
export function checkContractBaseline(runtime) {
  if (runtime === undefined || runtime === '') return []
  if (CONTRACT.runtimes.includes(runtime)) return []
  return [{
    level: 'warning',
    rule: 'C0-contract',
    message: `目标运行时 ${runtime} 不在本工具核对过的版本里`
      + `(已核对 ${CONTRACT.runtimes.join('、')},核对日期 ${CONTRACT.verifiedAt});`
      + `规则仍按 ${CONTRACT.runtimeRange} 的上游行为判定,上游若已改动,结论可能过时或过严。`
      + `复核清单见 docs/CHECKS.md`,
  }]
}

/**
 * 安装期生命周期脚本。曾经是市场硬红线,核对下来现在不是了。
 * 上游 dsh-community-market 0.1.0-dev.0 的 npm 验证器已不再看
 * scripts;受控安装是 `pnpm add --save-exact --registry=…`,没有
 * --ignore-scripts,而 Profile 也没有配 onlyBuiltDependencies 允许
 * 名单。两种结局都不好,但都不是"上架被拒",所以降为 warning:
 *  - 脚本真执行 → 安装即在用户机器上跑任意代码;
 *  - 脚本被包管理器默认策略拦下 → 依赖脚本产物的插件装完即坏。
 */
export const LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare']

/** M2 的措辞:两条安装路径行为不同,分开说清楚。 */
export function lifecycleMessage(script) {
  if (script === 'prepare') {
    return 'prepare 脚本:从 npm tarball 安装时不执行,从 github: 源安装时执行;'
      + '同一个包两条安装路径行为不一致,构建请改用 prepack'
  }
  return `${script} 脚本:宿主受控安装是 pnpm add(未加 --ignore-scripts),`
    + `要么在用户机器上执行任意代码,要么被包管理器默认策略拦下、脚本产物缺失导致插件装完即坏;`
    + `构建请改用 prepack`
}
