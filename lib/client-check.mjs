/* ============================================================
 * M12-client:dsh.client 声明
 * ============================================================
 * 为什么这条是 error 而不是"你自己的事":宿主的 client-modules 在
 * **构造期同步**解析所有已加载包的 dsh.client(parseDshClient,
 * packages/client/modules/src/index.ts:200-221),一份声明写坏会抛出
 * 并让整个 client-modules fiber FAIL —— 受害的不止这个插件,而是同
 * 一宿主里所有需要前端模块的插件。
 *
 * 字段全集就是 { platform, inject?, external?, immediately? }
 * (同文件 :51-64),未知键被忽略。
 * ============================================================ */

/**
 * 上游 exactPackageSpecifier(index.ts:192-198):只接受精确的裸包根,
 * scope 包恰好两段、非 scope 包不含 "/"。
 * @param {string} specifier
 * @returns {boolean}
 */
function isExactPackageSpecifier(specifier) {
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/')
    return parts.length === 2 && parts.every(Boolean)
  }
  return specifier.length > 0 && !specifier.includes('/')
}

/** 上游 clientExportOf(index.ts:224-234)接受的两种形状。 */
function clientExportProblem(exportsField) {
  if (typeof exportsField !== 'object' || exportsField === null) return 'missing'
  const client = exportsField['./client']
  if (client === undefined) return 'missing'
  if (typeof client === 'string') return undefined
  if (typeof client === 'object' && client !== null && typeof client.default === 'string') return undefined
  return 'malformed'
}

/**
 * 对一份清单执行 M12 判定。
 * 没有 dsh.client 的插件(绝大多数)直接返回空,不产生任何噪音。
 * @param {object} manifest - package.json / registry 版本文档。
 * @returns {Array<{level: 'error'|'warning', rule: string, message: string}>}
 */
export function checkClientDeclaration(manifest) {
  const findings = []
  const error = (message) => findings.push({ level: 'error', rule: 'M12-client', message })
  const warning = (message) => findings.push({ level: 'warning', rule: 'M12-client', message })

  const declaration = manifest.dsh?.client
  if (declaration === undefined) return findings

  if (typeof declaration !== 'object' || declaration === null || Array.isArray(declaration)) {
    error('dsh.client 不是对象;宿主解析到非对象声明会同步抛错,'
      + '连带让整个 client-modules 失败(同宿主其他插件的前端模块一起挂)')
    return findings
  }

  if (typeof declaration.platform !== 'string') {
    error('dsh.client.platform 缺失或不是字符串;宿主 parseDshClient 会同步抛错')
  } else if (declaration.platform !== 'web') {
    warning(`dsh.client.platform 是 "${declaration.platform}";`
      + '宿主只把 platform === "web" 的行当作前端模块,其他取值等于这段声明不会生效')
  }

  for (const field of ['inject', 'external']) {
    const value = declaration[field]
    if (value === undefined) continue
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
      error(`dsh.client.${field} 必须是字符串数组`)
      continue
    }
    if (field !== 'external') continue
    const packageName = typeof manifest.name === 'string' ? manifest.name : ''
    for (const item of value) {
      if (!isExactPackageSpecifier(item)) {
        error(`dsh.client.external 的 "${item}" 不是精确的裸包名;`
          + 'scope 包必须恰好两段(@scope/name),非 scope 包不能含 "/"')
      } else if (packageName !== '' && item === packageName) {
        error(`dsh.client.external 不能包含本包自身 "${item}";`
          + '宿主会判定这一行"请求了自己提供的模块"并抛错')
      }
    }
  }

  if (declaration.immediately !== undefined && typeof declaration.immediately !== 'boolean') {
    error('dsh.client.immediately 必须是布尔值')
  }

  const exportProblem = clientExportProblem(manifest.exports)
  if (exportProblem === 'missing') {
    error('声明了 dsh.client 却没有 exports["./client"];'
      + '宿主会以 "declares dsh.client but exports no ./client bundle" 抛错')
  } else if (exportProblem === 'malformed') {
    error('exports["./client"] 必须是字符串,或带字符串 default 的对象')
  }

  return findings
}
