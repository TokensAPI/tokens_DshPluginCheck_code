/* ============================================================
 * 把这个插件装进一个真实宿主,然后在里面跑
 * ============================================================
 * 本仓库别的用例都自己供宿主:要么纯逻辑,要么拿 staged 宿主的
 * `evaluatePluginCompatibility` 对拍判定。这两种都看不见"宿主自己的服务
 * 换了形状"——DSH 0.2.1 把网关的 `peer` 参数从可选改必填,连接中心在四个
 * 产品版本上全坏,而它三千多条打桩用例一路全绿(agent-hub T0043/T0047)。
 *
 * 所以这一组宿主侧**一个桩都不打**:用宿主自带的 launcher 起一个一次性
 * `$DSH_HOME` profile,由**真实加载器**按本包自己的 `cordis.patch.yml` 把
 * `@tokensapi/dsh-plugin-check` 挂进去,插件随后面对的是真实的 `ctx.tools`
 * 注册表、真实的工具执行管线、真实的模块解析路径。
 *
 * 装进去的是**本包 `files` 白名单声明的那份文件集**,不是整个工作区 ——
 * 于是这组用例顺带钉住了"发布出去的那份包真的能被宿主加载"。
 *
 * 夹具安全(T0047 口径 3):`$DSH_HOME` 一律是 `mkdtemp` 出来的临时目录,
 * 探针把它实际看到的每个路径回报上来,用例逐个断言落在临时目录内、且不在
 * 用户真实的 `~/.dsh` 下。本插件只读不写,但这条守卫不看插件做了什么 ——
 * 联网搜索那次把用户真实 settings.yaml 改成测试值,就是因为没人断言路径。
 *
 * 成本:每个宿主一次 Node 进程 + 一次宿主启动,所以整个套件对每个宿主只
 * 启动一次、所有用例读同一份报告;多个宿主**串行**启动(本机内存紧,两个
 * 宿主同时起过会把整个套件带下去)。
 * ============================================================ */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { MUTATIONS, mutate } from './mutations.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..', '..')
const PROBE_URL = pathToFileURL(join(here, 'live-host-probe.mjs')).href
const PROFILE = 'plugin-check-host-contract'
/** 本包的 npm 包名,也是真实加载器要解析的那个名字。 */
export const PACKAGE_NAME = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).name
/** 起一个完整宿主不便宜;冷启动慢不等于失败。 */
const BOOT_TIMEOUT_MS = 240_000

/**
 * 要跑的 staged 宿主根(`dsh-plugin-desktop` 目录)。
 *
 * 对外只认 `DSH_HOST_ROOT`(T0047 统一口径);`DSH_HOST_ROOTS` 用 `;` 分隔,
 * 一次跑完三条产品线。`DSH_TEST_RUNTIME` 是本仓库 0.4.6 及以前的老名字
 * (指向宿主的 `package.json`),继续认下来,内部统一折算成"根目录"。
 * @returns {string[]} 配置顺序的宿主根列表。
 */
export function hostRoots() {
  const configured = process.env.DSH_HOST_ROOTS ?? process.env.DSH_HOST_ROOT ?? ''
  const roots = configured.split(';').map(entry => entry.trim()).filter(entry => entry !== '')
  if (roots.length > 0) return roots
  const legacy = process.env.DSH_TEST_RUNTIME ?? ''
  return legacy.trim() === '' ? [] : [dirname(resolve(legacy.trim()))]
}

/** 没有配置宿主时的说明;配了至少一个则为 false。 */
export const SKIP_WITHOUT_HOST = hostRoots().length > 0
  ? false
  : 'NOT EXECUTED: 需要 DSH_HOST_ROOT 指向 staged 宿主的 dsh-plugin-desktop 目录'
    + '(多个宿主用 DSH_HOST_ROOTS,";" 分隔)'

/**
 * 从宿主根解析一个包 —— 所有"宿主自己的事实"都从这里取。
 * @param {string} root - 宿主根目录。
 * @returns {NodeRequire}
 */
export function hostRequire(root) {
  return createRequire(join(resolve(root), 'package.json'))
}

/**
 * 宿主自己带的 DSH 运行时版本。
 * @param {string} root - 宿主根目录。
 * @returns {string}
 */
export function hostRuntimeVersion(root) {
  return JSON.parse(readFileSync(hostRequire(root).resolve('@deepseek-ai/dsh/package.json'), 'utf8')).version
}

/**
 * 宿主自己的 `dsh-plugin-desktop` 清单(M8 要拿它的 engines.node 对拍)。
 * @param {string} root - 宿主根目录。
 * @returns {object}
 */
export function hostManifest(root) {
  return JSON.parse(readFileSync(join(resolve(root), 'package.json'), 'utf8'))
}

/** 宿主自带的 launcher。 */
function hostLauncher(root) {
  return resolve(hostRequire(root).resolve('@deepseek-ai/dsh/package.json'), '..', 'lib/bin.js')
}

/** 用户真实的 DSH 家目录 —— 夹具断言"一个字节都没碰到这里"时的对照。 */
export const REAL_DSH_HOME = join(homedir(), '.dsh')

