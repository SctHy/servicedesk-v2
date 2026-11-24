# ServiceDesk v2

单进程 Fastify 服务提供 React 界面、只读调查工具和 SSE。默认使用内存存储和确定性 Pi 模型，无需凭据。演示身份由请求头选择，服务默认仅监听本机。

## 快速启动

使用 Bun 1.4.4，在项目根目录运行：

```sh
bun install --frozen-lockfile
bun run web:build
bun run start
```

在浏览器打开 http://127.0.0.1:3000 。选择案例后点击「创建并调查」。案例 A 应建议切换桌面账号。案例 B 应建议申请项目只读角色。展开证据可查看观测时间、身份比对和证据编号。输入追问可复用已保存的证据。切换账号可验证工单隔离。内存模式重启即清空。

## PostgreSQL 与可选模型

```sh
docker compose up -d
cp -n .env.example .env
openssl rand -base64 32
```

把生成的密钥填入 .env 的 MASK_KEY 并持续保管。bun run start 自动迁移并载入知识库。默认使用 Mock。显式设置 LIVE_MODEL=1 才会联网。要调用兼容 Chat Completions 的服务，填写 MODEL_BASE_URL（含 /v1）、MODEL_ID 和 MODEL_API_KEY，模型需支持工具调用。

## 接口

GET /healthz 与 GET /api/demo/scenarios 公开。其余接口传 x-demo-user（alice、bob 或 guest）。

| 请求 | 输入或用途 |
|---|---|
| POST /api/tickets | JSON 字段 scenario 取 A 或 B |
| GET /api/tickets | 当前用户的工单 |
| GET /api/tickets/:id | 工单、证据、调查轮次 |
| POST /api/tickets/:id/runs | JSON 字段 message 与 client_request_id。同键同内容返回原 runId，内容冲突返回 409 |
| GET /api/runs/:runId/events | SSE，支持 Last-Event-ID。关闭订阅后调查继续 |

工具通过工单绑定的 scope 和 ref 读取模拟系统，所有模型请求经过同一脱敏网关。changes 与 jobs 为后续里程碑预留。Mock 的结论依据会话与权限证据生成，演示只覆盖预置案例。每个部署运行一个 API 进程，同一工单的调查在进程内串行执行。

## 验证

```sh
bun run typecheck
bun test
bun run web:build
docker compose exec postgres createdb -U desk desk_test
TEST_DATABASE_URL=postgres://desk:desk@localhost:5433/desk_test bun test
```

使用独立测试库，集成测试会写入测试工单。无 TEST_DATABASE_URL 时自动跳过 PostgreSQL 套件。开发和启动均直接执行 TypeScript，入口为 `bun run dev` 或 `bun run start`。

## M2 评测

`bun run eval:privacy` 输出合成样本的实体召回率、诊断字段误改率、工具参数还原率和离线根因一致率。自由文本中的陌生中文姓名单独计分，当前没有姓名识别模型。

`bun run eval:paired` 通过调查引擎运行 8 对反事实夹具，校验决策代码和决定性证据引用，并检查模型出站请求中的合成敏感值。离线分数衡量确定性规则。设置 `LIVE_MODEL=1 bun run eval:paired` 可评估真实模型；`PAIR_LIMIT=2` 仅跑前两对。JSON 包含每例耗时、工具数与模型报告的 token 数。保存报告可运行：

```sh
mkdir -p eval-output
LIVE_MODEL=1 bun run eval:paired > eval-output/paired.json
```

双模型同场评测读取主模型的 `MODEL_*` 和对照模型的 `COMPARE_MODEL_BASE_URL`、`COMPARE_MODEL_ID`、`COMPARE_MODEL_API_KEY`。配置后运行 `LIVE_MODEL=1 bun run eval:compare`。两模型分别顺序完成全部 16 例，使用相同的问题、工具、网关和评分函数。终端输出汇总；脱敏逐例账本写入已忽略的 `eval-output/compare-live.json`。执行失败或触发泄漏检测时命令返回非零。结果见 [M2 评测报告](docs/model-eval-report.md)。
