# dsh-plugin-check

TokensCowork / DSH 插件合格性体检。给所有插件开发者的统一标准:一条命令,当场知道你的插件**能否安全装入宿主、会不会把用户的 Cowork 搞崩**。同一套规则同时用于:开发者本地自查、插件仓库 CI、插件市场上架门禁。

## 用法

```bash
# 在插件目录里
npx @tokensapi/dsh-plugin-check

# 指定目标运行时(启用兼容范围判定;当前产品运行时版本见市场公告)
npx @tokensapi/dsh-plugin-check --runtime 0.1.3-alpha.1

# 只跑离线清单体检(秒级,无网络)
npx @tokensapi/dsh-plugin-check --skip-smoke

# 机器可读输出(CI / 市场门禁)
npx @tokensapi/dsh-plugin-check --json

# 体检一个已发布的 npm 包(市场上架审核用)
npx @tokensapi/dsh-plugin-check --package @scope/name@1.2.3 --runtime 0.1.3-alpha.1
```

退出码:`0` 合格,`1` 存在 error(`--strict` 时 warning 也计入)。冒烟失败时加 `--keep-workspace` 保留临时工作区排查。

## 体检分两个阶段

**阶段① 清单体检**(纯静态、离线、秒级):检查 package.json 与 cordis 补丁的声明是否合规。
**阶段② 隔离启动冒烟**(联网、约 1–3 分钟):在临时工作区按你声明的 peer 范围装出真实运行时,然后逐补丁行做真实网关启动时做的事——解析入口 → `import` → `new Context()` + `ctx.plugin()` 应用。三段都过,你的插件就不会以"装上即崩"的方式杀死用户的 Cowork。全程 `--ignore-scripts`,你的代码只在一次性子进程里运行,超时即杀。

清单存在 error 时冒烟不执行——先修再跑。跳过冒烟时输出会说明**真实原因**(清单有 error / 补丁没有可用行 / 读不到 package.json / `--skip-smoke`),不会拿一个笼统的理由搪塞。

## 规则清单

每条规则都对应一种真实发生过的宿主故障。**每条规则在判什么、为什么是这个级别、锚在上游哪一段代码,完整写在 [`docs/CHECKS.md`](docs/CHECKS.md)。**

| 规则 | 级别 | 内容 | 拦的是什么事故 |
|---|---|---|---|
| C0-contract | warning | `--runtime` 不在本工具核对过的版本里时提示 | 拿过时的上游口径当结论 |
| M1-manifest | error/warning | package.json 合法,name/version 齐全且包名满足市场约束(不在上游黑名单里);预发布版本给出上架提示 | 无法入库 |
| M2-lifecycle | warning | 不要声明 `preinstall/install/postinstall/prepare`(构建用 `prepack`) | 受控安装未加 `--ignore-scripts`:脚本要么在用户机器上执行任意代码,要么被包管理器默认策略拦下、脚本产物缺失导致装完即坏 |
| M3-core-peer | error | `@deepseek-ai/cordis*`、`@deepseek-ai/dsh*` 只能是 peerDependencies | 双内核实例 → Symbol 不等 → 服务注册对不上 → **Cowork 启动失败** |
| M4-bundle | error | `dsh.bundle.patch` 必填、文件存在、能解析出插件行,且路径形状满足上游 `safeBundlePatch`(相对路径、无反斜杠、无 `..`、段内无冒号、≤512 字节) | 宿主无法把插件挂进加载树;形状不合规则受控安装验证器直接拒绝,用户端只剩手动命令 |
| M5-row-scope | error | 补丁行只能指向本包(或其子路径) | 插件行劫持挂载其他包 |
| M6-engine | error/warning | `dsh.engine` 声明目标运行时 SemVer 范围;与 `--runtime` 不相交为 error(未声明为 warning——上游目前不强制读取此字段) | 装进不适配的宿主版本 |
| M7-peer-range | error/warning | 核心 peer(`@deepseek-ai/cordis*`、`@deepseek-ai/dsh*`)的范围必须合法;`dsh-*` 的范围应包含目标运行时 | 范围写坏则受控安装装不出来;不含目标运行时则宿主升级后接口错配 |
| M8-node-engines | warning | 建议声明 `engines.node`,且要与宿主的 `^22.19.0 \|\| >=24.0.0` 有交集 | 语法/API 不可用;无交集则安装阶段报 unsupported engine |
| M9-license | warning | 建议声明 license | 分发合规 |
| M10-secrets | error/warning | 发布内容不得包含 `.env`、私钥等凭据样式文件 | 凭据泄露 |
| M11-row-identity | error | 补丁行 `id` 同层不得重复、不得含 `:`、不得占用宿主保留 id(`settings`、`web-runtime` 等) | **重复 id 会让用户整个 Desktop 起不来**;而市场安装装完从不重新解析补丁、也没有回滚,一路绿灯装上、下次开机才炸 |
| M12-client | error/warning | 声明 `dsh.client` 时,字段形状与 `exports["./client"]` 必须成立 | 宿主构造期同步解析,一份写坏会让整个 client-modules 失败——**同宿主其他插件的前端模块一起挂** |
| M13-tests | warning | 仓库要有可跑的测试:`scripts.test` 非占位,且目录里确有测试文件 | 没有测试的仓库,改动是否弄坏了加载或清单只能靠断言;插件的失败面在宿主进程里,用户先于你发现 |
| S1-pack | error | `npm pack --ignore-scripts` 必须成功 | 包本身发布不出来 |
| S2-install | error/warning | 按你声明的依赖必须装得出来;宿主内核包(`@deepseek-ai/*`)的内部版本在公开源取不到时降级为 warning 并跳过冒烟 | 用户受控安装会同样失败 |
| S3/S4-apply | error | 每个补丁行:入口可解析、`import` 不抛、`ctx.plugin()` 应用不抛(声明 `inject` 等待服务注入属正常,不算失败) | **启动链击穿**——一行 import 失败会拖死整棵插件树 |

