# dsh-balance-usage-dock

[![CI](https://github.com/YusenZhang0601/dsh-balance-usage-dock/actions/workflows/ci.yml/badge.svg)](https://github.com/YusenZhang0601/dsh-balance-usage-dock/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）零依赖本地插件：在**输入框底部统计行**新增一格，显示**当前所选供应商**的余额，以及本会话（含其派生/调用的全部子智能体会话）的累计估算花费；点击打开面板，查看各厂商余额/额度/自报花费、90 天热力图与本会话的**分模型花费**。

- 纯本地：只注册一个只读的回环/同源 HTTP 路由；无遥测、无浏览器存储、不持久化凭据。
- **不内置任何单价表**：价格在运行时从 Provider 自己的价格接口、用户额外目录、DeepSeek 官方价格页、`models.dev` 按优先级获取；界面始终标注来源与置信度，取不到就只显示 tokens。
- 不做悬浮挂件、不做侧边栏常驻、不打包美术资源。

## v0.2 功能

- **跟随模型选择**：Dock 的余额目标跟随 `ctx.modelDirectories` 的模型选择目录；切换供应商/模型后余额立即切换，而会话花费继续累计，**切换不会清零**。
- **累计的全轮次树花费**：`tokens`/`costs`/`byModel` 覆盖本会话及全部可达子智能体会话；fork 继承的事件（`seq < inheritedEventCount`）会被跳过，避免父子重复计费；`mixedProviders` 标记跨供应商累计，`pricingConfidence` 给出所用价格的最弱置信度（`exact | family | community | override | none`）。
- **多币种分别展示**：CNY 与 USD 分别汇总，不做汇率换算、不跨币种相加。
- **峰谷计价**：官方 CNY 价格按 IANA `peakTimeZone`（默认 `Asia/Shanghai`）判断高峰，可配置 `peakWindows`、`peakWeekdays` 与 `holidays`（法定节假日按全天空闲）。
- **更稳的传输层**：有限重试、单供应商 `peerTimeoutMs`、整请求 `requestTimeoutMs`、`retryable`/`stale`/`degraded` 标记，`refresh=1` 可绕过缓存。
- **16 类厂商适配器**：DeepSeek（API Key 与桌面账号）、Moonshot、OpenRouter、xAI、Vercel AI Gateway、Z.ai、MiniMax、Kimi Coding、OpenCode、OpenAI/Anthropic 管理端花费、GitHub Copilot、OpenAI Codex OAuth、火山方舟 Agent/Coding Plan。详见 [docs/providers.md](docs/providers.md)。
- **90 天热力图**：按 `statsTimeZone` 分日、限制扫描会话数，并报告 `scannedSessions/failedSessions/truncated`。
- **可安全粘贴的诊断**：`?kind=diagnostics` 输出脱敏快照，不含 token/凭据值、账号资料或会话内容。

## 环境要求

- 带浏览器 `webServer` 服务的 DSH 桌面端（插件只注册一个路由）。
- 宿主 Node.js ≥ 22（推荐 24）。无 npm 依赖、无构建步骤；浏览器端只有 `client.js` 一个模块加载器 bundle。

## 安装

请通过宿主安装，**不要**手工修改 profile 的 `package.json` 或 `cordis.patch.yml`。

### 从 GitHub 安装（推荐）

在会话里让 DSH Agent 安装：

> 用 `plugin_manager`（`install_bundle`）安装 `github:YusenZhang0601/dsh-balance-usage-dock`，若被禁用则启用，然后验证加载成功。

`dsh web` profile 的 CLI 等价写法：

```bash
dsh plugin --profile web add github:YusenZhang0601/dsh-balance-usage-dock
```

### 从本地目录安装（开发）

> 用 `plugin_manager`（`install_bundle`）安装本地插件 `<绝对路径>/dsh-balance-usage-dock`，若被禁用则启用，然后验证加载成功。

### 安装之后

`plugin_manager` 会提示是否需要重启。之后：

1. `cordis_inspect_query`（Client → `Slots`）应能看到 `conversation.composer.dock` 下的 `balance-usage`，以及 `shell.overlay` 下的 `balance-usage-panel`。
2. 刷新浏览器页面；若安装返回 `restart-required`，请完全退出桌面端（含托盘）后重开。

### 从 npm 安装

发布之后可 `dsh plugin --profile web add dsh-balance-usage-dock`，或用 `plugin_manager` 指定包名。发布由手动工作流 [`.github/workflows/publish.yml`](.github/workflows/publish.yml) 完成（需要仓库 secret `NPM_TOKEN`）。

## 配置（v0.2）

全部可选，写在插件行的 `config`（通常是 `cordis.patch.yml`），数值会被收敛到允许区间。完整说明与示例见 [docs/configuration.md](docs/configuration.md)。

| 字段 | 默认 | 说明 |
|---|---|---|
| `refreshSeconds` | `60` | 旧版轮询提示，保留兼容（5–86400）。 |
| `statsDays` | `90` | 热力图天数（1–365），同时作为 `kind=config` 的 `heatmapDays`。 |
| `statsSessionLimit` | `200` | 每次统计扫描的最大会话数（1–5000）。 |
| `statsCacheSec` | `300` | `kind=stats` 服务端缓存（0–86400）。 |
| `peakTimeZone` | `Asia/Shanghai` | 高峰时段所用的 IANA 时区。 |
| `statsTimeZone` | 宿主系统时区（`null`） | 按天分桶的 IANA 时区；`null` 表示宿主时区。 |
| `holidays` | `[]` | `YYYY-MM-DD` 日期，按 `peakTimeZone` 全天空闲计价。 |
| `peakWindows` | `09–12, 14–18` | 高峰墙钟时段（`peakTimeZone`）。 |
| `peakWeekdays` | `[1,2,3,4,5]` | 高峰星期（0=周日）。 |
| `pricingSources` | `provider-catalog, official-page, models.dev` | 启用的价格来源及优先级。 |
| `officialPricingUrls` | DeepSeek 中/英价格页 | 官方价格页候选（首个可用表格生效）。 |
| `modelsDevUrl` | `https://models.dev/api.json` | 社区兜底目录（USD，可能滞后）。 |
| `pricingTtlSec` | `43200` | 价格缓存时长（3600–604800）。 |
| `priceOverrides` | `{}` | 手动价格覆盖，优先级最高。 |
| `modelAliases` | `{}` | `{ "归一化模型 id": "目录模型 id" }`，用于价格匹配。 |
| `extraPriceCatalogs` | `[]` | `[{ url, format: openrouter\|newapi\|modelsdev, currency, ttlSec, matchPrefix? }]`。 |
| `providers` | `[]` | 手动路由 `{ id, kind, baseURL, apiKeyEnv, displayName, enabled }`。 |
| `trustedHosts` | `[]` | 额外允许的 `Host`（默认仅回环）。 |
| `requestTimeoutMs` | `15000` | 整个请求的截止时间（1000–120000）。 |
| `peerTimeoutMs` | `12000` | `overview` 中单个供应商余额查询预算。 |
| `overviewCacheSec` | `15` | `kind=overview` 服务端缓存。 |
| `sessionCacheSec` | `1` | `kind=session` 按会话 id 的微缓存。 |
| `warmup` / `warmupDelayMs` | `true` / `1500` | 启动后尽力预热 overview/stats。 |
| `diagnosticsErrors` | `20` | 诊断错误环形缓冲大小。 |
| `clientRefresh` | `{overviewSec:60,sessionRunningSec:3,sessionIdleSec:15,statsSec:60}` | 浏览器刷新 TTL（经 `kind=config` 下发）。 |
| `clientRetry` | `{maxRetries:2,requestTimeoutMs:20000}` | 浏览器 GET 重试策略（经 `kind=config` 下发）。 |

### 示例

```yaml
- insert:
    - id: balance-usage-dock
      name: dsh-balance-usage-dock
      config:
        peakTimeZone: Asia/Shanghai
        statsTimeZone: Asia/Shanghai
        holidays: ["2026-10-01", "2026-10-02"]
        priceOverrides:
          "my-relay/deepseek-v4.1-flash":
            currency: CNY
            cacheHit: { idle: 0.02, peak: 0.04 }
            cacheMiss: { idle: 1, peak: 2 }
            output: { idle: 4, peak: 8 }
        modelAliases:
          "my-relay/fast": "deepseek-flash"
        trustedHosts: ["127.0.0.1:55976"]
```

## HTTP 契约（摘要）

权威冻结契约见 [docs/contract-v2.md](docs/contract-v2.md)，实现说明见 [docs/architecture.md](docs/architecture.md)。

- 唯一路由：`GET /balance-usage-api?kind=<kind>`，仅 `GET`、仅回环/同源，响应 `cache-control: no-store`。
- 成功：`{ "ok": true, "data": … }`；失败：`{ "ok": false, "error": { "code", "message", "retryable" } }`。
  `bad-request` → 400（网关拒绝可能是 403/405），`unavailable` → 503/504，`internal` → 500。
- kind：`config`、`overview`、`session&session=<id>`、`stats`（`refresh=1` 绕过缓存）、`pricing`
  （`refresh=1` 重新抓取价格源）、`diagnostics`，以及用于探活的 `ping`。
- `overview` 新增 `degraded` 与单供应商 `retryable`/`fetchedAt`/`stale`；`session` 新增
  `byModel`/`mixedProviders`/`pricingConfidence`；`stats` 的每日 bucket 含 `costs`，并返回
  `pricingConfidence`/`scannedSessions`/`failedSessions`/`truncated`。

## 价格与花费规则

- 价格优先级：`priceOverrides` → Provider 价格目录或 `extraPriceCatalogs` → DeepSeek 官方价格页 → `models.dev`。每条价格都带 `source` 与 `confidence`；`none` 表示无价格来源，此时只显示 tokens。
- 官方价格为 CNY/百万 tokens，空闲/高峰两档；解析后严格校验 `高峰 = 2 × 空闲`，不满足时降级并保留旧缓存，而不是相信半解析的表。
- token 来自 `assistant/message.data.usage`；请求时间取同一 `${turn}/${step}` 的 `step/start`（否则用事件时间）；供应商/模型来自 `request/header` 与 `request/context` 的切换（后发生者生效）。
- 花费 = `(输入×未命中价 + cacheRead×命中价 + cacheWrite×写价 + output×输出价) / 1e6`，金额为**估算**，不是官方账单。
- 币种不换算、不跨币种相加；`byModel` 同币种金额之和与 `costs` 一致（保留 6 位小数）。

## 隐私

- 浏览器端不持久化：不使用 `localStorage`/`sessionStorage`/`indexedDB`/cookie，不写文件；只在内存模块 store 中保存数据。
- 凭据只在每次请求时经 `ctx.credentials`（或 `apiKeyEnv` 环境变量兜底）解析，不缓存、不写日志、不回显；响应不含凭据值、账号资料或会话内容。
- 出站请求仅限你启用的价格源和已配置的供应商。完整出站主机列表与诊断脱敏规则见 [docs/privacy.md](docs/privacy.md)。

## 已知限制

- **金额是估算**：按本地会话事件 × 运行时价格计算，不建模供应商账单、折扣或轮中调价。
- **官方价格页解析依赖结构**：页面结构变化时会降级（警告 + 上次缓存）；可用 `priceOverrides` 或 `extraPriceCatalogs` 兜底。
- `models.dev` 是社区目录，可能滞后，界面标注为 `community`。
- 第三方中转通常没有余额/价格接口：余额显示 `—`，花费需要 `priceOverrides` / `extraPriceCatalogs`。
- 节假日为静态 `holidays` 列表，不会自动导入日历。
- 子智能体合并依赖 `subagents` 服务；服务缺失时只显示父会话（`subagent.unavailable: true`）。
- 视觉层通过 slot 注册与接口数据验证；本仓库没有浏览器自动化测试。
- `openai-codex`、火山方舟与 GitHub Copilot 适配器为夹具验证，未做真机账号联调。

## 开发与测试

```bash
# 完整测试（仅夹具，无网络、无外部依赖）
node --test test/*.test.mjs

# 通过 npm 脚本运行
npm test

# 语法检查全部模块
for f in index.js client.js lib/*.js test/*.test.mjs scripts/check.mjs; do node --check "$f" || exit 1; done

# 可选的静态一致性检查（文件头、禁用 API、语言包键一致）
node scripts/check.mjs
```

测试文件：`test/pricing.test.mjs`、`test/usage.test.mjs`、`test/http.test.mjs`、`test/privacy.test.mjs`、
`test/providers.test.mjs`；夹具在 `test/fixtures/`，其中官方价格表为裁剪快照（文件内记录了来源 URL 与日期）。
CI 覆盖 Node 22/24，见 `.github/workflows/ci.yml`。

贡献指南：[CONTRIBUTING.md](CONTRIBUTING.md)。安全问题：[SECURITY.md](SECURITY.md)。版本记录：[CHANGELOG.md](CHANGELOG.md)。

## 许可与致谢

MIT，见 [LICENSE](LICENSE)。部分适配器覆盖、会话折叠与热力图呈现参考了 [ATTRIBUTION.md](ATTRIBUTION.md) 中列出的 MIT 项目。DeepSeek 价格在运行时从官方价格页读取，仓库内不复制价格表。
