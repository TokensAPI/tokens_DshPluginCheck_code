#!/usr/bin/env node
/* ============================================================
 * npm run check:host —— 真实宿主契约的常驻入口
 * ============================================================
 * agent-hub T0047 的统一口径:每个插件都有这一条命令,只认
 * `DSH_HOST_ROOT`(staged 宿主的 `dsh-plugin-desktop` 目录),没有宿主时
 * **显式报 NOT EXECUTED 且退出码非 0** —— 不伪造通过,也不静默跳过。
 *
 * 用法
 *   DSH_HOST_ROOT=<...>/.build/desktop/dsh-plugin-desktop npm run check:host
 *   DSH_HOST_ROOTS="<一>;<二>;<三>" npm run check:host        # 一次跑三条产品线
 *   npm run check:host -- --mutate peer-0.1-only              # 有效性复核
 *   npm run check:host -- --list-mutations
 *
 * `npm test` 里这两组用例照样在,只是没有宿主时按 NOT EXECUTED 记录、不让
 * 仓库 CI 变红 —— "没跑"和"跑过了"的区别由本脚本的退出码负责。
 *
 * 宿主逐个串行跑,一次一个进程:起一个完整宿主不便宜,本机内存紧时两个
 * 宿主同时起过会把整套带下去。
 * ============================================================ */
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import semver from 'semver'

import { MUTATIONS } from '../tests/support/mutations.mjs'
import { hostRoots, hostRuntimeVersion } from '../tests/support/live-host.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** 真实宿主契约用例:起宿主的那组、判定对拍的那组、夹具守卫那组。 */
const SUITES = ['tests/host-contract.test.mjs', 'tests/host-truth.test.mjs', 'tests/host-fixture.test.mjs']
/** 用例编号,供"没有宿主"时逐条报 NOT EXECUTED。 */
const CASES = [
  ['HOST-01', '真实加载器解析到的是本次装进去的那份包'],
  ['HOST-02', '真实加载器挂起插件,宿主的 ctx.tools 收下注册'],
  ['HOST-03', '宿主投影给模型的 schema 带着插件声明的参数'],
  ['HOST-04', '宿主执行管线真跑一次 plugin_check(path=…)'],
  ['HOST-05', '宿主按 output.render 产出模型可见内容'],
  ['HOST-06', '参数互斥的错误被宿主收成 isError 结果'],
  ['HOST-07', 'isConcurrencySafe 在宿主调度里就是 parallel'],
  ['HOST-08', 'detectHostRuntime 读出的是宿主自己的版本'],
  ['HOST-09', '宿主兼容判定放行本包清单,反向对照必被拦'],
  ['HOST-10', 'M8 对照的宿主 engines.node 与宿主真实声明一致'],
  ['HOST-11', '夹具只碰临时目录,不碰用户真实的 ~/.dsh'],
  ['HOST-12', '0.1 的宿主里根本没有这道闸'],
  ['HOST-13', '宿主判定与本工具 M6/M7/M17 判级逐条对拍'],
  ['HOST-14', '未满足项字段名两个都认(peers / requirements)'],
  ['HOST-15', '插件入口的值导入在宿主里都还在'],
]

const argv = process.argv.slice(2)
const flag = name => argv.includes(name)
const option = (name) => {
  const at = argv.indexOf(name)
  return at === -1 ? undefined : argv[at + 1]
}

if (flag('--list-mutations')) {
  for (const [name, spec] of Object.entries(MUTATIONS)) {
    console.log(`${name.padEnd(16)} ${spec.description}`)
    console.log(`${' '.repeat(17)}应当变红:${spec.expectRed.join('、')}`)
  }
  process.exit(0)
}

/**
 * 跑一次用例子进程。
 * @param {string[]} roots - 这次要跑的宿主根。
 * @param {object} [extra] - 额外环境变量(变异名)。
 * @param {boolean} [tap] - 是否要 TAP 输出(变异模式要解析用例名)。
 * @returns {Promise<{code: number, output: string}>}
 */
