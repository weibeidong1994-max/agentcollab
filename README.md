# AgentHub — 多 Agent 协作工作台

> 本地优先的多 AI Agent 上下文管家，让多个编程助手共享项目记忆。

## 是什么

AgentHub 是一个桌面端工具，解决的核心问题是：**当你同时使用 KimiCode、Claude Code 等 AI 编程助手时，它们之间互不知情，无法共享上下文。**

AgentHub 通过以下方式解决这个问题：

1. **嵌入式终端** — 在同一个窗口内启动和管理多个 Agent 的交互式终端
2. **自动记忆蒸馏** — 直接读取 Agent 本地日志，精准提取用户需求、思考过程、实现结果
3. **上下文注入** — 将项目记忆以 Markdown 文件形式注入到 Agent 的对话中
4. **跨会话聚合** — 所有对话的记忆按类别全局聚合，避免信息碎片化

## 核心功能

### 🖥️ 嵌入式终端
- 基于 `xterm.js` + `portable-pty` 的真实终端体验
- 支持 Claude Code、KimiCode、Hermes 等多种 Agent
- 切换对话时终端进程不中断（CSS 显隐切换而非组件卸载）
- 自动适应面板尺寸变化

### 🧠 记忆蒸馏
- **精准日志解析**：直接读取 `~/.kimi/sessions/` 和 `~/.claude/projects/` 的结构化 JSONL 日志
- **五维提取**：用户需求、Agent 回复、思考过程、涉及文件、技术决策
- **跨对话聚合**：同一项目下所有会话的同类记忆合并为单条记录
- **LLM 增强**：可选接入 GLM API 进行语义归纳（`glm-4-flash` / `glm-4.7-flash`）

### 📋 上下文管理
- 每个项目独立生成 `.agenthub/context.md` 上下文文件
- 一键复制上下文到剪贴板
- 一键注入上下文文件引用到当前 Agent 终端
- 记忆卡片支持按类别筛选和单独删除

### 🎨 界面特性
- 三栏可拖拽布局（项目列表 | 项目记忆 | 终端区域）
- 暗黑主题，VS Code 风格配色
- 对话支持创建和删除（含二次确认弹窗）
- 面板宽度调整后自动持久化到 localStorage

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面框架 | Tauri 2 (Rust) |
| 前端框架 | React 19 + TypeScript |
| 终端仿真 | xterm.js 6 + fit-addon + web-links-addon |
| 伪终端 | portable-pty (Rust) |
| 数据库 | SQLite (tauri-plugin-sql) |
| LLM API | 智谱 GLM (OpenAI 兼容接口) |
| 构建工具 | Vite 7 |

## 项目结构

```
agentcollab/
├── src-tauri/                    # Rust 后端
│   └── src/
│       ├── lib.rs                # Tauri 命令：PTY 管理、文件系统操作
│       └── main.rs               # 入口
├── src/                          # React 前端
│   ├── App.tsx                   # 主应用：布局、状态管理、蒸馏引擎
│   ├── App.css                   # 全局样式
│   ├── components/
│   │   └── TerminalPanel.tsx     # 终端面板组件（xterm.js 封装）
│   ├── services/
│   │   ├── database.ts           # SQLite 初始化与种子数据
│   │   ├── distill.ts            # LLM 蒸馏服务（GLM API 调用）
│   │   ├── session-reader.ts     # Agent 日志解析器（Kimi/Claude）
│   │   ├── pty/
│   │   │   └── index.ts          # PTY 前端 API 封装
│   │   └── adapter/
│   │       ├── index.ts          # Agent 适配器注册中心
│   │       ├── base-cli-adapter.ts
│   │       ├── claude-code.ts
│   │       ├── kimicode.ts
│   │       ├── hermes.ts
│   │       └── types.ts          # 适配器类型定义
│   └── types/
│       └── index.ts              # 全局类型定义
├── package.json
├── src-tauri/Cargo.toml
└── 技术方案.md
```

## 快速开始

### 环境要求

- Node.js >= 18
- Rust >= 1.70
- macOS (当前仅测试了 macOS)

### 安装依赖

```bash
# 前端依赖
npm install

# Rust 依赖（Tauri CLI 会自动处理）
```

### 开发模式

```bash
npm run tauri dev
```

### 构建发布

```bash
npm run tauri build
```

## 使用流程

1. **创建项目** — 左侧面板点击「+ 项目」，输入项目名称和路径
2. **创建对话** — 在项目下点击「+ 新对话」，选择 Agent（如 KimiCode）
3. **交互** — 在右侧终端中与 Agent 正常对话
4. **同步日志** — 点击左下角「📂 同步日志」，自动从 Agent 本地日志提取记忆
5. **查看记忆** — 中间面板展示聚合后的项目记忆
6. **注入上下文** — 在新对话中点击「📥 注入上下文」，让 Agent 读取项目历史

## Agent 日志路径

| Agent | 日志路径 |
|-------|----------|
| KimiCode | `~/.kimi/sessions/{userId}/{sessionId}/context.jsonl` |
| Claude Code | `~/.claude/projects/{projectDir}/{sessionId}.jsonl` |

## LLM 蒸馏配置

点击左上角 ⚙️ 按钮，配置：

- **API Key**：智谱开放平台 API Key
- **API URL**：`https://open.bigmodel.cn/api/paas/v4/chat/completions`
- **模型**：`glm-4-flash`（默认）或 `glm-4.7-flash`

## License

MIT
