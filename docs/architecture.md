# ServiceDesk 的调查与授权执行

```mermaid
flowchart LR
  UI[React 工作台] -->|工单、决策、SSE 续传| API[Fastify / TypeBox]
  API -->|租户和主体范围| E[调查引擎]
  E --> T[只读工具 / 可见手册]
  E --> V[工单级脱敏网关]
  V --> M[Pi 模型或确定性 Mock]
  E -->|策略与当前证据| D[冻结草案]
  API -->|独立审批| D
  D --> DB[(PostgreSQL 或内存)]
  E -->|观测与事件序号| DB
  DB --> X[租约执行器]
  X -->|读、写、读回| P[Demo 或 HTTP 权限服务]
  X -->|任务结果与审计| DB
```

## 变更与任务

```mermaid
stateDiagram-v2
  [*] --> pending_approval
  pending_approval --> rejected: 拒绝
  pending_approval --> approved: 批准并入队 grant
  approved --> executing: 领取 grant
  executing --> succeeded: 授权已确认
  executing --> failed: 写入前已过期
  succeeded --> executing: 到期领取 revoke
  executing --> revoked: 确认已撤或其他授权覆盖
  executing --> manual_review: 外部状态未知
  manual_review --> succeeded: 人工确认授权
  manual_review --> revoked: 人工确认回收
  manual_review --> failed: 人工核对失败
```

```mermaid
stateDiagram-v2
  [*] --> queued
  queued --> running: run_at 到达且资源空闲
  running --> running: 租约过期后接管
  running --> succeeded: 达到预期状态
  running --> failed: 授权写入前已过期
  running --> manual_review: 结果无法确认
  manual_review --> succeeded: 独立审批人记录核对依据
  manual_review --> failed: 核对失败
```

有效期从起草时计算，绝对截止时间参与哈希。批准和 grant 入队同事务提交。限时授权确认及 revoke 入队也同事务提交。每个变更、任务类型至多一条任务。锁粒度为租户、应用、受益人，回收再按角色检查其他有效授权。同一资源的人工核对会阻塞后续任务。

外部 HTTP 写入无法加入数据库事务。资源锁、租约、版本条件更新保护任务状态，接管者先读外部权限，再决定是否写入。测试在权限服务完成写入但尚未应答时终止 worker，验证第二个 worker 可接管且只有一次授权写入。

每个部署运行单个 API 进程，工单调查在进程内排队。SSE 通过数据库中的单调序号重放。演示会话和故障开关只保存在本地适配器进程内，重启复位。

## 排错与迭代记录

- **推理参数在网关丢失**。早期账本标记了 high，但脱敏转发层漏传 reasoning。修复后使用本地 HTTP 捕获两种协议的实际请求体。旧账本保留原有勘误。
- **审批后仍引用旧角色清单**。执行完成会改变权限观测的有效性。调查与详情接口共用时效判断；审批或回收后的复查重新读取会话与角色清单，保留旧证据 ID 供审计。
- **起草工具传入 viewer 简称**。服务端策略要求完整角色名，首轮五项任务有四项触发拒绝。收紧模型工具参数为完整角色值后重跑，保留服务端独立校验。
- **原始观测拆分与重复验证**。将目录、会话、角色库存、服务事件分开采集。模型通过请求标识及事件时间关联故障与日志。五条独立工作流重复三轮，15 次全部通过，五条均达到 pass^3。样本和模型配置见[评测报告](model-eval-report.md)。
