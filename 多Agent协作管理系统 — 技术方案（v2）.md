# 多Agent协作管理系统 — 技术方案（v2）

## 1. 技术目标

1. 让多个本地 Agent 在同一项目内共享上下文并持续协作。
2. 让无长期记忆的 Agent 获得统一、可治理的外部记忆能力。
3. 让新增 Agent 的接入成本足够低，优先通过配置接入。
4. 让项目在换机器、换环境后仍能恢复到可继续执行的状态。
5. 在有限的 Coding Plan 额度内智能调度，最大化额度利用率。

## 2. 架构原则

1. 本地优先，云可选。
2. 控制平面与执行平面分离。
3. 委托模式——不侵入 Agent 内部，只做注入、提取、调度。
4. 自然语言协作与结构化协议并存，但结构化协议优先。
5. 每次执行都可追踪、可审计、可回放。
6. 记忆必须带来源、版本、置信度和作用域，避免长期污染。
7. 高风险动作必须经过权限校验和审批。
8. 额度感知——调度决策必须考虑 Coding Plan 额度消耗。

## 3. 总体架构

### 3.1 阶段 1 架构（MVP）

```text
┌────────────────────────────────────────────────────────────┐
│                        Desktop UI                          │
│     Brief / Tasks / Memory / Artifacts / Approval / Quota  │
└───────────────────────▲────────────────────────────────────┘
                        │
                        │ Tauri IPC
                        │
┌───────────────────────┴────────────────────────────────────┐
│                    Local Control Plane                     │
│          (TypeScript / Node.js)                            │
│                                                            │
│  Planner   Scheduler   Context Builder   Policy Engine     │
│  Task FSM  Event Bus   Memory Service    Audit Service     │
│  Quota Manager                                            │
└───────────────▲───────────────────────────────▲────────────┘
                │                               │
                │ CLI Subprocess                │ Query / Write
                │                               │
┌───────────────┴───────────────┐   ┌───────────┴────────────┐
│         Agent Runtime         │   │      Memory Plane      │
│                               │   │                        │
│ CLI Adapter  Stream Relay     │   │ SQLite metadata store  │
│ Health Checker                │   │ sqlite-vec index       │
│ Workspace Lock Manager        │   │ File artifact store    │
│ Auto-approve Handler          │   │ ONNX embedding engine  │
└───────────────▲───────────────┘   └───────────▲────────────┘
                │                               │
                │ spawn CLI                     │
                │                               │
  ┌─────────────┼─────────────┐        ┌───────┴────────┐
  │             │             │        │ workspace fs   │
  │    ┌────────▼───────┐    │        │ snapshots      │
  │    │ Claude Code    │    │        │ logs           │
  │    │ (GLM-5.1/4.7) │    │        │ exports        │
  │    └────────────────┘    │        └────────────────┘
  │    ┌────────────────┐    │
  │    │ KimiCode       │    │
  │    │ (K2.5)         │    │
  │    └────────────────┘    │
  │    ┌────────────────┐    │
  │    │ OpenClaw       │    │
  │    │ (GLM-4.7)      │    │
  │    └────────────────┘    │
  │    ┌────────────────┐    │
  │    │ Hermes Agent   │    │
  │    │ (Cron+Notify)  │    │
  │    └────────────────┘    │
  └──────────────────────────┘
```

### 3.2 分层职责

1. `Desktop UI`：展示工作流、任务状态、记忆、产物、审批和额度。
2. `Control Plane`：负责任务规划、调度、上下文构建、权限校验、审计、额度管理。
3. `Agent Runtime`：屏蔽不同 Agent 的调用差异，统一执行接口，管理工作区锁和流式输出。
4. `Memory Plane`：持久化记忆、事件、产物索引和工作区快照。

### 3.3 阶段演进

