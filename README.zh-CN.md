# pi-opencode-session-pool

一个 pi 扩展：把每个会话的 OpenCode 请求固定到一个**预先验证过的快路由
`x-opencode-session` id** 上。

OpenCode 网关会按这个请求头做一致性哈希，选中某个上游分片，并且**强粘滞**。
随机生成的新 id 里大约一半会落到一个过载的转发池上——`server-timing` 里
`upstream;dur` 是 10–43 秒而不是 1 秒左右，而且这个会话会一直慢下去。pi 每个新
会话都会生成随机 id，所以每次开新会话都是掷硬币。

本扩展的做法：先用 1-token 的真实探测请求筛选 id，把快的放进持久化池子，然后在
请求发出前改写请求头。

```
之前：新会话 -> 随机 uuid -> 50% 概率首 token 等 30 秒
之后：新会话 -> 池子里的快 id -> 首 token 约 1 秒
```

## 实测依据

2026-11-07 在 `https://opencode.ai/inference/go/openai/v1` 上，模型
`deepseek-v4.1-flash`，同一网络路径（已验证代理干净），同一请求体：

| session id | 第 1 次 | 第 2 次 | 第 3 次 | 响应 `id` |
| --- | ---: | ---: | ---: | --- |
| `stk-75a69…` | 1 874 ms | 2 136 ms | 1 728 ms | `gw-…` |
| `stk-c03ad…` | 1 616 ms | 1 967 ms | 3 034 ms | `gw-…` |
| `stk-bd381…` | 2 320 ms | 1 554 ms | 1 718 ms | `gw-…` |
| `stk-80b39…` | **41 640 ms** | **40 570 ms** | **32 247 ms** | `chatcmpl-…` |
| `stk-f9a5e…` | **43 287 ms** | **40 952 ms** | **33 514 ms** | `chatcmpl-…` |
| `stk-2f3bf…` | **34 427 ms** | **38 305 ms** | **25 536 ms** | `chatcmpl-…` |

12 分钟后复测，同一批 id 仍在各自的快/慢分组里，说明映射是确定性且长期有效的。
关键信号是响应头：

```
server-timing: gateway;dur=10, upstream;dur=1447, total;dur=1498
```

`gateway;dur` 正常从不超过 50ms，延迟全在 `upstream`。快 id 的响应体 `id` 前缀是
`gw-`，慢的是 `chatcmpl-…`。两个信号都用于探测分类。

## 工作方式

| 阶段 | 钩子 | 行为 |
| --- | --- | --- |
| 启动 | `session_start` | 为会话绑定池中 id（受 `PI_OCPOOL_STARTUP_BUDGET_MS` 约束） |
| 请求 | `before_provider_headers` | 覆盖 `x-opencode-session`；会话中途换模型时惰性绑定 |
| 响应 | `after_provider_response` | 读 `server-timing`，刷新统计、隔离变慢的 id |
| 后台 | 定时器 | 重新验证过期条目、把池子补满到 `PI_OCPOOL_SIZE` |
| 退出 | `session_shutdown` | `quit` 时停掉定时器（reload 保留进程级热池） |

获取顺序：

1. **粘滞绑定** —— `piSessionId :: provider :: model` 已有可用 id：零探测；`--continue`
   恢复会话也能保住 prompt cache。
2. **池中 id** —— 同 provider+model 下新鲜且未被占用的条目：零探测；该 id 会被
   “租”给这个会话，两个并发会话不会共用同一条上游分片。
3. **探测** —— 依次生成 id、各发一个 1-token 请求，直到命中快的，受调用预算限制。
   候选约 50% 是快的，通常 1–2 次、耗时 1–3 秒，每个会话仅一次。
4. **放弃** —— 预算内没找到快 id：不改请求头，行为与没装扩展完全一致。

所有失败路径都安全降级：缺凭证、状态文件损坏、网络错误、429 限流、20 秒卡顿，都会
回落到 pi 自己的 id，绝不向请求链路抛错。状态文件写失败也不影响内存中的路由。

## 安装

