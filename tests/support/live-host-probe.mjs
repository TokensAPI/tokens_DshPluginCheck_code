/* ============================================================
 * 插进真实宿主里的探针
 * ============================================================
 * 它本身是个 Cordis 插件,作为 profile 条目和被测插件并排挂在同一棵树上,
 * 而且**只记录,不断言** —— 断言留给套件里的用例。某一步抛了就把宿主自己
 * 的原始错误记下来,这样契约被破坏时看到的是宿主的措辞,而不是一条断言 diff。
 *
 * 它碰到的每一样东西都属于正在运行的宿主:真实的 `ctx.tools` 注册表、真实
 * 的工具执行管线(pre/guard/around/post 全程)、真实的模块解析路径、宿主
 * 自己的 `evaluatePluginCompatibility`。本插件不订阅任何会话事件、不发网关
 * 调用、不注册 slot,所以这里**没有**那几类步骤 —— 只断言它真正依赖的东西。
 * ============================================================ */
import { createRequire } from 'node:module'
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const name = 'tokens-plugin-check-live-probe'
export const inject = []

const REPORT = process.env.TOKENS_PLUGIN_CHECK_LIVE_REPORT
const HOST_ROOT = process.env.TOKENS_PLUGIN_CHECK_LIVE_HOST_ROOT
const PROFILE_DIR = process.env.TOKENS_PLUGIN_CHECK_LIVE_PROFILE_DIR
const PACKAGE_NAME = process.env.TOKENS_PLUGIN_CHECK_LIVE_PACKAGE
const HOME = process.env.DSH_HOME
/** 等宿主自己的服务起来。 */
const READY_TIMEOUT_MS = 90_000
/** 等被测插件的 Loader 行把工具注册上来 —— 行被停用时这段必然等满。 */
const REGISTER_TIMEOUT_MS = 20_000
const TOOL = 'plugin_check'

function describe(error, depth = 0) {
  if (typeof error !== 'object' || error === null) return { name: typeof error, message: String(error) }
  return {
    name: error.name,
    message: error.message,
    code: error.code,
    stack: typeof error.stack === 'string' ? error.stack.split('\n').slice(0, 12) : undefined,
    ...(error.cause !== undefined && depth < 3 ? { cause: describe(error.cause, depth + 1) } : {}),
  }
}

async function step(steps, id, run) {
  try {
    steps.push({ id, ok: true, value: await run() })
  } catch (error) {
    steps.push({ id, ok: false, error: describe(error) })
  }
  return steps.at(-1)
}

const wait = ms => new Promise((settle) => { setTimeout(settle, ms) })

/** 等宿主注册表里出现被测工具;超时就把注册表当时的全貌一起报出来。 */
async function awaitTool(ctx) {
  const deadline = Date.now() + REGISTER_TIMEOUT_MS
  while (Date.now() < deadline) {
    const definition = ctx.tools.get(TOOL)
    if (definition !== undefined) return definition
    await wait(200)
  }
  throw new Error(`被测插件始终没有把 ${TOOL} 注册进宿主注册表;`
    + `宿主此刻可见的工具是:${ctx.tools.schemas().map(schema => schema.name).join('、') || '(空)'}`
    + '。Loader 行被兼容门禁停用时就是这个现象')
}

/** 走宿主自己的执行管线调一次工具。 */
function execute(ctx, args, callId) {
  return ctx.tools.execute({
    callId,
    name: TOOL,
    arguments: args,
    signal: new AbortController().signal,
  })
}

/** 只留用例要断言的字段,免得把宿主内部结构整个搬进报告。 */
function summarize(result) {
  return {
    isError: result.isError,
    value: result.value,
    content: result.content,
    error: result.isError ? { code: result.error?.code, message: result.error?.message } : undefined,
  }
}