| 阶段 | 调度方 | 说明 |
|---|---|---|
| 阶段 1（MVP） | AgentHub（TypeScript） | 轻量调度，通过 CLI 子进程调用各 Agent |
| 阶段 2 | Hermes Agent | 等 Issue #413 跨 CLI 编排实现后，Hermes 接管调度 |
| 阶段 3 | OpenClaw | 产品上线后，OpenClaw 作为应用层常驻网关 |

## 4. 核心数据流

### 4.1 从 Brief 到协作执行

```text
Brief
  -> Planner 内置 LLM 对话澄清需求（信息不足时在工作台追问）
  -> Planner 生成 PlanDraft（含额度预估）
  -> Quota Manager 检查额度是否足够
  -> Policy Engine 做风险分析
  -> 用户审批
  -> Scheduler 生成可执行 Task
  -> Quota Manager 选择最优 Agent + 模型
  -> Context Builder 组装上下文
  -> Workspace Lock Manager 获取文件锁
  -> CLI Adapter 启动子进程调用目标 Agent
  -> Stream Relay 实时转发输出
  -> 输出 Artifact + Event
  -> Memory Service 提取记忆
  -> Quota Manager 扣减额度
  -> Scheduler 推进下一步任务
```

### 4.2 CLI 子进程调用方式（Coding Plan 合规）

AgentHub 不直接调 GLM 或 Kimi 的 API，而是通过启动 CLI 子进程调用 Agent：

```text
AgentHub Scheduler
    │
    │ spawn child_process
    │
    ▼
  claude -p "已注入上下文的 prompt" --output-format json
    │
    │ 或
    │
  kimicode --prompt "已注入上下文的 prompt" --format json
    │
    │ AgentHub 读取 stdout/stderr 收集结果
    │
    ▼
  结果 -> Artifact Store + Memory Service
```

这完全符合 Coding Plan 的使用规范——在编程工具内交互式使用，不是自动化脚本批量调 API。

## 5. 技术选型

| 层级 | 技术 | 理由 |
|---|---|---|
| 桌面壳 | `Tauri 2` | 轻量、跨平台、易打包 |
| 前端 | `React + TypeScript + Zustand + TanStack Query` | 状态管理清晰，适合任务与日志类界面 |
| 核心服务 | `TypeScript / Node.js` | 单人开发一种语言最快；系统瓶颈在 Agent API 响应（秒级）不在调度（毫秒级） |
| 元数据存储 | `SQLite` | 单文件、易迁移、零部署 |
| 向量检索 | `sqlite-vec` | 本地优先，嵌入式语义检索 |
| 嵌入模型 | `all-MiniLM-L6-v2` via `ONNX Runtime` | 本地运行约 80MB，无需网络；后续可换中文优化模型 |
| 产物存储 | 本地文件系统 | 代码、日志、报告天然适合文件化 |
| IPC | Tauri IPC | UI 与核心服务通信 |
| CLI 调用 | `child_process.spawn` | 启动 Agent CLI 子进程，合规使用 Coding Plan |
| 流式输出 | `stdout/stderr` 流式读取 | 实时展示 Agent 执行进度 |
| 打包格式 | `tar.gz` + manifest | 简单透明，利于版本兼容 |

## 6. 核心模块设计

### 6.1 Planner

职责：把 Brief 转成可执行计划。当 Brief 信息不足时，通过内置 LLM 在工作台与用户对话澄清需求，澄清过程天然进入共享记忆。

输出内容至少包括：

1. 目标摘要。
2. 子任务列表。
3. 依赖关系。
4. 每个任务的目标角色。
5. 输入产物要求。
6. 完成定义。
7. 风险动作列表。
8. 额度预估。

### 6.2 Scheduler

职责：按依赖、状态、权限、可用性和额度推进任务。

需要支持：

1. 串行、并行、回环。
2. 重试、超时、中断、恢复。
3. 失败后的回退与人工接管。
4. 根据能力标签 + 额度状态选择执行 Agent。

任务状态机：

`draft -> approved -> queued -> running -> waiting_review -> blocked -> failed -> done`

### 6.3 Context Builder