```bash
# 本地目录（原地加载，不复制）
pi install ./repo/pi-opencode-session-pool

# 已发布后也可以
pi install git:github.com/<you>/pi-opencode-session-pool@v0.1.0
```

`pi list` 可查看，`/reload` 可热加载。

## 配置

全部为环境变量（与同仓库的 `pi-provider-gzip` 一致）。

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `PI_OCPOOL` | `1` | 总开关，`0` 完全关闭 |
| `PI_OCPOOL_SIZE` | `3` | 每个 provider+model 保留的快 id 数（1–16） |
| `PI_OCPOOL_TTL_MS` | `1800000` | 超过该时长的条目重新验证 |
| `PI_OCPOOL_MAX_UPSTREAM_MS` | `2500` | 探测时判定“快”的 upstream 上限 |
| `PI_OCPOOL_PROBE_TIMEOUT_MS` | `10000` | 单个探测的超时；慢 id 远不止这么久 |
| `PI_OCPOOL_STARTUP_BUDGET_MS` | `6000` | `session_start` 最多阻塞多久；`0` 表示不阻塞 |
| `PI_OCPOOL_REQUEST_BUDGET_MS` | `4000` | 首个请求最多阻塞多久 |
| `PI_OCPOOL_REFRESH_INTERVAL_MS` | `300000` | 后台刷新间隔，`0` 关闭定时器 |
| `PI_OCPOOL_MIN_PROBE_INTERVAL_MS` | `750` | 两次探测的最小间隔 |
| `PI_OCPOOL_LEASE_TTL_MS` | `28800000` | 绑定空闲多久后释放占用的 id |
| `PI_OCPOOL_QUARANTINE_FAILURES` | `2` | 真实请求连续几次“变慢”后隔离 |
| `PI_OCPOOL_DEGRADE_MS` | `6000` | 真实请求达到该延迟记一次“变慢” |
| `PI_OCPOOL_QUARANTINE_MS` | `8000` | 单次超过该延迟直接隔离 |
| `PI_OCPOOL_MAX_BINDINGS` | `256` | 绑定表上限 |
| `PI_OCPOOL_REQUIRE_GATEWAY_ID` | `1` | 要求响应 `id` 以 `gw-` 开头 |
| `PI_OCPOOL_STATE_PATH` | `~/.pi/opencode-session-pool.json` | 状态文件路径 |
| `PI_OCPOOL_DEBUG` | `0` | 输出绑定/探测/隔离决策到 stderr |

示例：

```bash
PI_OCPOOL_DEBUG=1 PI_OCPOOL_SIZE=4 pi -e ./repo/pi-opencode-session-pool
```

## 查看与预热

```bash
npm run pool:inspect          # 只读打印状态文件
npm run pool:live             # 真实探测 2 个候选并打印耗时
npm run pool:live -- --seed   # 探测并把快 id 写入池子
```

`pool:live` 使用 `OPENCODE_API_KEY` 或 `~/.pi/agent/auth.json` 里的 `opencode` 条目。

## 范围与限制

- 只处理 `openai-completions` 传输的模型；OpenCode 的 `anthropic-messages` /
  `google-generative-ai` 模型不会被改动（只有 OpenAI-completions 传输会把请求头
  和 `server-timing` 暴露给扩展）。
- 路由快慢是**按模型**的：条目按 provider+model 隔离，换模型会另建条目。
- 池子不能让健康线路更快，只是避开坏的那条；如果所有上游都慢，探测失败就回落到
  pi 原生的 session id。
- 探测是真实的 1-token 请求。默认配置下每个模型每小时不超过约 10 次；OpenCode 会
  监控滥用流量，不要用激进的 best-of-N 探测。

## 开发

```bash
npm install
npm run check        # 类型检查 + 56 个单测
npm run pool:live    # 可选：真实网关冒烟测试
```

细节见 [`docs/design.md`](docs/design.md)（状态文件结构、算法、失败模式）与
[`CHANGELOG.md`](CHANGELOG.md)。

## 许可证

MIT
