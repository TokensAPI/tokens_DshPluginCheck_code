/* ============================================================
 * cordis.patch.yml 行提取
 * ============================================================
 * 补丁文件由 cordis-plugin-loader 的方言消费,可能携带 !!js 等
 * 自定义标签。体检工具只做只读判定,解析必须永不因未知标签而死:
 * 未知标签统一收敛为占位对象,携带它的行照常提取,配置标记为
 * 不可静态求值(冒烟时跳过该行的 config)。
 * ============================================================ */
import yaml from 'js-yaml'
import { RESERVED_ROW_IDS, RESERVED_ROW_NAMES } from './contract.mjs'

const JS_EXPR_PLACEHOLDER = Symbol('dsh-plugin-check:js-expr')

/**
 * 宽容标签前缀。
 * js-yaml 的 multi type 查找是**对解析后的完整标签串做前缀匹配**,
 * 所以这里必须写解析后的形式,而不是源码里的写法:
 *  - `!foo`      → `!foo`                      (前缀 '!')
 *  - `!!js`      → `tag:yaml.org,2002:js`      (前缀 'tag:yaml.org,2002:js')
 *  - `!!js/function` → `tag:yaml.org,2002:js/function`(同一前缀覆盖)
 *
 * 只注册 '!' 曾经漏掉整个 `!!js` 家族 —— 而 `!!js` 恰恰是宿主唯一的
 * 动态配置写法(标签定义见 deepseek-harness/scripts/cordis-yaml.ts:
 * `new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar' })`),宿主
 * 自带的 6 份 cordis.patch.yml 全部在用。于是"照抄宿主惯用法的插件"
 * 被判成补丁不是合法 YAML → M4-bundle error。
 */
const TOLERANT_TAG_PREFIXES = ['!', 'tag:yaml.org,2002:js']

const tolerantSchema = yaml.DEFAULT_SCHEMA.extend(
  TOLERANT_TAG_PREFIXES.flatMap(prefix =>
    ['scalar', 'sequence', 'mapping'].map(kind => new yaml.Type(prefix, {
      kind,
      multi: true,
      construct: () => ({ [JS_EXPR_PLACEHOLDER]: true }),
    })),
  ),
)

/**
 * 配置里是否携带无法静态求值的表达式(!!js 等自定义标签)。
 * YAML 锚点可以自引用,递归必须带环保护,否则一份合法补丁能把体检
 * 工具自己搞成栈溢出。
 * @param {unknown} value
 * @param {WeakSet<object>} [seen]
 * @returns {boolean}
 */
export function hasDynamicConfig(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') return false
  if (value[JS_EXPR_PLACEHOLDER] === true) return true
  if (seen.has(value)) return false
  seen.add(value)
  const children = Array.isArray(value) ? value : Object.values(value)
  return children.some(child => hasDynamicConfig(child, seen))
}

/**
 * 从补丁内容提取全部插件行。
 * 支持顶层两种形状:直接的行数组,或 { insert: [...] } 之类的
 * 操作映射(取所有数组值展平)。行内的 group 嵌套按 config 递归。
 * @param {string} content - cordis.patch.yml 的完整文本。
 * @returns {{ rows: Array<{id?: string, name: string, config?: unknown, disabled?: boolean, dynamicConfig: boolean}>, problems: string[] }}
 */
export function extractPatchRows(content) {
  const problems = []
  let document
  try {
    document = yaml.load(content, { schema: tolerantSchema })
  } catch (cause) {
    return { rows: [], problems: [`补丁不是合法 YAML: ${cause instanceof Error ? cause.message.split('\n')[0] : String(cause)}`] }
  }
  const topLevel = []
  if (Array.isArray(document)) {
    topLevel.push(...document)
  } else if (document !== null && typeof document === 'object') {
    for (const value of Object.values(document)) {
      if (Array.isArray(value)) topLevel.push(...value)
    }
  }
  const candidates = []
  for (const operation of topLevel) {
    if (Array.isArray(operation)) candidates.push(...operation)
    else if (operation !== null && typeof operation === 'object' && !('name' in operation)) {
      for (const value of Object.values(operation)) {
        if (Array.isArray(value)) candidates.push(...value)
      }
    } else candidates.push(operation)
  }
  const rows = []
  const visit = (entry, at) => {
    if (entry === null || typeof entry !== 'object') {
      problems.push(`${at} 不是行对象`)
      return
    }
    if (entry.group === true) {
      const children = Array.isArray(entry.config) ? entry.config : []
      children.forEach((child, index) => visit(child, `${at} group 第 ${index + 1} 行`))
      return
    }
    if (typeof entry.name !== 'string' || entry.name === '') {
      problems.push(`${at} 缺少 name`)
      return
    }
    rows.push({
      id: typeof entry.id === 'string' ? entry.id : undefined,
      name: entry.name,
      config: entry.config,
      disabled: entry.disabled === true,
      dynamicConfig: hasDynamicConfig(entry.config),
    })
  }
  candidates.forEach((entry, index) => visit(entry, `第 ${index + 1} 行`))
  return { rows, problems, entries: candidates }
}