## 适配的上游版本(契约基线)

规则不是写法偏好,是照着**某个上游版本的真实行为**写下的判定。上游一变,这个检查器
可能要改,也可能完全不用改 —— 所以基线是机器可读的,写在 `lib/contract.mjs`,并跟着
每次体检结果一起输出:CLI 抬头一行、`--json` 的 `contract` 字段、会话内工具结果的
`contract` 字段。

```
契约基线 2026-09-10 · desktop 2.0.5 / market 0.1.0-dev.0 · 已核对运行时 0.1.0-rc.8、0.1.3-alpha.1
```

`--runtime` 传了核对范围之外的版本,会多一条 **C0-contract** warning,明说"这个版本
没核对过,结论可能过时或过严",不假装照样有效。

每条规则锚在上游哪个文件/符号、上游升级后逐条怎么复核,见
[`docs/CHECKS.md` §5](docs/CHECKS.md)。

## 会话内体检(装进 Cowork)

本包同时是一个 Cowork 插件。装进宿主后会注册 `plugin_check` 工具,在会话里直接问"这个插件能装吗",不必记命令行:

```
# 正在开发、还没发布的插件 —— 直接读工作区
plugin_check(path="D:/code/my-plugin")

# 已经发布到 npm 的包
plugin_check(package="@scope/name", version="1.2.3")
```

**发版前用 `path`**:读的是你本地的 `package.json` 与 `cordis.patch.yml`,不需要先 `npm publish`,改一行问一次都行。已发布的包用 `package`,跑的是**清单规则 + 包内补丁行检查**:工具会把已发布的 tarball 取下来,解出 `cordis.patch.yml` 真读补丁行——只看 registry 清单会漏掉"补丁行 `name` 写成 cordis 插件名而不是 npm 包名"这类装上即让整棵插件树崩溃的缺陷。取不到包时如实标注补丁未检查(warning),不会因网络问题把插件判成不合格。

隔离启动冒烟要装依赖、起子进程,不在宿主进程里执行;完整体检仍走 CLI 或 Plugin Check workflow。

## `dsh.engine` 字段

在 package.json 声明你适配的 DSH 运行时范围:

```json
{
  "dsh": {
    "engine": ">=0.1.3-alpha.1 <0.2.0",
    "bundle": { "patch": "./cordis.patch.yml" }
  }
}
```

这个字段目前**没有被上游强制读取**(2026-09-10 核对),它的作用是让体检能判断你与目标
运行时是否相容:声明了,`--runtime` 越出范围时会直接报 error;不声明,这一层就判不了。

## CI 集成示例

```yaml
# .github/workflows/check.yml
- run: npx @tokensapi/dsh-plugin-check --runtime 0.1.3-alpha.1 --strict
```

## 上架流程中的位置

1. 开发者:发布 npm 版本前本地跑体检,全绿再发。
2. 管理员:在仓库 Actions 的 **Plugin Check** workflow 填「包名@版本」手动触发,体检报告生成在该次运行的 Summary。
3. 上架:后台 publish 对话框把这次运行的链接填入「检查记录链接」——链接的红/绿即审核证据,`reviewed_version` 随上架落库。存在 error 的版本不满足上架条件。
