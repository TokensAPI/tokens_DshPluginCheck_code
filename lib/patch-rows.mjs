/* ============================================================
 * cordis.patch.yml 行提取
 * ============================================================
 * 补丁文件由 cordis-plugin-loader 的方言消费,可能携带 !!js 等
 * 自定义标签。体检工具只做只读判定,解析必须永不因未知标签而死:
 * 未知标签统一收敛为占位对象,携带它的行照常提取,配置标记为
 * 不可静态求值(冒烟时跳过该行的 config)。
 * ============================================================ */
import yaml from 'js-yaml'

const JS_EXPR_PLACEHOLDER = Symbol('dsh-plugin-check:js-expr')

const tolerantSchema = yaml.DEFAULT_SCHEMA.extend(
  ['scalar', 'sequence', 'mapping'].map(kind => new yaml.Type('!', {
    kind,
    multi: true,
    construct: () => ({ [JS_EXPR_PLACEHOLDER]: true }),
  })),
)

/** 配置里是否携带无法静态求值的表达式(!!js 等自定义标签)。 */
export function hasDynamicConfig(value) {
  if (value === null || typeof value !== 'object') return false
  if (value[JS_EXPR_PLACEHOLDER] === true) return true
  const children = Array.isArray(value) ? value : Object.values(value)
  return children.some(child => hasDynamicConfig(child))
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
  return { rows, problems }
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
  const { rows, problems } = extractPatchRows(content)
  for (const problem of problems) error('M4-bundle', `补丁行不合法: ${problem}`)
  if (rows.length === 0 && problems.length === 0) error('M4-bundle', '补丁未声明任何插件行')
  for (const row of rows) {
    if (packageName !== '' && row.name !== packageName && !row.name.startsWith(`${packageName}/`)) {
      error('M5-row-scope', `补丁行 "${row.id ?? row.name}" 指向 ${row.name},超出本包命名空间(${packageName});插件只能挂载自己的入口`)
    }
  }
  return { findings, rows }
}