/**
 * 路径包含判断:大小写与分隔符按本平台来,不做字符串前缀的近似。
 *
 * 夹具安全那条断言全靠它,所以它自己也有用例(tests/host-fixture.test.mjs)
 * —— 一个恒真的 `inside()` 会让 HOST-11 变成装饰品。
 * @param {string} child - 被检查的路径。
 * @param {string} parent - 期望的上级目录。
 * @returns {boolean}
 */
export function inside(child, parent) {
  const normal = value => (process.platform === 'win32' ? value.toLowerCase() : value)
  const base = normal(parent).replace(/[\\/]+$/u, '')
  const target = normal(child)
  return target === base || target.startsWith(`${base}${sep}`)
}

/**
 * 用户真实 `~/.dsh` 的一张浅快照:顶层条目的大小与 mtime。
 *
 * 启动前后各取一次,HOST-11 要求两次完全相同 —— 断言路径只能证明"我们
 * 以为写在临时目录",这一条才能证明"用户的目录确实没被动过"。不递归:
 * 会话目录可能很大,而出事的那一类(settings.yaml 被改成测试值)就在顶层。
 * @returns {object} 条目名 → `{ size, mtimeMs }`,目录不存在时为空对象。
 */
export function realHomeSnapshot() {
  const snapshot = {}
  let entries
  try {
    entries = readdirSync(REAL_DSH_HOME, { withFileTypes: true })
  } catch {
    return snapshot
  }
  for (const entry of entries) {
    try {
      const info = statSync(join(REAL_DSH_HOME, entry.name))
      snapshot[entry.name] = { size: entry.isFile() ? info.size : undefined, mtimeMs: info.mtimeMs }
    } catch {
      snapshot[entry.name] = { unreadable: true }
    }
  }
  return snapshot
}

/**
 * 铺一个一次性的 `$DSH_HOME`:本包发布的那份文件集 + 探针 + 一个把两者叠在
 * 宿主自己 bundle 之上的 profile。
 * @param {string} root - 宿主根目录。
 * @param {string | undefined} mutation - 要施加的变异名(见 mutations.mjs);不给则装原样。
 * @returns {string} 临时 `$DSH_HOME` 路径。
 */
function composeHome(root, mutation) {
  const home = mkdtempSync(join(tmpdir(), 'plugin-check-live-'))
  const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))

  // 探针是本仓库里一份评审过的文件;加载器解析到的包只有一行,指回它,
  // 这样它 import 的是本仓库自己的模块。
  const probe = join(home, 'node_modules', 'tokens-plugin-check-live-probe')
  mkdirSync(probe, { recursive: true })
  writeFileSync(join(probe, 'package.json'), `${JSON.stringify({
    name: 'tokens-plugin-check-live-probe',
    version: '0.0.0',
    private: true,
    type: 'module',
    main: 'index.mjs',
    exports: { '.': './index.mjs' },
  }, null, 2)}\n`)
  writeFileSync(join(probe, 'index.mjs'), `export * from ${JSON.stringify(PROBE_URL)};\n`)

  const profile = join(home, 'profiles', PROFILE)
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'package.json'), `${JSON.stringify({
    name: `dsh-profile-${PROFILE}`,
    private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', manifest.name] } },
  }, null, 2)}\n`)
  writeFileSync(join(profile, 'cordis.yml'), '[]\n')
  writeFileSync(join(profile, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: tokens-plugin-check-live-probe',
    '      name: tokens-plugin-check-live-probe',
    '',
  ].join('\n'))

  // profile 自己的 node_modules 按 scope 拼:`@deepseek-ai` 指向宿主(插件
  // 必须解析到**宿主的**那一份,运行时包用 module-local Symbol,多一份物理
  // 副本就对不上服务),`@tokensapi/dsh-plugin-check` 是本包发布的文件集。
  // 不能把宿主的 node_modules 整体 junction 到前面:那样本包的第三方依赖
  // 解析不到,而且内置插件会解析到宿主钉住的旧副本(T0047-A 登录踩过)。
  const modules = join(profile, 'node_modules')
  const [scope, bare] = manifest.name.split('/')
  const installed = join(modules, scope, bare)
  mkdirSync(installed, { recursive: true })
  // npm 无条件把 LICENSE 打进 tarball,所以它也属于"发布出去的那份文件集"。
  for (const entry of ['package.json', 'cordis.patch.yml', 'README.md', 'LICENSE', 'bin', 'lib', 'docs', 'locale']) {
    cpSync(join(repo, entry), join(installed, entry), { recursive: true })
  }
  // 第三方依赖(js-yaml / semver)实复制进插件自己的 node_modules:本仓库的
  // node_modules 里也有一套 `@deepseek-ai/*`(peer 的安装产物),整体链过来
  // 会让插件解析到那一份而不是宿主的。
  mkdirSync(join(installed, 'node_modules'), { recursive: true })
  for (const dependency of ['js-yaml', 'semver', 'argparse']) {
    cpSync(join(repo, 'node_modules', dependency), join(installed, 'node_modules', dependency), { recursive: true })
  }
  if (mutation !== undefined) mutate(installed, mutation)
  symlinkSync(join(resolve(root), 'node_modules', '@deepseek-ai'), join(modules, '@deepseek-ai'),
    process.platform === 'win32' ? 'junction' : 'dir')
  return home
}