职责：在 Agent 执行前，构建最小但足够的上下文。

上下文来源按优先级：

1. 当前任务目标与验收标准。
2. 上游任务产物。
3. 项目级约束与关键决策。
4. 用户偏好。
5. 最近相关记忆。
6. Agent 自身运行提示模板。

输出为结构化片段，最终拼成 CLI prompt 参数。

### 6.4 Memory Service

#### 6.4.1 记忆分层

1. `user_memory`：用户长期偏好。
2. `project_memory`：项目事实、约束、架构决策。
3. `task_memory`：任务过程信息和临时上下文。
4. `agent_memory`：Agent 局部经验。

#### 6.4.2 记忆属性

每条记忆都应带有：`source`、`scope`、`confidence`、`status`（active/stale/rejected/pending_confirm）、`version`、`ttl`、`evidence_ref`。

#### 6.4.3 记忆写入流程

```text
Agent Output
  -> Memory Extractor
  -> Normalize
  -> Deduplicate
  -> Score confidence
  -> Policy check
  -> Optional human confirm
  -> Persist
```

#### 6.4.4 记忆检索策略

混合检索：先按 scope 和 tags 过滤，再按关键词和向量相似度召回，最后按 recency、importance、confidence 重排。

#### 6.4.5 原生记忆协调

AgentHub 共享记忆为权威源。Agent 原生记忆（Hermes MEMORY.md、OpenClaw MEMORY.md）为局部缓存。

同步策略：

1. AgentHub 记忆变更时，写入对应 Agent 的原生记忆文件。
2. Agent 原生记忆变更时（通过文件监听），提取差异并合并到 AgentHub（需人工确认）。
3. 冲突时以 AgentHub 为准。

### 6.5 Artifact Store

Agent 协作必须让关键输出结构化落地为产物。每个任务应声明输入产物与输出产物，调度器据此推动下游任务。

### 6.6 Event Bus 与审计日志

所有关键状态变化写入事件表：Brief 提交、计划生成、审批通过/拒绝、Agent 开始执行、Agent 输出产物、记忆写入、任务失败/重试、额度扣减。

### 6.7 Policy Engine

负责：审批判断、权限校验、动作风险等级评估、记忆覆盖控制。

### 6.8 Quota Manager

这是本方案新增的关键模块。

#### 6.8.1 职责

1. 跟踪各 Coding Plan 的剩余额度（5h 窗口 + 周额度）。
2. 根据当前时段选择最优模型（高峰期切 GLM-4.7，非高峰切 GLM-5.1）。
3. 额度不足时自动降级（GLM Pro -> Kimi Moderato）。
4. 任务排队（5h 额度耗尽时等待恢复）。
5. 额度预估（在用户审批计划时展示）。

#### 6.8.2 额度数据模型

```typescript
interface QuotaState {
  plan_id: "glm-pro" | "kimi-moderato";
  window_5h_used: number;
  window_5h_limit: number;
  window_5h_reset_at: number;
  weekly_used: number;
  weekly_limit: number;
  weekly_reset_at: number;
  current_model: string;
  peak_hours: boolean;
}
```

#### 6.8.3 模型选择策略

```typescript
function selectModel(task: Task, quota: QuotaState): ModelChoice {
  if (quota.peak_hours && quota.plan_id === "glm-pro") {
    return { model: "glm-4.7", multiplier: 1 };
  }
  if (!quota.peak_hours && quota.plan_id === "glm-pro") {
    return { model: "glm-5.1", multiplier: 2 };
  }
  return { model: "kimi-k2.5", multiplier: 1 };
}
```

### 6.9 Workspace Lock Manager

负责文件级读写锁，防止多个 Agent 同时写入同一文件。

1. Agent 执行前声明需要的文件写权限。
2. 冲突时排队或报错。
3. Agent 完成后释放锁。

### 6.10 Stream Relay

负责实时转发 Agent CLI 的输出到 UI。

