# ServiceDesk v2

面向 IT 服务台的最小权限调查工作台。它把一次「桌面 403」转成可复核的证据链，再由独立审批人确认权限变更。模型通过脱敏网关读取观测并起草，执行器负责授权、到期回收和审计。默认使用内存 PGlite 和 Mock，无需凭据。

| 实测范围 | 结果 |
|---|---|
| 启用 PostgreSQL 的全量测试（含 Memory 对照） | 59/59，含跨进程 SSE 与 SIGKILL 后租约接管 |
| gpt-6.2-sol（low）v4 配对实测 | 16/16，8 对全部通过 |
| gpt-6.2-sol（low）v4 动态工作流 | 17/21（80.95%），pass@3 = 6/7，pass^3 = 5/7 |

[系统架构与排错复盘](docs/architecture.md) · [模型实测报告与逐例账本](docs/model-eval-report.md)

## 快速启动

使用 Bun 1.4.4，在项目根目录运行：

```sh
bun install --frozen-lockfile
bun run web:build
bun run start
```

## 浏览器三分钟演示

打开 http://127.0.0.1:3000 ，使用本地 Demo 权限服务和默认 Mock。内存模式重启会清空记录。

1. 选 bob，新建案例 B，点击「创建并调查」。展开会话证据的身份比对、原始 JSON 和模型出站摘要。右栏出现项目 B 只读权限草案。
2. 切到 carol，展开冻结哈希与证据后批准。切回 bob，打开原工单并追问「重新检查是否生效」。旧清单显示为历史观测。切换「模拟桌面登错账号 403」，追问「切换账号后重新检查」；切回正常项目账号后再次复查。
3. 选 alice，手动申请 **1 分钟**只读权限，carol 批准。有效期从起草时开始；到期后展开审计轨迹，查看 system 的 revoked、到期时间和回收时间。独立使用 alice 可观察最后一份有效授权被撤销。
4. 等待期间，用 bob 再提交一份申请，切换「模拟 503」并由 carol 批准，状态进入 manual_review。恢复正常后，在 bob 工单复查实际角色；carol 根据核对结果填写依据并结案。切换 guest 验证租户隔离。

## PostgreSQL 与可选模型

```sh
docker compose up -d
cp -n .env.example .env
openssl rand -base64 32
```

把生成的密钥填入 .env 的 MASK_KEY 并持续保管。bun run start 自动迁移并载入知识库。默认使用 Mock。显式设置 LIVE_MODEL=1 才会联网；默认联网模型为 OpenAI `gpt-6.2-sol`（`https://api.openai.com/v1`，推理档位默认 `low`），只需填写 `MODEL_API_KEY`，也可覆盖 `MODEL_BASE_URL`（含 /v1）与 `MODEL_ID` 调用其他支持工具调用的兼容服务。

## 接口

GET /healthz 与 GET /api/demo/scenarios 公开。其余接口优先校验由服务端使用 MASK_KEY 签发的 HMAC-SHA256 Bearer Token。演示模式也接受 x-demo-user（alice、bob、carol 或 guest）。设置 ALLOW_DEMO_AUTH=0 可关闭演示头。

| 请求 | 输入或用途 |
|---|---|
| POST /api/tickets | JSON 字段 scenario 取 A 或 B |
| GET /api/metrics | 本租户在当前 API 进程的运行、工具、Token 与任务计数 |
| GET /api/tickets | 当前用户的工单 |
| GET /api/tickets/:id | 工单、带 stale 标志的证据、变更、调查轮次 |
| POST /api/tickets/:id/runs | JSON 字段 message 与 client_request_id。同键同内容返回原 runId，内容冲突返回 409 |
| GET /api/changes | 申请人查看自己的变更，审批人查看本租户变更 |
| POST /api/changes | app、role、reason，可选 ttl_minutes（大于 0，最多 10080）；省略为长期 |
| GET /api/changes/:id/audit | 同租户申请人、受益人和审批人可读取按时间升序的审计轨迹 |
| POST /api/demo/tickets/:id/session | 自己的案例 B，session 为 normal 或 wrong_account |
| GET /api/demo/fault、POST /api/demo/fault | 查看故障状态；demo 租户可设置 fault 为 none 或 unknown_external_state |
| POST /api/changes/:id/decision | carol 提交 decision、payload_hash，可附 note；禁止自审 |
| POST /api/changes/:id/resolve | 有权限的审核人提交核对结果、payload_hash 和 note |
| GET /api/runs/:runId/events | SSE，支持 Last-Event-ID。关闭订阅后调查继续 |

PGlite 与 PostgreSQL 共用 SQL 迁移和事务。TenantScope 绑定租户，SSE 按事件通知读取持久化序号。外部权限 I/O 在事务外执行。HTTP 响应和执行器的权限请求携带 traceparent。角色清单与会话以权限终态和会话变更时间为水位线刷新，追问措辞不影响判定。

工具通过工单绑定的 scope 和 ref 读取模拟系统，所有模型请求经过同一脱敏网关。审批通过时在同一事务中创建执行任务。执行器按资源串行处理并核验授权，状态不明时进入人工核对。调查默认预算为每轮 60000 毫秒，可用 INVESTIGATION_TIMEOUT_MS 配置；服务关闭或超时会终止调查并记录 error 事件。Mock 的结论依据会话与权限证据生成，演示只覆盖预置案例。共享 PostgreSQL 和密钥的 API 实例可在负载均衡器后运行，并搭配独立 Worker。运行通知只携带类型和 runId，任一实例均可按序号续传 SSE，无需会话亲和。同工单的新调查在活跃租约期间返回 409，租约过期后可接管。

