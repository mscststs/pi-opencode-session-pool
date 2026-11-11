# pi-opencode-session-pool

一个 pi 扩展：把每个会话的 OpenCode 请求固定到一个**预先验证过的
`x-opencode-session` id** 上；并且在 2026-11-11 网关变更之后，**绝不让路由验证给
当前这一轮增加延迟**。

它最初是为 2026-11-07 的网关写的：网关按该请求头做一致性哈希，选中某个上游分片并
**强粘滞**；随机新 id 里约一半会落到过载转发池，`upstream;dur` 是 10–43 秒而不是
1 秒左右，而且整个会话一直慢。

**2026-11-11** OpenCode 改了网关：同一个会话的请求会在多个 worker 之间负载均衡，
快响应也不再以 `gw-` 开头。扩展仍然保留“机会式池子”，但默认把探测完全移出请求
路径。见[网关变更](#网关变更2026-11-11)。

## 安装

```bash
# 从 npm 安装
pi install npm:@mscststs/pi-opencode-session-pool

# 或者从 git 安装
pi install git:github.com/mscststs/pi-opencode-session-pool

# 只在本次运行试用，不写入配置
pi -e npm:@mscststs/pi-opencode-session-pool
```

- npm：<https://www.npmjs.com/package/@mscststs/pi-opencode-session-pool>
- 源码：<https://github.com/mscststs/pi-opencode-session-pool>

本地源码目录也可以直接 `pi install ~/repo/pi-opencode-session-pool` 原地加载（不复制）。
`pi list` 可查看已安装包，`/reload` 可热加载。

本扩展的做法：先用 1-token 的真实探测请求筛选 id，把快的放进持久化池子，然后在
请求发出前改写请求头。

```
之前：新会话 -> 随机 uuid -> 50% 概率首 token 等 30 秒
之后：新会话 -> 取走一个已验证 spare -> 首 token 约 1 秒
```

## 实测依据

### 2026-11-07：强粘滞分片

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

`gateway;dur` 正常从不超过 50ms，延迟全在 `upstream`。当时快 id 的响应体 `id`
前缀是 `gw-`，慢的是 `chatcmpl-…`；这个前缀启发式现在已经退役。

### 网关变更（2026-11-11）

2026-11-11 对同一个 URL 和模型复测：

| 检查项 | 观察结果 |
| --- | --- |
| 同一个 id 连续 5 次 | `1 435`–`5 138 ms`；每次响应体 id 都不同（`chatcmpl-…`） |
| 同一个 id 再测 4 次 | `3 574`–`6 309 ms`；出现 4 个不同的 `gw-<worker>-…` id |
| 新随机 id | `388 ms`–`7 098 ms`；快响应既可能是 `chatcmpl-…`，也可能是纯 hex id |
| 用旧分类器跑 9 次探测 | 9 个健康的 `448`–`1 585 ms` 响应全部被判为 `gateway-id-mismatch` |
| 旧默认值下跑一次 `pi -p` | **6 秒**启动探测预算 + **4 秒**请求探测预算，之后才发真实请求（共 10.36 秒） |

最后一行就是 11.9 秒 TTFT 的来源：网关明明是健康的，扩展却按响应体 id 前缀把快候选
全部拒掉，然后在请求路径上反复探测直到预算耗尽。池子其实早就探测成功了，只是分类器
看错了信号。

修复方式：只用 `server-timing` 判快慢，并默认把两个同步探测预算都设为 `0`。池子仍然
由后台刷新补充。一个 id 现在只代表“探测那一刻的快”，不再保证粘滞分片。

用诊断脚本复现/检查：

```bash
npm run pool:diagnose
PI_OCPOOL_REQUIRE_GATEWAY_ID=1 npm run pool:diagnose   # 复现旧分类器的误判
```

如果当前配置把实际很快的响应判成慢，脚本会以非零状态退出。

## 工作方式

| 阶段 | 钩子 | 行为 |
| --- | --- | --- |
| 启动 | `session_start` | 有新鲜 spare 就取走，然后启动后台刷新；默认零探测 |
| 请求 | `before_provider_headers` | 用 binding / 新鲜 spare 覆盖 `x-opencode-session`；默认绝不同步探测 |
| 响应 | `after_provider_response` | 读 `server-timing`，刷新 binding，变慢则退役该 id |
| 后台 | 定时器 + `session_start` | 取走后 `PI_OCPOOL_REFILL_DELAY_MS` 补充一次，并每 `PI_OCPOOL_REFRESH_INTERVAL_MS` 复验过期 spare；永不阻塞当前轮 |
| 退出 | `session_shutdown` | `quit` 时停掉定时器（reload 保留进程级热池） |

池子只有三个动作——**探测 / 取走 / 补充**——不做复用：

| 动作 | 触发 | 效果 |
| --- | --- | --- |
| 探测 | 池子空，或 spare 已过期 | 发 1-token 请求；快则进入池子成为 spare |
| 取走 | 新对话开始 | spare 离开池子，永久归这个会话所有 |
| 补充 | 取走后、以及每 `PI_OCPOOL_REFRESH_INTERVAL_MS` | 把 spare 补回 `PI_OCPOOL_SIZE` |

获取顺序：

1. **恢复会话** —— `piSessionId :: provider :: model` 已经拥有一个 id：零探测，
   prompt cache 保持热。
2. **取走新鲜 spare** —— `PI_OCPOOL_TTL_MS` 内验证过的 id：零探测，并从池子移除。
3. **复验过期 spare** —— 仅在显式配置了同步探测预算时：先探测这个**原 id** 再用；
   仍然快就取走，慢了就丢掉。预算为 `0` 时不会碰过期 spare，留给后台刷新处理。
4. **探测** —— 仅在显式配置了同步探测预算时：依次生成 id、各发一个 1-token 请求，
   直到命中快的。
5. **放弃** —— 预算内没找到快 id：不改请求头，这一轮不付任何额外延迟。失败的同步
   获取会进入 60 秒冷却，避免下一条消息再付一次预算。

**一个 id 永远不会交给第二个会话。** 会话结束（空闲超过 `PI_OCPOOL_LEASE_TTL_MS`）
或被判定退化时，该 id 直接退役；想回到池子只能重新探测。这样保证「一个会话一个路由 id」，
两个会话不可能共用同一条上游分片或缓存槽。

所有失败路径都安全降级：缺凭证、状态文件损坏、网络错误、429 限流、20 秒卡顿，都会
回落到 pi 自己的 id，绝不向请求链路抛错。默认探测预算为 `0`，所以即使网关很慢或不可达，
请求路径也不会多等。状态文件写失败也不影响内存中的路由。

## 配置

全部为环境变量（与同仓库的 `pi-provider-gzip` 一致）。

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `PI_OCPOOL` | `1` | 总开关，`0` 完全关闭 |
| `PI_OCPOOL_SIZE` | `3` | 每个 provider+model 保留的**空闲**快 id 数（1–16） |
| `PI_OCPOOL_TTL_MS` | `1800000` | 超过该时长的条目重新验证 |
| `PI_OCPOOL_MAX_UPSTREAM_MS` | `2500` | 探测时判定“快”的 upstream 上限 |
| `PI_OCPOOL_PROBE_TIMEOUT_MS` | `10000` | 单个探测的超时；慢 id 远不止这么久 |
| `PI_OCPOOL_STARTUP_BUDGET_MS` | `0` | `session_start` 最多花多久探测；`0` 表示不阻塞 |
| `PI_OCPOOL_REQUEST_BUDGET_MS` | `0` | 每个请求最多花多久探测；`0` 表示不阻塞 |
| `PI_OCPOOL_PROBE_COOLDOWN_MS` | `60000` | 同步获取失败后的重试冷却时间 |
| `PI_OCPOOL_REFRESH_INTERVAL_MS` | `300000` | 后台刷新间隔，`0` 关闭定时器 |
| `PI_OCPOOL_REFILL_DELAY_MS` | `15000` | 取走 spare 后多久补充；`0` 关闭即时补充 |
| `PI_OCPOOL_MIN_PROBE_INTERVAL_MS` | `750` | 两次探测的最小间隔 |
| `PI_OCPOOL_LEASE_TTL_MS` | `28800000` | 会话空闲多久后退役其 id（永不回池） |
| `PI_OCPOOL_QUARANTINE_FAILURES` | `2` | 真实请求连续几次“变慢”后退役该 id |
| `PI_OCPOOL_DEGRADE_MS` | `6000` | 真实请求达到该延迟记一次“变慢” |
| `PI_OCPOOL_QUARANTINE_MS` | `8000` | 单次超过该延迟立即退役该 id |
| `PI_OCPOOL_MAX_BINDINGS` | `256` | 绑定表上限 |
| `PI_OCPOOL_REQUIRE_GATEWAY_ID` | `0` | 旧启发式：要求响应 `id` 以 `gw-` 开头 |
| `PI_OCPOOL_STATE_PATH` | `~/.pi/opencode-session-pool.json` | 状态文件路径 |
| `PI_OCPOOL_DEBUG` | `0` | 输出取走/探测/补充/退役决策到 stderr |

示例：

```bash
PI_OCPOOL_DEBUG=1 PI_OCPOOL_SIZE=4 pi -e ~/repo/pi-opencode-session-pool
```

## 查看与预热

```bash
npm run pool:inspect          # 查看 spare 与已占用 id（只读）
npm run pool:live             # 真实探测 2 个候选并打印耗时
npm run pool:live -- --seed   # 探测并把快 id 作为 spare 放进池子
npm run pool:diagnose         # 检查路由是否仍粘滞、分类器是否误杀快响应
```

状态文件里是两个互斥集合：`entries`（已验证、等待被取走的 spare）和
`bindings`（每个会话独占的 id）。id 只会从前者移到后者一次；会话结束后直接退役。

`pool:live` 使用 `OPENCODE_API_KEY` 或 `~/.pi/agent/auth.json` 里的 `opencode` 条目。

## 范围与限制

- 只处理 `openai-completions` 传输的模型；OpenCode 的 `anthropic-messages` /
  `google-generative-ai` 模型不会被改动（只有 OpenAI-completions 传输会把请求头
  和 `server-timing` 暴露给扩展）。
- 路由快慢是**按模型**的：条目按 provider+model 隔离，换模型会另建条目。
- 2026-11-11 之后网关按请求负载均衡，不再把会话钉在一个分片上；没有哪个 id 能保证
  快路由，所以池子是机会式的：复用探测时快的 id，其余时候不挡路。现在的价值是
  “不额外增加延迟”，而不是“钉住快分片”。
- 池子不能让健康线路更快，只是避开坏的那条；如果所有上游都慢，探测失败就回落到
  pi 原生的 session id。
- 探测是真实的 1-token 请求：大约每个新会话一次（补回它取走的 spare），另外每个
  刷新周期最多 `2 × PI_OCPOOL_SIZE` 次（默认约每小时 6 次；spare 全都新鲜时为 0）。OpenCode 会
  监控滥用流量，不要用激进的 best-of-N 探测；调大 `PI_OCPOOL_SIZE`、调小
  `PI_OCPOOL_TTL_MS` 前先想清楚额外流量。

## 开发

```bash
npm install
npm run check         # 类型检查 + 单测
npm run pool:live     # 可选：真实网关冒烟测试
npm run pool:diagnose # 可选：真实网关路由/粘滞性诊断
```

细节见 [`docs/design.md`](docs/design.md)（状态文件结构、算法、失败模式）与
[`CHANGELOG.md`](CHANGELOG.md)。

## 许可证

MIT