1. CLI Agent 通过 `stdout/stderr` 流式读取。
2. 统一输出为 `StreamChunk` 事件推送到 UI。
3. 支持进度条和状态更新。

## 7. Agent 接入规范

### 7.1 Agent Profile

```yaml
agent:
  id: claude-code
  name: Claude Code
  role: coder
  capabilities:
    - code-generation
    - code-refactoring
    - debugging
    - code-review
  transport: cli
  command: claude
  args_template: "-p '{{prompt}}' --output-format json"
  working_dir: "{{project_path}}"
  timeout_seconds: 300
  permissions:
    file_read: true
    file_write: true
    shell_exec: true
    network: false
  healthcheck:
    command: "claude --version"
  output_schema:
    type: json
  orchestration_mode: delegated
  supports_streaming: true
  supports_abort: true
  memory_sync_protocol: file_watch
  quota_source: glm-pro
  model_mapping:
    peak: glm-4.7
    off_peak: glm-5.1
```

### 7.2 统一执行接口

```typescript
interface TaskEnvelope {
  task_id: string;
  project_id: string;
  role: string;
  goal: string;
  constraints: string[];
  artifact_inputs: ArtifactRef[];
  context: ContextPayload;
  permissions: PermissionSet;
  quota_budget: QuotaBudget;
}

interface TaskResult {
  task_id: string;
  status: TaskStatus;
  artifacts: ArtifactRef[];
  memory_candidates: MemoryCandidate[];
  events: DomainEvent[];
  raw_output: string;
  quota_consumed: QuotaConsumption;
}
```

### 7.3 适配器类型

1. `CLI Adapter`：适合本地命令行 Agent（Claude Code、KimiCode）。
2. `Hermes Adapter`：适合 Hermes Agent（通过 CLI 调用 + 文件监听同步记忆）。
3. `HTTP Adapter`：适合远端 API Agent（预留）。
4. `OpenClaw Adapter`：适合 OpenClaw（仅产品上线后作为应用层网关使用，MVP 阶段不接入）。

## 8. 数据存储设计

### 8.1 建议库表

1. `projects`
2. `briefs`
3. `plans`
4. `tasks`
5. `task_edges`
6. `artifacts`
7. `memories`
8. `events`
9. `approvals`
10. `agent_profiles`
11. `agent_runs`
12. `quota_snapshots`
13. `workspace_locks`

### 8.2 `memories` 表

```sql
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  source_agent_id TEXT,
  source_task_id TEXT,
  type TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail TEXT,
  confidence REAL NOT NULL,
  importance REAL NOT NULL DEFAULT 0.5,
  status TEXT NOT NULL DEFAULT 'active',
  evidence_ref TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  tags TEXT,
  embedding BLOB,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER
);
```

### 8.3 `quota_snapshots` 表

```sql
CREATE TABLE quota_snapshots (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  window_5h_used INTEGER NOT NULL,
  window_5h_limit INTEGER NOT NULL,
  weekly_used INTEGER NOT NULL,
  weekly_limit INTEGER NOT NULL,
  current_model TEXT NOT NULL,
  peak_hours INTEGER NOT NULL DEFAULT 0,
  captured_at INTEGER NOT NULL
);
```

## 9. 安全与执行隔离

1. 每个 Agent 默认最小权限运行。
2. 高风险命令必须审批。
3. 密钥不写入普通导出包。
4. 审计日志不可无痕篡改。
5. 不同项目的上下文默认隔离。
6. 同一文件同一时刻只允许一个 Agent 写入。
7. Coding Plan API Key 不用于自动化脚本调用，只通过 CLI 子进程交互式使用。

## 10. 打包与迁移设计

### 10.1 导出包内容

```text
project.aghub/
├── manifest.json
├── metadata/
│   ├── project.json
│   ├── agents.json
│   └── compatibility.json
├── db/
│   └── agenthub.db
├── artifacts/
├── workspace/
├── snapshots/
└── checksums/
```

### 10.2 manifest.json 关键字段