async function run(ctx) {
  const steps = []
  const hostRequire = createRequire(join(HOST_ROOT, 'package.json'))
  const hostRuntime = JSON.parse(readFileSync(hostRequire.resolve('@deepseek-ai/dsh/package.json'), 'utf8')).version

  // 被测插件在宿主里解析到的真实位置。登录插件踩过的坑:宿主自己也可能带
  // 一份同名包,解析错了用例全绿但测的不是待测代码,所以这件事单独报一步。
  const installed = await step(steps, 'plugin.resolved', () => {
    const profileRequire = createRequire(join(PROFILE_DIR, 'package.json'))
    const entry = realpathSync(profileRequire.resolve(PACKAGE_NAME))
    const manifestPath = realpathSync(profileRequire.resolve(`${PACKAGE_NAME}/package.json`))
    return {
      entry,
      manifestPath,
      version: JSON.parse(readFileSync(manifestPath, 'utf8')).version,
      toolsResolvedFromPlugin: realpathSync(
        createRequire(manifestPath).resolve('@deepseek-ai/dsh-tools/package.json'),
      ),
      toolsResolvedFromHost: realpathSync(hostRequire.resolve('@deepseek-ai/dsh-tools/package.json')),
    }
  })

  // 真实加载器有没有把它挂起来、`inject: ['tools']` 有没有被尊重、
  // `ctx.tools.register` 有没有收下我们的定义 —— 一步全在这里见真章。
  const definition = await step(steps, 'tools.registered', async () => {
    const registered = await awaitTool(ctx)
    return {
      name: registered.name,
      hasExecute: typeof registered.execute === 'function',
      hasOutputSchema: typeof registered.output?.schema === 'object' && registered.output.schema !== null,
      // 宿主会把我们声明的 `{ type: 'json' }` 规范化成它自己的内部形状,
      // 所以这里只把它原样带回报告供排查,不断言具体长什么样。
      outputSchema: registered.output?.schema,
      hasRender: typeof registered.output?.render === 'function',
      concurrencySafe: typeof registered.isConcurrencySafe === 'function',
    }
  })

  // 宿主投影给模型看的那份 schema:我们声明的参数有没有活着穿过去。
  await step(steps, 'tools.schema', () => {
    const schema = ctx.tools.schemas().find(entry => entry.name === TOOL)
    if (schema === undefined) throw new Error(`宿主的 schemas() 里没有 ${TOOL}`)
    return {
      name: schema.name,
      describesPurpose: typeof schema.description === 'string' && schema.description.length > 0,
      parameters: Object.keys(schema.parameters?.properties ?? schema.parameters ?? {}),
    }
  })

  // isConcurrencySafe 的归宿:宿主的调度分类(宿主回的是 `{ kind }`)。
  await step(steps, 'tools.executionMode', () => {
    const mode = ctx.tools.executionMode({ name: TOOL, arguments: { path: PROFILE_DIR } })
    return { kind: typeof mode === 'string' ? mode : mode?.kind, raw: mode }
  })

  // 真调一次 `path=`:被测对象就是**它自己装进来的那份目录**,所以这一步
  // 同时验了"发布出去的文件集在真实宿主里跑得动"。宿主会按 output.schema
  // 校验返回值、按 output.render 产出模型可见内容,两件事都发生在管线里。
  await step(steps, 'tools.execute.path', async () => {
    const target = installed.ok ? join(installed.value.manifestPath, '..') : PROFILE_DIR
    const result = await execute(ctx, { path: target }, 'plugin-check-contract-path')
    return { target, ...summarize(result) }
  })

  // 错误路径:工具自己抛,宿主要把它收成一条 isError 结果,而不是让整条
  // 管线炸掉。会话里用户漏参数就走这条。
  await step(steps, 'tools.execute.invalid', async () => {
    const result = await execute(ctx, {}, 'plugin-check-contract-invalid')
    return summarize(result)
  })

  // 宿主自己的兼容判定 —— 对**本包真实的清单**。它返回"放行",而宿主也确实
  // 把我们挂起来了,两件事互为印证;0.1 线没有这个导出,如实报 NOT DECLARED。
  await step(steps, 'host.compatibility', async () => {
    let boot
    try {
      boot = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-app-boot')).href)
    } catch (error) {
      return { declared: false, reason: `无法导入宿主的 app-boot:${error.message}` }
    }
    if (typeof boot.evaluatePluginCompatibility !== 'function') {
      return { declared: false, reason: 'NOT DECLARED:这个宿主的 app-boot 没有 evaluatePluginCompatibility' }
    }
    const manifest = installed.ok
      ? JSON.parse(readFileSync(installed.value.manifestPath, 'utf8'))
      : undefined
    if (manifest === undefined) throw new Error('没拿到装进来的清单,无法交给宿主判定')
    const verdict = boot.evaluatePluginCompatibility(manifest, {}, hostRuntime)
    // 反向对照:同一份清单加一条谁都满足不了的假 peer,必须被报出来 ——
    // 否则上面那个"放行"可能只是评估器在空转。
    const sentinel = boot.evaluatePluginCompatibility(
      {
        ...manifest,
        peerDependencies: { ...manifest.peerDependencies, '@deepseek-ai/dsh-nonexistent': '>=99.0.0' },
      },
      {},
      hostRuntime,
    )
    const unmet = sentinel === undefined ? undefined : (sentinel.requirements ?? sentinel.peers)
    return {
      declared: true,
      runtime: hostRuntime,
      allowed: verdict === undefined,
      verdict: verdict === undefined ? undefined : JSON.parse(JSON.stringify(verdict)),
      sentinelBlocked: sentinel !== undefined,
      sentinelUnmet: unmet === undefined ? undefined : Object.keys(unmet),
      unmetField: sentinel === undefined
        ? undefined
        : (sentinel.requirements !== undefined ? 'requirements' : (sentinel.peers !== undefined ? 'peers' : 'none')),
    }
  })

  // 宿主自己的 engines.node —— M8 拿它当对照,所以它不能靠记忆。
  // 工具侧那个常量从**装进来的那份副本**里读(也就是发布出去的那份),
  // 不是从工作区读:用户拿到的是副本里的值。
  await step(steps, 'host.engines', async () => {
    const contract = installed.ok
      ? await import(pathToFileURL(join(installed.value.manifestPath, '..', 'lib', 'contract.mjs')).href)
      : undefined
    return {
      node: JSON.parse(readFileSync(join(HOST_ROOT, 'package.json'), 'utf8')).engines?.node,
      toolNodeEngines: contract?.HOST_NODE_ENGINES,
      runtime: hostRuntime,
    }
  })

  // 夹具安全:报出所有写得到的路径,用例断言它们都在临时目录里。
  // 逐项容错:某个宿主取不到某条路径不该让整步失败,那样守卫就等于没有。
  await step(steps, 'fixture.paths', () => {
    const paths = {}
    const record = (label, read) => {
      try {
        const value = read()
        if (typeof value === 'string' && value !== '') paths[label] = value
      } catch (error) {
        paths[`${label}:unreadable`] = error.message
      }
    }
    record('home', () => HOME)
    record('realHome', () => realpathSync(HOME))
    record('profileDir', () => realpathSync(PROFILE_DIR))
    record('cwd', () => realpathSync(process.cwd()))
    record('installed', () => (installed.ok ? join(installed.value.manifestPath, '..') : undefined))
    record('baseDir', () => ctx.baseDir)
    // 宿主自己算出来的家目录:夹具安全的真正要害 —— 它必须是临时目录,
    // 不是用户的 ~/.dsh(联网搜索那次正是这里失守)。
    record('profilesDir', () => join(HOME, 'profiles'))
    return paths
  })

  return { steps, definition: definition.value }
}

