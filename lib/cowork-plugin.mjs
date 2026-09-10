/* ============================================================
 * Cowork 插件入口:会话内插件体检工具
 * ============================================================
 * 装进 TokensCowork 后注册 plugin_check 工具:对本地插件目录或
 * 任意 npm 插件包
 * 跑清单规则 + 包内补丁行检查(与 CLI 的清单阶段同源),模型或
 * 用户在会话里即可判断"这个插件装进来会不会有问题"。补丁行会
 * 从 tarball 里真读出来 —— 只看 registry 清单会漏掉"补丁行 name
 * 写成插件名"这类装上即崩的缺陷。含隔离启动冒烟的完整体检仍走
 * CLI:npx @tokensapi/dsh-plugin-check --package <name@ver>。
 * ============================================================ */
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import semver from 'semver'
import { checkManifest } from './manifest-check.mjs'
import { checkPublishedPackage } from './registry-check.mjs'
import { CONTRACT, checkContractBaseline } from './contract.mjs'

/** 兜底的运行时版本;仅在宿主探测失败且未配置 runtime 时使用。 */
const FALLBACK_RUNTIME = '0.1.3-alpha.1'
const REGISTRY = 'https://registry.npmjs.org'
const FETCH_TIMEOUT_MS = 15_000

export const name = 'tokens-plugin-check'
export const inject = ['tools']

/**
 * 从宿主自身读取实际运行时版本,避免硬编码常量随宿主升级悄悄失真。
 * 本模块装进 Cowork 后就运行在宿主进程里:先读 @deepseek-ai/dsh
 * (即运行时本体,当前无 exports 限制),读不到再退回声明为 peer、
 * 显式导出 ./package.json 的 dsh-tools。两者都失败才轮到兜底常量。
 */
export function detectHostRuntime(requireFrom = createRequire(import.meta.url)) {
  for (const spec of ['@deepseek-ai/dsh/package.json', '@deepseek-ai/dsh-tools/package.json']) {
    try {
      const version = requireFrom(spec).version
      if (typeof version === 'string' && semver.valid(version) !== null) return version
    } catch {}
  }
  return undefined
}

async function fetchManifest(packageName, version) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(
      `${REGISTRY}/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`,
      { signal: controller.signal, headers: { accept: 'application/json' } },
    )
    if (!response.ok) {
      throw new Error(response.status === 404 ? `npm 上未找到 ${packageName}@${version}` : `npm 查询失败(HTTP ${response.status})`)
    }
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ runtime?: string }} [config]
 */
export function apply(ctx, config = {}) {
  // 基准版本优先级:显式配置 > 宿主实际版本 > 兜底常量。
  const runtime = typeof config.runtime === 'string' && config.runtime !== ''
    ? config.runtime
    : detectHostRuntime() ?? FALLBACK_RUNTIME
  ctx.tools.register(defineTool({
    name: 'plugin_check',
    description: 'Check whether a DSH/TokensCowork plugin is safe to install: forbidden lifecycle '
      + 'scripts, dual-kernel core dependencies, missing or out-of-scope cordis patch rows, and '
      + 'runtime/peer compatibility against the current DSH runtime. Returns ok=false with per-rule '
      + 'findings when the plugin would break the host. '
      + 'Pass "path" for a plugin the user is developing locally (checks the working tree, no publish '
      + 'needed) — prefer this whenever the user asks about their own plugin before releasing it. '
      + 'Pass "package" for an already published npm package. Exactly one of the two is required.',
    parameters: {
      path: {
        type: 'string',
        description: 'Local plugin directory containing package.json. Use for unpublished/in-development plugins.',
      },
      package: {
        type: 'string',
        description: 'Published npm package name, e.g. "@tokensapi/dsh-progressive-tools".',
      },
      version: {
        type: 'string',
        description: 'Exact version to check with "package". Defaults to the latest dist-tag.',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const hasPath = typeof args.path === 'string' && args.path !== ''
      const hasPackage = typeof args.package === 'string' && args.package !== ''
      if (hasPath === hasPackage) {
        throw new Error('plugin_check 需要且只需要一个目标:本地目录传 path,已发布包传 package')
      }
      if (hasPath) {
        // 本地工作区体检:发版前就能判,不需要先 publish。隔离冒烟要装
        // 依赖起子进程,宿主进程里不做,如实告知走 CLI。
        const local = checkManifest(resolve(args.path), { runtime })
        const localFindings = [...checkContractBaseline(runtime), ...local.findings]
        return {
          path: resolve(args.path),
          package: local.manifest?.name,
          version: local.manifest?.version,
          runtime,
          contract: CONTRACT,
          ok: !localFindings.some(finding => finding.level === 'error'),
          inspectedPatch: true,
          findings: localFindings,
          note: '以上为清单规则 + 补丁行检查(读的是本地工作区);隔离启动冒烟请在插件目录运行 '
            + 'npx @tokensapi/dsh-plugin-check --runtime ' + runtime,
        }
      }
      const manifest = await fetchManifest(args.package, args.version ?? 'latest')
      const { findings, inspectedPatch } = await checkPublishedPackage(manifest, runtime)
      const published = [...checkContractBaseline(runtime), ...findings]
      return {
        package: manifest.name,
        version: manifest.version,
        runtime,
        contract: CONTRACT,
        ok: !published.some(finding => finding.level === 'error'),
        inspectedPatch,
        findings: published,
        note: inspectedPatch
          ? '以上为清单规则 + 包内补丁行检查;含隔离启动冒烟的完整体检请运行 npx @tokensapi/dsh-plugin-check --package <name@version>'
          : '未读到包内补丁文件,补丁行未检查;请运行 npx @tokensapi/dsh-plugin-check --package <name@version> 做完整体检',
      }
    },
  }))
}