function runSuite(roots, extra = {}, tap = false) {
  return new Promise((settle) => {
    const args = ['--test', '--test-concurrency=1']
    if (tap) args.push('--test-reporter=tap')
    args.push(...SUITES)
    const child = spawn(process.execPath, args, {
      cwd: repo,
      env: {
        ...process.env,
        DSH_HOST_ROOTS: roots.join(';'),
        DSH_HOST_ROOT: roots[0],
        ...extra,
      },
      stdio: tap ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    })
    let output = ''
    if (tap) {
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk) => { output += chunk })
      child.stderr.on('data', (chunk) => { output += chunk })
    }
    child.on('exit', code => settle({ code: code ?? 1, output }))
    child.on('error', error => settle({ code: 1, output: `${output}\n${error.message}` }))
  })
}

/** TAP 里红掉的用例编号。 */
function failedCases(output) {
  const red = new Set()
  for (const line of output.split('\n')) {
    const match = /^not ok \d+ - (HOST-\d+)/u.exec(line.trim())
    if (match !== null) red.add(match[1])
  }
  return red
}

const roots = hostRoots()

if (roots.length === 0) {
  console.error('NOT EXECUTED — 没有配置真实宿主,真实宿主契约用例一条都没跑。')
  console.error('')
  for (const [id, description] of CASES) console.error(`  ${id}  NOT EXECUTED  ${description}`)
  console.error('')
  console.error('给 DSH_HOST_ROOT 指向 staged 宿主的 dsh-plugin-desktop 目录再跑一次;')
  console.error('多个宿主用 DSH_HOST_ROOTS,";" 分隔。')
  process.exit(1)
}

const mutation = option('--mutate')

if (mutation !== undefined) {
  if (MUTATIONS[mutation] === undefined) {
    console.error(`未知变异 ${mutation};可用:${Object.keys(MUTATIONS).join('、')}`)
    process.exit(2)
  }
  const spec = MUTATIONS[mutation]
  console.log(`变异有效性复核:${mutation} —— ${spec.description}\n`)
  let ok = true
  // 一个宿主一个进程:变异的预期结果按宿主版本不同(0.1 线没有兼容门禁)。
  for (const root of roots) {
    const version = hostRuntimeVersion(root)
    const gated = spec.gatedFrom === undefined
      || semver.gte(version, spec.gatedFrom, { includePrerelease: true })
    const blind = (spec.blindOn ?? []).includes(version)
    const expected = gated && !blind ? new Set(spec.expectRed) : new Set()
    const run = await runSuite([root], { TOKENS_PLUGIN_CHECK_MUTATION: mutation }, true)
    const red = failedCases(run.output)
    const missing = [...expected].filter(id => !red.has(id))
    const extra = [...red].filter(id => !expected.has(id))
    const verdict = missing.length === 0 && extra.length === 0 ? 'PASS' : 'FAIL'
    if (verdict === 'FAIL') ok = false
    console.log(`DSH ${version}  ${verdict}`)
    const why = blind ? '这个宿主看不见这处变异' : '这个宿主没有那道闸'
    console.log(`  预期变红:${[...expected].join('、') || `(无 —— ${why})`}`)
    console.log(`  实际变红:${[...red].join('、') || '(无)'}`)
    if (missing.length > 0) console.log(`  该红没红:${missing.join('、')} —— 这几条在空转`)
    if (extra.length > 0) console.log(`  多红了:${extra.join('、')} —— 变异的影响面比写的大`)
    if (verdict === 'FAIL') console.log(run.output.split('\n').filter(line => /not ok|# Subtest|Error/u.test(line)).slice(0, 40).join('\n'))
  }
  process.exit(ok ? 0 : 1)
}

for (const root of roots) console.log(`真实宿主:DSH ${hostRuntimeVersion(root)}  ${resolve(root)}`)
console.log('')
const run = await runSuite(roots)
process.exit(run.code)
