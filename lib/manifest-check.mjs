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
import { existsSync, readFileSync, statSync } from 'node:fs'
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

  return { findings, manifest, rows }
}