1. 系统版本。
2. 导出时间。
3. 需要的 Agent 列表。
4. Agent 版本指纹。
5. OS 与架构信息。
6. 依赖检查项。
7. 不可导出的敏感资源清单。

### 10.3 导入恢复流程

```text
Import package
  -> Verify checksum
  -> Check OS compatibility
  -> Check required agents installed
  -> Rebind secrets
  -> Rebuild vector index if needed
  -> Open project in recovered state
```

## 11. 测试策略

1. **Agent 适配器测试**：用 Mock Agent（模拟 CLI 输出）测试适配器的输入注入、输出解析、流式读取、超时处理。
2. **编排逻辑测试**：用预定义 DAG 场景测试串行、并行、回环、失败重试、降级切换。
3. **记忆治理测试**：注入错误记忆验证纠错流程；测试去重、置信度评分、失效标记。
4. **额度管理测试**：模拟额度耗尽验证降级和排队；模拟高峰期验证模型切换。
5. **端到端测试**：从 Brief 输入到最终产物输出的完整流程。

## 12. MVP 实施建议

### 12.1 P0

1. 本地 SQLite + sqlite-vec。
2. 三个角色接入：Claude Code（编码+Review）、KimiCode（辅助编码）、Hermes（Cron+通知）。OpenClaw 留到产品上线后。
3. 串行任务流。
4. 项目级记忆。
5. 结构化产物。
6. 审批最小集。
7. 额度仪表盘。
8. 智能模型切换。
9. Planner 内置 LLM 需求澄清（在工作台直接对话）。

### 12.2 P1

1. GUI 工作台。
2. 事件流面板。
3. 记忆浏览与纠错。
4. 失败恢复。
5. 导入导出。
6. 工作区锁定。

### 12.3 P2

1. 通用 CLI/HTTP 适配器。
2. 权限模板。
3. 工作流模板。
4. 迁移恢复向导。

### 12.4 P3

1. Hermes 跨 CLI 编排集成。
2. 调度逻辑迁移到 Hermes Skill。
3. OpenClaw 应用层网关配置。
4. AgentHub 退化为 UI 层。

## 13. 关键风险与应对

| 风险 | 说明 | 应对 |
|---|---|---|
| 记忆污染 | 错误记忆被长期注入 | 来源、置信度、版本、人工纠错、原生记忆协调 |
| 交接失真 | 只靠自然语言传递 | TaskEnvelope 和 Artifact |
| Agent 不稳定 | 输出格式不统一 | 统一适配器协议和输出 schema |
| 安全失控 | Agent 具备写文件和执行命令能力 | 最小权限、审批、审计、隔离、工作区锁 |
| 迁移失败 | 新机器环境不一致 | 兼容性检查、恢复向导、密钥重绑定 |
| 额度耗尽 | 高峰期 GLM-5.1 3 倍抵扣 | 额度仪表盘、智能模型切换、降级到 KimiCode、任务排队 |
| Coding Plan 违规 | 直接调 API 被封号 | 只通过 CLI 子进程交互式调用 |
| Hermes 自学习冲突 | Skill 只增不减，与共享记忆不一致 | 关闭 Hermes 自学习或纳入 AgentHub 记忆治理 |
| Agent 自编排冲突 | Claude Code Subagent / OpenClaw Sub-agent 与 AgentHub 编排重叠 | 委托模式：允许 Agent 内部编排但结果必须回写 Artifact |

## 14. 技术结论

推荐把系统设计为：

1. 一个本地桌面壳（Tauri + React）。
2. 一个本地控制平面核心服务（TypeScript / Node.js）。
3. 一套标准化 Agent 适配器协议（CLI 子进程调用）。
4. 一套带治理能力的共享记忆服务（SQLite + sqlite-vec + ONNX）。
5. 一条以任务、产物、事件为中心的协作链路。
6. 一个额度感知调度器（Quota Manager）。
7. 一个分阶段演进路径（AgentHub -> Hermes -> OpenClaw）。
