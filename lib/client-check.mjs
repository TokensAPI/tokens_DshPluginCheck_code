/* ============================================================
 * M12-client:dsh.client 声明
 * ============================================================
 * 为什么这条是 error 而不是"你自己的事":宿主的 client-modules 在
 * **构造期同步**解析所有已加载包的 dsh.client(parseDshClient,现在在
 * packages/client/modules/src/client/manifest.ts:161-181),一份声明写坏
 * 会抛出并让整个 client-modules fiber FAIL —— 受害的不止这个插件,而是
 * 同一宿主里所有需要前端模块的插件。
 *
 * 字段全集就是 { platform, inject?, external?, immediately? }
 * (DshClientManifest,packages/util/package-manifest/src/types.ts:81-94),
 * 未知键被忽略。
 * ============================================================ */

/**
 * 上游 exactPackageSpecifier(client/manifest.ts:189-195):只接受精确的裸
 * 包根,scope 包恰好两段、非 scope 包不含 "/"。2.0.17 起非 scope 分支还多
 * 排掉了含 ":" 的写法(cordis: 内建、node: 模块、URL),这里跟着照抄。
 * @param {string} specifier
 * @returns {boolean}
 */
function isExactPackageSpecifier(specifier) {
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/')
    return parts.length === 2 && parts.every(Boolean)
  }
  return specifier.length > 0 && !specifier.includes('/') && !specifier.includes(':')
}

/** 上游 stripClientSuffix(client/manifest.ts:206-208),逐字照抄。 */
function stripClientSuffix(specifier) {
  return specifier.endsWith('/client') ? specifier.slice(0, -'/client'.length) : specifier
}

/** 上游 clientExportOf(index.ts:195-205)接受的两种形状。 */
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
      // 上游 orderByModuleGraph(index.ts:490-530)写明 external 有两种:
      // 它命名的那个包行(`<包名>/client` 是裸包名的别名,走 stripClientSuffix
      // 归一),或者静态模块表里的名字 —— 后者不加图边,我们在包外面也查不到
      // 表里有没有,所以只能提示,不能判死。照抄前这条判成了 error,等于把
      // 上游明确允许的 `<包名>/client` 和 `react-dom/client` 这类写法报成不合格。
      const root = stripClientSuffix(item)
      if (packageName !== '' && root === packageName) {
        error(`dsh.client.external 不能包含本包自身 "${item}";`
          + '宿主会判定这一行"请求了自己提供的模块"并抛错')
      } else if (!isExactPackageSpecifier(root)) {
        warning(`dsh.client.external 的 "${item}" 不是某个包行(裸包名或 "<包名>/client");`
          + '宿主只会把它当作静态模块表里的名字、不加依赖边,表里没有就会在运行时请求失败')
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
