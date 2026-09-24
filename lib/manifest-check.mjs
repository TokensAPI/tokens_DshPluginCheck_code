/* ============================================================
 * 阶段①:清单体检(纯静态,秒级,离线)
 * ============================================================
 * 每一条规则都对应一种已经真实发生过的"把宿主搞崩/搞坏"路径,
 * 规则说明写在 README;error 挡上架,warning 提示即将收紧或
 * 潜在错配。判定为纯函数,便于单测与市场门禁复用。
 *
 * 与会话内体检(registry-check.mjs)的关系:凡是只看清单就能判的
 * 规则,两边**必须**调同一份实现(semver-rules / client-check /
 * contract 里的谓词),否则同一个包在两条路径上会得出不同结论。
 * tests/cross-path.test.mjs 是这条约束的闸门。
 * ============================================================ */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import semver from 'semver'
import { checkPatchContent } from './patch-rows.mjs'
import { checkVersionRules } from './semver-rules.mjs'
import { checkClientDeclaration } from './client-check.mjs'
import {
  BLOCKED_PACKAGE_NAMES,
  HOST_NODE_ENGINES,
  LIFECYCLE_SCRIPTS,
  bundlePatchProblem,
  isIdentityCore,
  lifecycleMessage,
  safePackageName,
} from './contract.mjs'

const SUSPICIOUS_FILE = /(\.env(\.|$)|id_rsa|\.pem$|\.p12$|\.key$)/u

// 市场文案要求的两个 locale。宿主按 locale 取,取不到才回退市场后台的中文。
const MARKET_LOCALES = ['zh-CN', 'en-US']
// npm 无条件把这些文件打进 tarball,所以解包目录里也能判。
const LICENSE_FILES = ['LICENSE', 'LICENCE', 'LICENSE.md', 'LICENCE.md', 'LICENSE.txt', 'LICENCE.txt']

const blank = value => typeof value !== 'string' || value.trim() === ''

/**
 * 市场双语文案:两个 locale 都要有,且英文不能等于中文。
 * 把中文复制进 en-US 能过"非空"检查,市场在英文 locale 下却和没填一样。
 * @param {unknown} field - tokenscowork.displayName / summary 的值。
 * @param {string} name - 字段名,用于消息。
 * @returns {string[]} 问题描述,没问题则为空。
 */
function marketTextProblems(field, name) {
  if (field === undefined) return [`${name} 未声明`]
  if (typeof field !== 'object' || field === null || Array.isArray(field)) {
    return [`${name} 必须是 { "zh-CN": …, "en-US": … } 形状的对象`]
  }
  const problems = []
  for (const locale of MARKET_LOCALES) {
    if (blank(field[locale])) problems.push(`${name}.${locale} 缺失或为空`)
  }
  if (problems.length === 0 && field['zh-CN'].trim() === field['en-US'].trim()) {
    problems.push(`${name}.en-US 与 zh-CN 逐字相同,英文 locale 下等于没填`)
  }
  return problems
}

// npm init 留下的占位命令,存在但跑起来必然失败,等同于没有测试。
const PLACEHOLDER_TEST = /no test specified/iu
// 常见测试目录与文件名后缀;位置不强制,所以两种都认。
const TEST_DIRS = ['test', 'tests', '__tests__', 'spec']
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/u

// 目录里是否真有测试文件:先看常见目录,再看源码目录里的同名后缀文件。
// 只下探两层,插件仓库不深,避免在 node_modules 上浪费时间。
function hasTestFiles(pluginDir) {
  const seen = (dir, depth) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return false
    }
    for (const entry of entries) {
      if (entry.isFile() && TEST_FILE.test(entry.name)) return true
      if (entry.isDirectory() && depth > 0 && entry.name !== 'node_modules' && !entry.name.startsWith('.')) {
        if (seen(join(dir, entry.name), depth - 1)) return true
      }
    }
    return false
  }
  for (const name of TEST_DIRS) {
    const dir = join(pluginDir, name)
    if (existsSync(dir) && statSync(dir).isDirectory() && seen(dir, 2)) return true
  }
  return seen(pluginDir, 2)
}

/**
 * 只看清单就能判的规则,两条执行路径共用这一份。
 * @param {object} manifest - package.json / registry 版本文档。
 * @param {string | undefined} runtime - 目标 DSH 运行时版本。
 * @returns {Array<{level: string, rule: string, message: string}>}
 */