## 验证

```sh
bun run typecheck
bun test
bun run web:build
docker compose exec postgres createdb -U desk desk_test
TEST_DATABASE_URL=postgres://desk:desk@localhost:5433/desk_test bun test
```

推送到 main 或创建、更新 PR 时，CI 使用 Bun 1.4.4 和 PostgreSQL 17 运行类型检查、前端构建、全量测试和两项离线评测。

使用独立测试库，集成测试会写入测试工单。无 TEST_DATABASE_URL 时自动跳过 PostgreSQL 套件。开发和启动均直接执行 TypeScript，入口为 `bun run dev` 或 `bun run start`。

## M2 评测

`bun run eval:privacy` 输出合成样本的实体召回率、诊断字段误改率、工具参数还原率和 ruleClassificationPreservation（同一规则分类器在原始与脱敏输入上的判别保持率）。自由文本中的陌生中文姓名单独计分，当前没有姓名识别模型。

`bun run eval:paired` 通过调查引擎运行 8 对反事实夹具，校验决策代码和决定性证据引用，并检查模型出站请求中的合成敏感值。离线分数衡量确定性规则。设置 `LIVE_MODEL=1 bun run eval:paired` 可评估真实模型；`PAIR_LIMIT=2` 仅跑前两对。JSON 包含每例耗时、工具尝试数 toolAttempts、工具失败数 toolFailures、成功证据条数 evidenceRecords 与模型报告的 token 数。factCorrect、actionCorrect、policyCompliant、formatValid 分别衡量事实标签、行动建议、安全规则及探针、输出格式。strictCasePassRate 还要求正确引用证据和输出允许的结论，pairedPassRate 要求同对两例均严格通过。保存报告可运行：

```sh
mkdir -p eval-output
LIVE_MODEL=1 bun run eval:paired > eval-output/paired.json
```

双模型同场评测读取主模型的 `MODEL_*` 和对照模型的 `COMPARE_MODEL_BASE_URL`、`COMPARE_MODEL_ID`、`COMPARE_MODEL_API_KEY`。两组分别通过 MODEL_REASONING 和 COMPARE_MODEL_REASONING 设置推理档位。配置后运行 `LIVE_MODEL=1 bun run eval:compare`。两模型分别顺序完成全部 16 例，使用相同的问题、工具、网关和评分函数。终端输出汇总；脱敏逐例账本写入`eval-output/compare-live-v2.json`。执行失败或触发泄漏检测时命令返回非零。结果见 [M2 评测报告](docs/model-eval-report.md)。

`bun run eval:workflow` 默认以 Mock 模型运行五条工单流程，覆盖审批生效、授权后切换账号、清单不可用、拒绝 admin 和人工核对。它通过真实调查与执行器检查最终业务状态、策略、带本轮证据引用的状态报告及调用和时间预算。使用本地模型配置运行 `LIVE_MODEL=1 bun run eval:workflow` 可获取真实模型的 JSON 账本，任一任务未通过时退出码为 1。

### v4 原始观测与稳定性

目录工具读取身份、组和许可证，会话工具比对桌面与网页主体，应用工具读取角色清单与同步状态。服务事件工具返回故障、错误日志、刷新审计和服务状态，调查可按请求标识及事件时间核对。第五个只读工具检索当前用户可见的手册。起草工具按应用和角色策略验证工单归属及最新会话、权限证据，审批后由执行器写入并复核对应角色。

```sh
LIVE_MODEL=1 bun run eval:paired > eval-output/gpt-paired-v4.json
LIVE_MODEL=1 WORKFLOW_RUNS=3 bun run eval:workflow > eval-output/gpt-workflow-v4.json
```

`WORKFLOW_RUNS` 默认为 1。每轮顺序运行七项独立任务。meanPassRate 是各轮通过率均值，passAtK 是至少通过一次的任务占比，passAllK 是每轮均通过的任务占比。perTask 按轮列出每项任务的通过情况，meanPerRun 给出每轮平均 token 用量和耗时。

### 可选 HTTP 权限服务

默认使用 DemoPermissions。设置 `PERMISSIONS_API_URL` 后，执行器和同工单复查共用该服务。可选 `PERMISSIONS_API_TOKEN` 用于 Bearer 认证，`PERMISSIONS_TIMEOUT_MS` 默认 3000 毫秒。

- `GET /grants?resource_key=<URL 编码的资源键>&role=<URL 编码的角色>` 应返回 HTTP 200 和 `{"granted":true}` 或 `{"granted":false}`。读取失败表示状态未知，执行器转入人工核对。
- `DELETE /grants?resource_key=…&role=…` 按 URL 编码的资源键和角色撤销，成功返回 2xx。执行器读回确认，结果未知则进入人工核对。
- `POST /grants` 接收 `{"resource_key":"…","role":"project-b:viewer"}`，成功返回 2xx。即使写请求报错，执行器也会重新读取权限确认结果。

设置 `TEST_DATABASE_URL` 后运行 `bun test`，PostgreSQL 套件会在 HTTP 服务完成授权、响应仍挂起时对一次性 worker 发送 SIGKILL，再启动第二个 worker 接管过期租约，验证全程只写入一次。