function finish(report) {
  const text = JSON.stringify(report, null, 2)
  if (REPORT) {
    try {
      writeFileSync(REPORT, text)
    } catch {
      process.stdout.write(`TOKENS-PLUGIN-CHECK-LIVE ${text}\n`)
    }
  }
  // 这个进程归宿主所有;夹具等它退出之后才去读报告。
  setTimeout(() => process.exit(0), 100)
}

export function apply(ctx) {
  // base-only 的 profile 没有常驻 app 把事件循环撑住,所以这个定时器**不**
  // unref:它既是"宿主服务迟迟不就绪"的兜底,也是进程的活口。
  const timer = setTimeout(
    () => finish({ env: { home: HOME, hostRoot: HOST_ROOT }, steps: [], fatal: '宿主服务始终没有就绪' }),
    READY_TIMEOUT_MS,
  )
  ctx.inject(['tools'], (readyCtx) => {
    clearTimeout(timer)
    // 清掉活口之后再撑一个,直到探针跑完。
    const alive = setInterval(() => {}, 1000)
    run(readyCtx).then(
      ({ steps }) => {
        clearInterval(alive)
        finish({ env: { home: HOME, hostRoot: HOST_ROOT }, steps })
      },
      (error) => {
        clearInterval(alive)
        finish({ env: { home: HOME, hostRoot: HOST_ROOT }, steps: [], fatal: describe(error) })
      },
    )
  })
}