export function checkManifestFields(manifest, runtime) {
  const findings = []
  const error = (rule, message) => findings.push({ level: 'error', rule, message })
  const warning = (rule, message) => findings.push({ level: 'warning', rule, message })

  // M1 / M6 / M7
  findings.push(...checkVersionRules(manifest, runtime))

  // M1:包名形状。上游市场验证器在拿到清单之前就用这个谓词拒绝,
  // 名字不合规的包无论内容多干净都装不进去。
  if (typeof manifest.name === 'string' && manifest.name !== '') {
    if (!safePackageName(manifest.name)) {
      error('M1-manifest', `name "${manifest.name}" 不满足市场的包名约束`
        + `(小写字母/数字开头,只含 a-z 0-9 . _ -,可带一层 @scope,总长 ≤214);`
        + `不满足时受控安装会在验证阶段直接拒绝`)
    }
    if (BLOCKED_PACKAGE_NAMES.has(manifest.name)) {
      error('M1-manifest', `name "${manifest.name}" 是宿主/市场自身的包名,被上游列入黑名单,永远装不进市场`)
    }
  }

  // M2
  const scripts = manifest.scripts ?? {}
  for (const script of LIFECYCLE_SCRIPTS) {
    if (typeof scripts[script] === 'string') warning('M2-lifecycle', lifecycleMessage(script))
  }

  // M3
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    if (isIdentityCore(name)) {
      error('M3-core-peer', `${name} 出现在 dependencies;核心运行时必须声明为 peerDependencies,`
        + `否则宿主与插件各持一份实例,服务注册无法对上,典型症状是整个 Cowork 启动失败`)
    }
  }

  // M4:声明本身(补丁文件内容由调用方按各自的取文件方式补上)
  const patch = manifest.dsh?.bundle?.patch
  if (typeof patch !== 'string' || patch === '') {
    error('M4-bundle', 'dsh.bundle.patch 缺失;宿主靠它把插件挂进加载树')
  } else {
    const problem = bundlePatchProblem(patch)
    if (problem !== undefined) {
      error('M4-bundle', `dsh.bundle.patch "${patch}" ${problem};`
        + `市场受控安装的验证器(上游 safeBundlePatch)会直接拒绝这个包,`
        + `用户端永远看不到一键安装按钮,只会看到手动安装命令`)
    }
  }

  // M8
  const nodeEngine = manifest.engines?.node
  if (nodeEngine === undefined) {
    warning('M8-node-engines', 'engines.node 未声明;宿主运行在 Node 22+')
  } else if (typeof nodeEngine !== 'string' || semver.validRange(nodeEngine) === null) {
    warning('M8-node-engines', `engines.node "${nodeEngine}" 不是合法 SemVer 范围`)
  } else if (semver.validRange(HOST_NODE_ENGINES) !== null
    && !semver.intersects(nodeEngine, HOST_NODE_ENGINES, { includePrerelease: true })) {
    warning('M8-node-engines', `engines.node "${nodeEngine}" 与宿主的 "${HOST_NODE_ENGINES}" 无交集;`
      + `包管理器会在安装阶段报 unsupported engine`)
  }

  // M9
  if (manifest.license === undefined) warning('M9-license', 'license 未声明')

  // M14:发布目标。这里**不断言**具体 Registry —— 插件可以合法地发到公共
  // npm,那是作者的选择。只判"没声明":此时发布目标取决于执行 npm publish
  // 那台机器的配置,私有插件会就这么发到公共源上,且版本不可撤。要钉死某个
  // Registry,写在各仓库自己的发布校验里(scripts/validate-release.mjs)。
  const publishRegistry = manifest.publishConfig?.registry
  if (publishRegistry === undefined) {
    warning('M14-publish-target', 'publishConfig.registry 未声明;发布目标取决于执行机器的 npm 配置,'
      + '私有插件会因此发到公共源,而版本一旦发出不可撤回')
  } else if (typeof publishRegistry !== 'string' || !/^https:\/\/[^\s]+$/u.test(publishRegistry)) {
    warning('M14-publish-target', `publishConfig.registry "${publishRegistry}" 不是 https URL`)
  }

  // M15:市场双语文案。市场从**已发布的包**里读这一段,读不到才回退后台
  // 存的中文,所以改了 package.json 也要等下次发版才生效。
  const market = manifest.tokenscowork
  if (market === undefined) {
    warning('M15-market-i18n', 'tokenscowork 未声明;市场只能回退到后台存的文案(通常只有中文),'
      + '英文 locale 下显示中文')
  } else if (typeof market !== 'object' || market === null || Array.isArray(market)) {
    warning('M15-market-i18n', 'tokenscowork 必须是对象')
  } else {
    for (const problem of [
      ...marketTextProblems(market.displayName, 'tokenscowork.displayName'),
      ...marketTextProblems(market.summary, 'tokenscowork.summary'),
    ]) {
      warning('M15-market-i18n', problem)
    }
  }

  // M12
  findings.push(...checkClientDeclaration(manifest))

  // 宿主/Profile 侧字段被插件误抄
  for (const field of ['profile', 'moduleFallback']) {
    if (manifest.dsh?.[field] !== undefined) {
      warning('M1-manifest', `dsh.${field} 是宿主/Profile 侧字段,插件包声明它没有作用,`
        + `多半是从 Profile 或宿主的 package.json 误抄过来的`)
    }
  }

  return findings
}