function launch(root, home, report) {
  return new Promise((settle) => {
    const child = spawn(process.execPath, [hostLauncher(root), '--profile', PROFILE], {
      cwd: home,
      env: {
        ...process.env,
        DSH_HOME: home,
        TOKENS_PLUGIN_CHECK_LIVE_REPORT: report,
        TOKENS_PLUGIN_CHECK_LIVE_HOST_ROOT: resolve(root),
        TOKENS_PLUGIN_CHECK_LIVE_PROFILE_DIR: join(home, 'profiles', PROFILE),
        TOKENS_PLUGIN_CHECK_LIVE_PACKAGE: PACKAGE_NAME,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    const collect = (chunk) => {
      output += chunk
      // 失控的宿主否则会把整份日志攒进这个字符串。
      if (output.length > 200_000) output = output.slice(-200_000)
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      settle({ output, timedOut: true })
    }, BOOT_TIMEOUT_MS)
    child.on('error', (error) => {
      clearTimeout(timer)
      settle({ output: `${output}\n${error.message}`, spawnFailed: true })
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      settle({ output, code })
    })
  })
}

/**
 * 起一个宿主,跑完探针,回收临时目录。
 * @param {string} root - 宿主根目录。
 * @param {string | undefined} mutation - 变异名;不给则装原样。
 * @returns {Promise<object>} 一份报告。
 */
export async function bootOne(root, mutation) {
  const home = composeHome(root, mutation)
  const reportPath = join(home, 'live-report.json')
  const realHomeBefore = realHomeSnapshot()
  const run = await launch(root, home, reportPath)
  const realHomeAfter = realHomeSnapshot()
  let parsed
  try {
    parsed = JSON.parse(readFileSync(reportPath, 'utf8'))
  } catch {
    parsed = undefined
  }
  let realHome
  try {
    realHome = realpathSync(home)
  } catch {
    realHome = home
  }
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 3 })
  } catch { /* 还在退出的宿主可能占着句柄;临时目录本来就是一次性的。 */ }
  return {
    root: resolve(root),
    version: hostRuntimeVersion(root),
    mutation,
    home,
    realHome,
    realHomeBefore,
    realHomeAfter,
    booted: parsed !== undefined,
    steps: parsed?.steps ?? [],
    fatal: parsed?.fatal,
    probeEnv: parsed?.env,
    launcher: run,
  }
}

let booted

/**
 * 每个测试进程只把每个宿主启动一次,串行。
 * @returns {Promise<object[]>} 按配置顺序的报告。
 */
export function liveHostReports() {
  booted ??= (async () => {
    // 有效性复核时由 `check:host --mutate` 设这个变量:同一套用例跑在被
    // 故意弄坏的那份副本上,指定的那几条必须红。
    const mutation = process.env.TOKENS_PLUGIN_CHECK_MUTATION
    const reports = []
    for (const root of hostRoots()) {
      reports.push(await bootOne(root, mutation === undefined || mutation === '' ? undefined : mutation))
    }
    return reports
  })()
  return booted
}

/**
 * 探针记录的一步。
 * @param {object} report - liveHostReports 的一项。
 * @param {string} id - 步骤 id。
 * @returns {object} 该步;探针没走到就抛,并把宿主自己的说法带上。
 */
export function liveStep(report, id) {
  if (!report.booted) {
    throw new Error(`宿主 ${report.version}(${report.root})没有回报;launcher 说:\n${
      (report.launcher.output ?? '').slice(-4000)}`)
  }
  const step = report.steps.find(entry => entry.id === id)
  if (step === undefined) {
    throw new Error(`探针在 ${report.version}(${report.root})上没走到 ${id};它记录了 ${
      report.steps.map(entry => entry.id).join('、') || '什么都没有'
    }${report.fatal === undefined ? '' : `,并以 ${JSON.stringify(report.fatal, null, 2)} 失败`}`)
  }
  return step
}

/**
 * 断言某一步成功,失败时报出宿主自己的错误。
 * @param {object} report - liveHostReports 的一项。
 * @param {string} id - 步骤 id。
 * @returns {unknown} 该步记录的值。
 */
export function liveValue(report, id) {
  const step = liveStep(report, id)
  if (!step.ok) {
    throw new Error(`${id} 在真实宿主 ${report.version}(${report.root})上失败:${
      JSON.stringify(step.error, null, 2)}`)
  }
  return step.value
}

/**
 * 同一条断言对每个配置的宿主各跑一次,失败时点名是哪个宿主。
 * @param {object[]} reports - liveHostReports 的结果。
 * @param {(report: object) => void} check - 每份报告调一次。
 */
export function forEachHost(reports, check) {
  for (const report of reports) {
    try {
      check(report)
    } catch (error) {
      error.message = `宿主 ${report.version}(${report.root}):${error.message}`
      throw error
    }
  }
}

export { MUTATIONS }
