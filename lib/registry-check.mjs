/* ============================================================
 * 已发布包体检(注册表版)
 * ============================================================
 * 对 npm registry 的版本文档跑清单规则,与目录体检(manifest-check)
 * **同一份实现** —— 不是"同一套语义"而已:清单侧规则全部来自
 * checkManifestFields,两条路径不可能再对同一个包给出不同结论。
 *
 * 这里曾经自带一套手写的迷你 SemVer,理由是"会话内要零依赖";
 * 那个前提本来就不成立(semver 是本包的 dependencies,宿主进程里
 * 早就通过 cowork-plugin → manifest-check 加载了),代价却是把
 * ">=0.1 <0.2"、"1.x"、"1.2.0 - 2.0.0" 这些完全合法的 npm 范围判成
 * "不可识别" → error,合格插件被判不合格。已删除。
 *
 * 两个入口:
 *  - checkPublishedManifest 只看清单字段;
 *  - checkPublishedPackage 额外取 tarball 读出 cordis.patch.yml,
 *    补上 M4/M5/M11 —— 只看清单会漏掉"补丁行 name 写成插件名"
 *    这类装上即让整棵插件树崩溃的缺陷。
 * 冒烟阶段无法在宿主进程执行,完整体检走 CLI 或 Plugin Check
 * workflow。
 * ============================================================ */
import { checkPatchContent } from './patch-rows.mjs'
import { fetchTarEntry } from './tarball.mjs'
import { checkManifestFields } from './manifest-check.mjs'

export { versionSatisfies } from './semver-rules.mjs'

/**
 * 对一份 npm 版本清单跑体检规则。
 * @param {object} manifest - registry 版本文档(scripts/dependencies/
 *   peerDependencies/dsh/engines/license/version)。
 * @param {string} [runtime] - 目标 DSH 运行时版本;省略时只判范围合法性,
 *   不判是否覆盖(以前这是必填位置参数且无 guard,传 undefined 会产生
 *   一批凭空的 M6/M7 error)。
 * @returns {Array<{level: 'error'|'warning', rule: string, message: string}>}
 */
export function checkPublishedManifest(manifest, runtime) {
  return checkManifestFields(manifest, runtime)
}

/**
 * 已发布包的完整清单侧体检:清单规则 + 包内补丁行检查。
 * 取不到 tarball(离线、超时、体积过大)时降级为 warning 并如实
 * 标注未检查,绝不因网络问题把插件判成不合格。
 * @param {object} manifest - registry 版本文档(需含 dist.tarball)。
 * @param {string} [runtime] - 目标 DSH 运行时版本。
 * @param {{ maxBytes?: number, timeoutMs?: number }} [options]
 * @returns {Promise<{ findings: object[], inspectedPatch: boolean }>}
 */
export async function checkPublishedPackage(manifest, runtime, options = {}) {
  const findings = checkPublishedManifest(manifest, runtime)
  const patch = typeof manifest.dsh?.bundle?.patch === 'string' ? manifest.dsh.bundle.patch : ''
  const tarball = typeof manifest.dist?.tarball === 'string' ? manifest.dist.tarball : ''
  // 补丁未声明时 M4 已在清单阶段报错,无需再取包。
  if (patch === '' || tarball === '') return { findings, inspectedPatch: false }

  const relative = patch.replace(/^\.?\//u, '')
  const result = await fetchTarEntry(tarball, entry => entry === relative, options)
  if (result.error !== undefined) {
    findings.push({
      level: 'warning',
      rule: 'M4-bundle',
      message: `未能读取包内 ${relative}(${result.error});本次跳过补丁行检查,完整体检请走 CLI`,
    })
    return { findings, inspectedPatch: false }
  }
  if (result.content === undefined) {
    findings.push({
      level: 'error',
      rule: 'M4-bundle',
      message: `dsh.bundle.patch 指向的文件不在发布内容里: ${patch};宿主取不到补丁就挂不上插件(检查 files 白名单)`,
    })
    return { findings, inspectedPatch: true }
  }
  const packageName = typeof manifest.name === 'string' ? manifest.name : ''
  findings.push(...checkPatchContent(packageName, result.content).findings)
  return { findings, inspectedPatch: true }
}