/**
 * 对一个插件目录执行全部清单规则。
 * @param {string} pluginDir - 插件根目录(含 package.json)。
 * @param {{ runtime?: string }} [options] - runtime 为目标 DSH 运行时
 *   版本(如 0.1.3-alpha.1);给出时才执行 engine/peer 与其的交集判定。
 * @returns {{ findings: Array<{level: 'error'|'warning', rule: string, message: string}>, manifest?: object, rows?: object[] }}
 */
export function checkManifest(pluginDir, options = {}) {
  const findings = []
  const error = (rule, message) => findings.push({ level: 'error', rule, message })
  const warning = (rule, message) => findings.push({ level: 'warning', rule, message })

  const manifestPath = resolve(pluginDir, 'package.json')
  if (!existsSync(manifestPath)) {
    error('M1-manifest', 'package.json 不存在')
    return { findings }
  }
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (cause) {
    error('M1-manifest', `package.json 不是合法 JSON: ${cause instanceof Error ? cause.message : String(cause)}`)
    return { findings }
  }

  findings.push(...checkManifestFields(manifest, options.runtime))

  // M4/M5/M11 的补丁内容部分:目录路径直接读盘。
  const patch = manifest.dsh?.bundle?.patch
  let rows
  if (typeof patch === 'string' && patch !== '') {
    const patchPath = resolve(pluginDir, patch)
    if (!existsSync(patchPath)) {
      error('M4-bundle', `dsh.bundle.patch 指向的文件不存在: ${patch}`)
    } else {
      // 与会话内体检共用同一份实现,避免两条路径判定漂移。
      const checked = checkPatchContent(
        typeof manifest.name === 'string' ? manifest.name : '',
        readFileSync(patchPath, 'utf8'),
      )
      findings.push(...checked.findings)
      rows = checked.rows
    }
  }

  // M10:依赖文件系统,只在目录路径可判(registry 路径没有工作区,
  // 这是有意的差异,不是漏 —— 见 docs/CHECKS.md §1)。
  const filesList = Array.isArray(manifest.files) ? manifest.files : []
  for (const entry of filesList) {
    if (typeof entry === 'string' && SUSPICIOUS_FILE.test(entry)) {
      error('M10-secrets', `files 白名单包含疑似凭据文件: ${entry}`)
    }
  }
  for (const candidate of ['.env', 'id_rsa']) {
    const candidatePath = join(pluginDir, candidate)
    if (existsSync(candidatePath) && statSync(candidatePath).isFile() && filesList.length === 0) {
      warning('M10-secrets', `目录含 ${candidate} 且未用 files 白名单限定发布内容,npm pack 可能把它带上`)
    }
  }

  // M16:声明了 license 就要有正文。LICENSE 被 npm 无条件打进 tarball,
  // 所以解包目录(--package)里也能判,不受 options.workspace 限制;只有
  // registry 清单路径看不到文件。
  if (manifest.license !== undefined && !LICENSE_FILES.some(name => existsSync(join(pluginDir, name)))) {
    warning('M16-license-file', `声明了 license "${manifest.license}" 但目录里没有许可证正文`
      + `(找过 ${LICENSE_FILES.slice(0, 3).join('、')} 等);下游拿到包无法确认授权条款`)
  }

  // M13:只在真实工作区可判。--package 模式把 tarball 解包后喂进来的也是
  // 一个"目录",但 tests/ 按惯例被 files 白名单挡在包外,在那里判必然误报,
  // 所以由调用方用 options.workspace 显式声明。不判不等于合格。
  const testScript = options.workspace === false ? undefined : manifest.scripts?.test
  const hasCommand = typeof testScript === 'string' && testScript.trim() !== '' && !PLACEHOLDER_TEST.test(testScript)
  if (options.workspace === false) {
    // 解包目录不判,理由同上。
  } else if (!hasCommand) {
    warning('M13-tests', 'scripts.test 未声明或仍是 npm init 的占位命令,CI 与本地没有同一条测试入口')
  } else if (!hasTestFiles(pluginDir)) {
    warning('M13-tests', `scripts.test 已声明但目录里找不到测试文件(找过 ${TEST_DIRS.join('/')} 和 *.test.*)`)
  }

  return { findings, manifest, rows }
}