/**
 * M11:补丁行的身份约束。
 *
 * 这一条查的不是"插件自己能不能跑",而是"装上之后用户的 Desktop
 * 还起不起得来"——三种写法各自对应一个宿主硬失败:
 *
 *  - 同层 id 重复:vendor/loader/src/config/group.ts:64 抛
 *    `TypeError: duplicate loader entry id: <id>`;dsh-plugin-desktop
 *    还有一道前置检查 assertUniqueEntryIds(profile.ts:633-646,在
 *    :949 对合成后的整份行集调用)先抛 `duplicate loader entry id
 *    "<id>" in the composed profile`。
 *  - id 含 ':':EntryTree.sep === ':'(vendor/loader/src/config/tree.ts:8),
 *    嵌套路径解析被破坏。
 *  - id/name 撞宿主保留身份:见 contract.mjs 的 RESERVED_ROW_IDS。
 *
 * 而市场安装路径装完**从不重新解析** cordis.patch.yml(service.ts:626-665
 * 只比对版本号,且没有回滚),所以这类包一路绿灯装上、下次开机才炸。
 *
 * 唯一性按"层"判,与 assertUniqueEntryIds 同构:它每递归一层新建一个
 * Set,所以父层与子层的同名 id 不算冲突。
 *
 * 查不到的部分(如实说明):跨插件、以及与宿主自身行集的 id 冲突需要
 * 完整的宿主行清单,那要求本工具跟宿主同步演进,这里只查已知保留 id。
 *
 * @param {unknown[]} entries - extractPatchRows 返回的原始行(含 group 行)。
 * @returns {Array<{level: 'error', rule: string, message: string}>}
 */
export function checkRowIdentity(entries) {
  const findings = []
  const error = (message) => findings.push({ level: 'error', rule: 'M11-row-identity', message })

  const visitLevel = (level, at) => {
    const seen = new Set()
    for (const [index, entry] of level.entries()) {
      if (entry === null || typeof entry !== 'object') continue
      const where = `${at}第 ${index + 1} 行`
      const id = entry.id
      if (typeof id === 'string') {
        if (seen.has(id)) {
          error(`${where} 的 id "${id}" 与同层前面的行重复;`
            + `宿主合成加载树时会直接抛 duplicate loader entry id,`
            + `装上这个插件的用户下次启动整个 Desktop 都起不来(不只是本插件失效)`)
        }
        seen.add(id)
        if (id.includes(':')) {
          error(`${where} 的 id "${id}" 含 ":";`
            + `":" 是加载树的层级分隔符(EntryTree.sep),用在 id 里会破坏嵌套行的寻址`)
        }
        if (RESERVED_ROW_IDS.has(id)) {
          error(`${where} 的 id "${id}" 是宿主保留行 id;`
            + `占用它会让宿主启动时抛错或让市场 provider 整体失效,请改用带包名前缀的 id`)
        }
      }
      if (typeof entry.name === 'string' && RESERVED_ROW_NAMES.has(entry.name)) {
        error(`${where} 的 name "${entry.name}" 是宿主保留包名;该行会被静默剥离并让市场 provider 失效`)
      }
      if (entry.group === true && Array.isArray(entry.config)) {
        visitLevel(entry.config, `${where} group 内 `)
      }
    }
  }

  visitLevel(Array.isArray(entries) ? entries : [], '')
  return findings
}

/**
 * 对补丁内容执行 M4/M5 判定。
 * 目录体检与会话内体检共用这一份实现:两边曾经各写各的,结果
 * 会话内看不到 M5,把装上即崩的插件判成合格。
 * @param {string} packageName - 本包 npm 包名。
 * @param {string} content - cordis.patch.yml 全文。
 * @returns {{ findings: Array<{level: 'error', rule: string, message: string}>, rows: object[] }}
 */
export function checkPatchContent(packageName, content) {
  const findings = []
  const error = (rule, message) => findings.push({ level: 'error', rule, message })
  const { rows, problems, entries } = extractPatchRows(content)
  for (const problem of problems) error('M4-bundle', `补丁行不合法: ${problem}`)
  if (rows.length === 0 && problems.length === 0) error('M4-bundle', '补丁未声明任何插件行')
  findings.push(...checkRowIdentity(entries))
  for (const row of rows) {
    if (packageName !== '' && row.name !== packageName && !row.name.startsWith(`${packageName}/`)) {
      error('M5-row-scope', `补丁行 "${row.id ?? row.name}" 指向 ${row.name},超出本包命名空间(${packageName});插件只能挂载自己的入口`)
    }
  }
  return { findings, rows }
}
