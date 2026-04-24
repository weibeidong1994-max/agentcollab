import { useState, useEffect, useRef, useCallback } from "react";
import { initDatabase, isTauriContext, getDb } from "./services/database";
import { loadEnabledAgents } from "./services/database";
import TerminalPanel from "./components/TerminalPanel";
import type { TerminalPanelHandle } from "./components/TerminalPanel";
import type { Project, Conversation, Memory, MemoryCategory, AgentProfile } from "./types";
import { CATEGORY_LABELS, CATEGORY_COLORS } from "./types";
import { writeFile, mkdirp } from "./services/pty";
import { llmDistill, getDistillConfig, saveDistillConfig } from "./services/distill";
import type { DistillResult } from "./services/distill";
import { logger } from "./utils/log";
import { readAllSessions, sessionConvToExtractedInfo } from "./services/session-reader";
import "./App.css";

const DISTILL_INTERVAL = 10000;
const LLM_DISTILL_INTERVAL = 30000;

interface ExtractedInfo {
  llmResult: DistillResult | null;
  fallbackUserMessages: string[];
  fallbackFiles: string[];
  fallbackActions: string[];
  fallbackThinkings: string[];
}

function extractFallbackFromTerminal(rawOutput: string): { userMessages: string[]; files: string[]; actions: string[]; thinkings: string[] } {
  const userMessages: string[] = [];
  const files: string[] = [];
  const actions: string[] = [];
  const thinkings: string[] = [];
  const lines = rawOutput.split("\n");
  const seen = new Set<string>();

  const NOISE_PATTERNS = [
    /^\[AgentHub\]/,
    /^Approve|^Allow|^\[?\d+\]? Approve/i,
    /^[⠁⠉⠙⠹⠸⠼⠴⠦⠧⠇⠏⠋⠙⠹⠸]+$/,
    /^Moonshot AI|^Open Platform/i,
    /^\s*$/,
    /^Status:|^context_usage|^token_usage|^message_id/i,
    /^\d+\s+(input_|output|cache)/i,
  ];

  function isNoise(line: string): boolean {
    return NOISE_PATTERNS.some(p => p.test(line));
  }

  function addUnique(arr: string[], item: string, maxLen = 300) {
    const key = item.slice(0, 80);
    if (!seen.has(key) && item.length > 2 && item.length < maxLen) {
      seen.add(key);
      arr.push(item);
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.length < 2 || isNoise(line)) continue;

    if (/^›\s/.test(line)) {
      addUnique(userMessages, line.replace(/^›\s*/, "").trim());
      continue;
    }

    const fileOpMatch = line.match(/(?:Wrote|Created|Modified|Deleted|Updated|Overwrote)\s+(?:\d+\s+bytes?\s+to\s+|\d+\s+lines?\s+to\s+|file\s+)([^\s,;()]+)/i);
    if (fileOpMatch && fileOpMatch[1]) {
      const action = line.match(/(Wrote|Created|Modified|Deleted|Updated|Overwrote)/i)?.[1] || "操作";
      addUnique(files, `${action}: ${fileOpMatch[1]}`);
      continue;
    }

    if (/Using\s+(?:WriteFile|ReadFile|EditFile|Bash|Shell)\s*\(/i.test(line)) {
      const toolMatch = line.match(/Using\s+(\w+)\s*\(([^)]*)\)/i);
      if (toolMatch) {
        addUnique(actions, `调用工具 ${toolMatch[1]}: ${toolMatch[2].slice(0, 80)}`);
      }
      continue;
    }

    if (line.includes("/Users/") || line.includes("~/")) {
      const pathMatch = line.match(/(\/Users\/[^\s,;)"'`,]+|~\/[^\s,;)"'`,]+)/g);
      if (pathMatch) {
        for (const p of pathMatch) {
          const cleaned = p.replace(/[)\]}"'`,;]+$/, "");
          if (cleaned.length > 8 && /\.\w{1,10}$/.test(cleaned)) {
            addUnique(files, `文件: ${cleaned}`);
          }
        }
      }
    }

    if (/^(?:用户想要|用户需要|用户请求|用户希望)/.test(line) && line.length < 300) {
      addUnique(thinkings, line);
      continue;
    }

    if (/^(?:我会|我可以|我将|我需要实现|我需要创建|我可以用|让我创建|让我写|让我直接|这是一个相对简单|这是一个交互式)/.test(line) && line.length < 300) {
      addUnique(thinkings, line);
      continue;
    }

    if (/^(?:帮我|请|想要|希望|能不能|可以|实现|创建|开发|添加|修改|修复|删除|重构|写一个?|做一个?)/.test(line) &&
        line.length > 3 && line.length < 80 &&
        !/^(?:Wrote|Created|Error|warning|npm|cargo|git |Using)/i.test(line) &&
        !line.includes("http") && !line.includes("token") &&
        !line.includes("，我需要") && !line.includes("，我可以")) {
      addUnique(userMessages, line);
      continue;
    }

    if (/^•\s/.test(line)) {
      const content = line.replace(/^•\s*/, "").trim();
      if (content.length > 4 && content.length < 300) {
        if (/(?:已做好|已完成|已创建|已实现|已写好|文件保存在|保存[在到])/i.test(content)) {
          addUnique(actions, content);
        } else if (/(?:用户想要|我[会可以将要]|让我|这是一个)/i.test(content)) {
          addUnique(thinkings, content);
        } else if (/(?:操作方式|食物|蛇头|最高分|视觉|支持|特性|功能|规则|效果|玩法|目标|游戏特点)/i.test(content)) {
          addUnique(actions, content);
        }
      }
      continue;
    }

    if (/^(?:已做好|已完成|已创建|已实现|已写好|文件保存|迷宫小游戏|游戏|页面|项目)/.test(line) && line.length > 4 && line.length < 300) {
      addUnique(actions, line);
      continue;
    }

    if (/(?:我[会可以将要]创建|我[会可以将要]用|让我创建|让我[直接写]|这是一个相对简单|现在我应该)/.test(line) && line.length < 300) {
      addUnique(thinkings, line);
      continue;
    }
  }

  return { userMessages: userMessages.slice(0, 20), files: files.slice(0, 20), actions: actions.slice(0, 30), thinkings: thinkings.slice(0, 10) };
}

function buildContextMd(
  extractedMap: Map<string, ExtractedInfo>,
  conversations: Conversation[],
  agents: AgentProfile[],
  memories: Memory[]
): string {
  const lines: string[] = [];
  const now = new Date().toLocaleString("zh-CN");

  lines.push("# 项目上下文");
  lines.push("");
  lines.push(`> 最后更新: ${now}`);
  lines.push("");

  let hasAnyContent = false;

  for (const [convId, info] of extractedMap) {
    const conv = conversations.find((c) => c.id === convId);
    const agentName = conv?.agent_id ? agents.find((a) => a.id === conv.agent_id)?.name || conv.agent_id : "未知";
    const convTitle = conv?.title || convId.slice(0, 8);

    const llm = info.llmResult;
    const useLlm = !!llm;

    const userReqs = useLlm && llm!.user_requirements.length > 0 ? llm!.user_requirements : info.fallbackUserMessages;
    const agentSummary = useLlm && llm!.agent_summary.length > 0 ? llm!.agent_summary : info.fallbackActions;
    const agentThinking = useLlm && llm!.agent_thinking.length > 0 ? llm!.agent_thinking : info.fallbackThinkings;
    const keyFiles = useLlm && llm!.key_files.length > 0 ? llm!.key_files : info.fallbackFiles;
    const techDecs = useLlm && llm!.technical_decisions.length > 0 ? llm!.technical_decisions : [];

    const hasContent = userReqs.length > 0 || agentSummary.length > 0 || keyFiles.length > 0 ||
      agentThinking.length > 0 || techDecs.length > 0;

    if (!hasContent) continue;

    hasAnyContent = true;
    lines.push(`## 对话: ${convTitle} (Agent: ${agentName})`);
    lines.push("");

    if (userReqs.length > 0) {
      lines.push("### 用户需求");
      lines.push("");
      for (const m of userReqs) lines.push(`- ${m}`);
      lines.push("");
    }

    if (agentSummary.length > 0) {
      lines.push("### Agent 实现");
      lines.push("");
      for (const a of agentSummary) lines.push(`- ${a}`);
      lines.push("");
    }

    if (agentThinking.length > 0) {
      lines.push("### 思考过程");
      lines.push("");
      for (const t of agentThinking) lines.push(`- ${t}`);
      lines.push("");
    }

    if (keyFiles.length > 0) {
      lines.push("### 关键文件");
      lines.push("");
      for (const f of keyFiles) lines.push(`- ${f}`);
      lines.push("");
    }

    if (techDecs.length > 0) {
      lines.push("### 技术决策");
      lines.push("");
      for (const d of techDecs) lines.push(`- ${d}`);
      lines.push("");
    }
  }

  if (memories.length > 0) {
    hasAnyContent = true;
    lines.push("---");
    lines.push("");
    lines.push("## 关键记忆（数据库）");
    lines.push("");
    const grouped: Record<string, Memory[]> = {};
    for (const m of memories) {
      if (!grouped[m.category]) grouped[m.category] = [];
      grouped[m.category].push(m);
    }
    for (const [cat, items] of Object.entries(grouped)) {
      lines.push(`### ${CATEGORY_LABELS[cat as MemoryCategory] || cat}`);
      lines.push("");
      for (const item of items) {
        lines.push(`- ${item.content}`);
        if (item.detail) lines.push(`  - ${item.detail}`);
      }
      lines.push("");
    }
  }

  if (!hasAnyContent) {
    lines.push("> 暂无对话记录，开始与 Agent 交互后此处会自动更新。");
    lines.push("");
  }

  return lines.join("\n");
}

function App() {
  const [dbReady, setDbReady] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [agents, setAgents] = useState<AgentProfile[]>([]);

  const [showNewProject, setShowNewProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectPath, setNewProjectPath] = useState("");

  const [newConvTitle, setNewConvTitle] = useState("");
  const [newConvAgent, setNewConvAgent] = useState<string>("");
  const [showNewConv, setShowNewConv] = useState(false);

  const [distillStatus, setDistillStatus] = useState("");
  const [contextFilePath, setContextFilePath] = useState("");

  const [showSettings, setShowSettings] = useState(false);
  const [confirmDeleteConvId, setConfirmDeleteConvId] = useState<string | null>(null);
  const [deleteProjectState, setDeleteProjectState] = useState<{ id: string; name: string; path: string } | null>(null);
  const [deleteProjectMode, setDeleteProjectMode] = useState<"soft" | "hard">("soft");
  
  // 可拖拽面板宽度状态
  const [panelWidths, setPanelWidths] = useState(() => {
    const saved = localStorage.getItem("agenthub_panel_widths");
    if (saved) {
      try { return JSON.parse(saved); } catch {}
    }
    return { left: 240, middle: 300 };
  });
  const [isDragging, setIsDragging] = useState<string | null>(null);
  const dragStartXRef = useRef(0);
  const dragStartWidthsRef = useRef({ left: panelWidths.left, middle: panelWidths.middle });
  const [llmApiKey, setLlmApiKey] = useState(() => localStorage.getItem("agenthub_llm_api_key") || "");
  const [llmApiUrl, setLlmApiUrl] = useState(() => {
    const stored = localStorage.getItem("agenthub_llm_api_url") || "";
    if (!stored || stored.includes("/v4/") || stored.includes("/v4\\")) {
      const correct = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
      localStorage.setItem("agenthub_llm_api_url", correct);
      return correct;
    }
    return stored;
  });
  const [llmModel, setLlmModel] = useState(() => localStorage.getItem("agenthub_llm_model") || "glm-4-flash");

  const [notification, setNotification] = useState<{ type: "success" | "error" | "info"; message: string } | null>(null);

  const terminalRefs = useRef<Map<string, TerminalPanelHandle>>(new Map());
  const extractedMapRef = useRef<Map<string, ExtractedInfo>>(new Map());
  const sessionDataRef = useRef<Map<string, { agent: string; conv: import("./services/session-reader").SessionConversation }>>(new Map());
  const lastOutputLenRef = useRef<Map<string, number>>(new Map());
  const lastLlmDistillTimeRef = useRef<number>(0);
  const distillingRef = useRef(false);
  const memoriesRef = useRef(memories);
  const projectsRef = useRef(projects);
  const conversationsRef = useRef(conversations);
  const agentsRef = useRef(agents);

  const inTauri = isTauriContext();
  const activeProjectIdRef = useRef(activeProjectId);
  const activeConvIdRef = useRef(activeConvId);

  useEffect(() => { activeProjectIdRef.current = activeProjectId; }, [activeProjectId]);
  useEffect(() => { activeConvIdRef.current = activeConvId; }, [activeConvId]);
  useEffect(() => { memoriesRef.current = memories; }, [memories]);
  useEffect(() => { projectsRef.current = projects; }, [projects]);
  useEffect(() => { conversationsRef.current = conversations; }, [conversations]);
  useEffect(() => { agentsRef.current = agents; }, [agents]);

  const [activeTerminalIds, setActiveTerminalIds] = useState<Set<string>>(new Set());

  function notify(type: "success" | "error" | "info", message: string) {
    setNotification({ type, message });
    setTimeout(() => setNotification(null), 4000);
  }

  const homeDirRef = useRef("");

  useEffect(() => {
    if (!inTauri) return;
    import("@tauri-apps/api/path").then(({ homeDir }) => {
      homeDir().then((h) => { homeDirRef.current = h; });
    });
  }, [inTauri]);

  function getProjectDir(pid: string | null): string {
    const home = homeDirRef.current;
    if (!home) return "";
    if (!pid) return `${home}/projects/default`;
    const proj = projectsRef.current.find((p) => p.id === pid);
    const basePath = proj?.path || `~/projects/${pid}`;
    return basePath.replace(/^~/, home);
  }

  useEffect(() => {
    if (!inTauri) return;
    initDatabase().then(() => setDbReady(true)).catch((err) => notify("error", `数据库初始化失败: ${err}`));
  }, []);

  useEffect(() => {
    if (!dbReady) return;
    loadProjects();
    loadAgents();
  }, [dbReady]);

  useEffect(() => {
    if (activeProjectId) {
      loadConversations(activeProjectId);
      loadMemories(activeProjectId);
      setContextFilePath(`${getProjectDir(activeProjectId)}/.agenthub/context.md`);
    }
  }, [activeProjectId]);

  useEffect(() => {
    if (activeConvId) {
      const handle = terminalRefs.current.get(activeConvId);
      if (handle) {
        setTimeout(() => handle.refit(), 50);
      }
    }
  }, [activeConvId]);

  async function saveContextFile(pid: string) {
    const dir = getProjectDir(pid);
    try {
      await mkdirp(`${dir}/.agenthub`);

      const mainContent = buildContextMd(
        extractedMapRef.current,
        conversationsRef.current,
        agentsRef.current,
        memoriesRef.current
      );
      await writeFile(`${dir}/.agenthub/context.md`, mainContent);
      setContextFilePath(`${dir}/.agenthub/context.md`);

      const sessionData = sessionDataRef.current;
      for (const [sessionId, { agent, conv }] of sessionData) {
        if (conv.userMessages.length === 0 && conv.agentResponses.length === 0) continue;

        const now = new Date().toLocaleString("zh-CN");
        const lines: string[] = [];
        const firstUserMsg = conv.userMessages[0] || sessionId.slice(0, 8);
        const title = firstUserMsg.slice(0, 30);

        lines.push(`# 对话上下文: ${title}`);
        lines.push(`> Agent: ${agent} | 更新: ${now}`);
        lines.push("");

        if (conv.userMessages.length > 0) {
          lines.push("## 用户需求");
          lines.push("");
          for (const m of conv.userMessages) lines.push(`- ${m}`);
          lines.push("");
        }

        if (conv.agentResponses.length > 0) {
          lines.push("## Agent 实现");
          lines.push("");
          for (const r of conv.agentResponses) lines.push(r);
          lines.push("");
        }

        if (conv.agentThinking.length > 0) {
          lines.push("## 思考过程");
          lines.push("");
          for (const t of conv.agentThinking) lines.push(`- ${t}`);
          lines.push("");
        }

        if (conv.files.length > 0) {
          lines.push("## 关键文件");
          lines.push("");
          for (const f of conv.files) lines.push(`- ${f}`);
          lines.push("");
        }

        if (conv.toolCalls.length > 0) {
          lines.push("## 工具调用");
          lines.push("");
          for (const tc of conv.toolCalls) lines.push(`- ${tc.name}: ${tc.args.slice(0, 100)}`);
          lines.push("");
        }

        const safeName = title.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, "_").slice(0, 40);
        await writeFile(`${dir}/.agenthub/${safeName}.md`, lines.join("\n"));
      }

      for (const [convId, info] of extractedMapRef.current) {
        const llm = info.llmResult;
        const hasContent = (llm && (llm.user_requirements.length > 0 || llm.agent_summary.length > 0)) ||
          info.fallbackUserMessages.length > 0 || info.fallbackActions.length > 0;
        if (!hasContent) continue;

        const conv = conversationsRef.current.find(c => c.id === convId);
        const agentName = conv?.agent_id ? agentsRef.current.find(a => a.id === conv.agent_id)?.name || conv.agent_id : "";
        const convTitle = conv?.title || convId.slice(0, 8);

        const userReqs = llm?.user_requirements?.length ? llm.user_requirements : info.fallbackUserMessages;
        const agentSummary = llm?.agent_summary?.length ? llm.agent_summary : info.fallbackActions;
        const agentThinking = llm?.agent_thinking?.length ? llm.agent_thinking : info.fallbackThinkings;
        const keyFiles = llm?.key_files?.length ? llm.key_files : info.fallbackFiles;
        const techDecs = llm?.technical_decisions?.length ? llm.technical_decisions : [];

        const convLines: string[] = [];
        const now2 = new Date().toLocaleString("zh-CN");
        convLines.push(`# 对话上下文: ${convTitle}`);
        convLines.push(`> Agent: ${agentName} | 更新: ${now2}`);
        convLines.push("");

        if (userReqs.length > 0) { convLines.push("## 用户需求"); convLines.push(""); for (const m of userReqs) convLines.push(`- ${m}`); convLines.push(""); }
        if (agentSummary.length > 0) { convLines.push("## Agent 实现"); convLines.push(""); for (const a of agentSummary) convLines.push(`- ${a}`); convLines.push(""); }
        if (agentThinking.length > 0) { convLines.push("## 思考过程"); convLines.push(""); for (const t of agentThinking) convLines.push(`- ${t}`); convLines.push(""); }
        if (keyFiles.length > 0) { convLines.push("## 关键文件"); convLines.push(""); for (const f of keyFiles) convLines.push(`- ${f}`); convLines.push(""); }
        if (techDecs.length > 0) { convLines.push("## 技术决策"); convLines.push(""); for (const d of techDecs) convLines.push(`- ${d}`); convLines.push(""); }

        const safeName = convTitle.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, "_").slice(0, 40);
        await writeFile(`${dir}/.agenthub/${safeName}.md`, convLines.join("\n"));
      }
    } catch (err) {
      logger.error("saveContextFile error:", err);
    }
  }

  const autoDistill = useCallback(async () => {
    if (distillingRef.current) return;
    distillingRef.current = true;
    try {
    const pid = activeProjectIdRef.current;
    if (!pid) return;

    let totalNewItems = 0;
    const config = getDistillConfig();
    const hasLlm = !!config.apiKey;
    const now = Date.now();
    const shouldLlm = hasLlm && (now - lastLlmDistillTimeRef.current) > LLM_DISTILL_INTERVAL;

    for (const [cid, handle] of terminalRefs.current) {
      const output = handle.getOutput();
      if (!output || output.length < 20) continue;

      const prevLen = lastOutputLenRef.current.get(cid) || 0;
      if (output.length > prevLen + 10) {
      } else {
        if (prevLen > output.length) {
          lastOutputLenRef.current.set(cid, output.length);
        }
        continue;
      }

      const fallback = extractFallbackFromTerminal(output);

      let llmResult: DistillResult | null = null;
      if (shouldLlm) {
        llmResult = await llmDistill(output, config);
        if (llmResult) {
          logger.debug("[Distill] LLM extracted:",
            "reqs=", llmResult.user_requirements.length,
            "summary=", llmResult.agent_summary.length,
            "thinking=", llmResult.agent_thinking.length,
            "files=", llmResult.key_files.length,
            "decs=", llmResult.technical_decisions.length
          );
        }
      }

      const info: ExtractedInfo = {
        llmResult,
        fallbackUserMessages: fallback.userMessages,
        fallbackFiles: fallback.files,
        fallbackActions: fallback.actions,
        fallbackThinkings: fallback.thinkings,
      };
      extractedMapRef.current.set(cid, info);
      lastOutputLenRef.current.set(cid, output.length);

      const db = await getDb();

      const userReqs = llmResult?.user_requirements?.length ? llmResult.user_requirements : fallback.userMessages;
      for (const msg of userReqs) {
        const content = `[用户] ${msg.slice(0, 200)}`;
        const existing = await db.select<{ id: string }[]>(
          "SELECT id FROM memories WHERE project_id = $1 AND content = $2 AND status = 'active'",
          [pid, content.slice(0, 150)]
        );
        if (existing.length === 0) {
          const id = crypto.randomUUID();
          const ts = Date.now();
          await db.execute(
            "INSERT INTO memories (id, project_id, conversation_id, category, content, detail, priority, status, tags, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
            [id, pid, cid, "feedback", content, msg.length > 200 ? msg.slice(200, 500) : null, 8, "active", null, ts, ts]
          );
          totalNewItems++;
        }
      }

      const agentSummary = llmResult?.agent_summary?.length ? llmResult.agent_summary : fallback.actions;
      for (const summary of agentSummary.slice(0, 15)) {
        const content = summary.slice(0, 200);
        const existing = await db.select<{ id: string }[]>(
          "SELECT id FROM memories WHERE project_id = $1 AND content = $2 AND status = 'active'",
          [pid, content.slice(0, 150)]
        );
        if (existing.length === 0) {
          const id = crypto.randomUUID();
          const ts = Date.now();
          await db.execute(
            "INSERT INTO memories (id, project_id, conversation_id, category, content, detail, priority, status, tags, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
            [id, pid, cid, "implementation", content, null, 6, "active", null, ts, ts]
          );
          totalNewItems++;
        }
      }

      if (llmResult?.agent_thinking?.length) {
        for (const thinking of llmResult.agent_thinking.slice(0, 10)) {
          const content = `[思考] ${thinking.slice(0, 200)}`;
          const existing = await db.select<{ id: string }[]>(
            "SELECT id FROM memories WHERE project_id = $1 AND content = $2 AND status = 'active'",
            [pid, content.slice(0, 150)]
          );
          if (existing.length === 0) {
            const id = crypto.randomUUID();
            const ts = Date.now();
            await db.execute(
              "INSERT INTO memories (id, project_id, conversation_id, category, content, detail, priority, status, tags, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
              [id, pid, cid, "general", content, null, 5, "active", null, ts, ts]
            );
            totalNewItems++;
          }
        }
      }

      const keyFiles = llmResult?.key_files?.length ? llmResult.key_files : fallback.files;
      for (const fop of keyFiles.slice(0, 20)) {
        const content = fop.slice(0, 200);
        const existing = await db.select<{ id: string }[]>(
          "SELECT id FROM memories WHERE project_id = $1 AND content = $2 AND status = 'active'",
          [pid, content.slice(0, 150)]
        );
        if (existing.length === 0) {
          const id = crypto.randomUUID();
          const ts = Date.now();
          await db.execute(
            "INSERT INTO memories (id, project_id, conversation_id, category, content, detail, priority, status, tags, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
            [id, pid, cid, "variable", content, null, 7, "active", null, ts, ts]
          );
          totalNewItems++;
        }
      }

      if (llmResult?.technical_decisions?.length) {
        for (const dec of llmResult.technical_decisions.slice(0, 10)) {
          const content = dec.slice(0, 200);
          const existing = await db.select<{ id: string }[]>(
            "SELECT id FROM memories WHERE project_id = $1 AND content = $2 AND status = 'active'",
            [pid, content.slice(0, 150)]
          );
          if (existing.length === 0) {
            const id = crypto.randomUUID();
            const ts = Date.now();
            await db.execute(
              "INSERT INTO memories (id, project_id, conversation_id, category, content, detail, priority, status, tags, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
              [id, pid, cid, "decision", content, dec.length > 200 ? dec.slice(200, 500) : null, 9, "active", null, ts, ts]
            );
            totalNewItems++;
          }
        }
      }

      const summaryParts: string[] = [];
      if (userReqs.length > 0) summaryParts.push(`需求: ${userReqs.join("; ")}`);
      if (keyFiles.length > 0) summaryParts.push(`文件: ${keyFiles.slice(0, 5).join(", ")}`);
      if (summaryParts.length > 0) {
        await db.execute(
          "UPDATE conversations SET summary = $1, updated_at = $2 WHERE id = $3",
          [summaryParts.join(" | ").slice(0, 2000), Date.now(), cid]
        );
      }
    }

    if (shouldLlm) {
      lastLlmDistillTimeRef.current = now;
    }

    if (totalNewItems > 0) {
      await loadMemories(pid);
      setDistillStatus(`已保存 ${totalNewItems} 条上下文${shouldLlm ? " (LLM增强)" : ""}`);
    } else {
      setDistillStatus("已同步");
    }

    await saveContextFile(pid);
    setTimeout(() => setDistillStatus(""), 5000);
    } finally {
      distillingRef.current = false;
    }
  }, []);

  useEffect(() => {
    const timer = setInterval(autoDistill, DISTILL_INTERVAL);
    return () => clearInterval(timer);
  }, [autoDistill]);

  async function loadProjects() {
    try {
      const db = await getDb();
      const rows = await db.select<Project[]>("SELECT * FROM projects ORDER BY updated_at DESC");
      setProjects(rows);
      if (!activeProjectId && rows.length > 0) setActiveProjectId(rows[0].id);
    } catch (err) { notify("error", `加载项目失败: ${err}`); }
  }

  async function loadConversations(projectId: string) {
    try {
      const db = await getDb();
      const rows = await db.select<Conversation[]>(
        "SELECT * FROM conversations WHERE project_id = $1 ORDER BY created_at DESC", [projectId]
      );
      setConversations(rows);
    } catch (err) { notify("error", `加载对话失败: ${err}`); }
  }

  async function loadMemories(projectId: string) {
    try {
      const db = await getDb();
      const rows = await db.select<Memory[]>(
        "SELECT * FROM memories WHERE project_id = $1 AND status = 'active' ORDER BY priority DESC, updated_at DESC", [projectId]
      );
      setMemories(rows);
    } catch (err) { notify("error", `加载记忆失败: ${err}`); }
  }

  async function loadAgents() {
    try {
      const rows = await loadEnabledAgents();
      setAgents(rows);
    } catch (err) { notify("error", `加载 Agent 失败: ${err}`); }
  }

  async function handleSelectProjectFolder() {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        directory: true,
        multiple: false,
        title: "选择项目文件夹",
      });
      if (selected) {
        const path = typeof selected === "string" ? selected : selected;
        setNewProjectPath(path);
        const folderName = path.split("/").pop() || "";
        if (!newProjectName && folderName) {
          setNewProjectName(folderName);
        }
      }
    } catch (err) {
      logger.error("[SelectFolder] 失败:", err);
    }
  }

  async function handleCreateProject() {
    if (!newProjectName.trim() || !newProjectPath.trim()) {
      notify("error", "请选择项目文件夹");
      return;
    }
    try {
      const db = await getDb();
      const id = crypto.randomUUID();
      const now = Date.now();
      await db.execute(
        "INSERT INTO projects (id, name, path, description, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)",
        [id, newProjectName.trim(), newProjectPath.trim(), null, now, now]
      );
      setNewProjectName(""); setNewProjectPath(""); setShowNewProject(false);
      await loadProjects(); setActiveProjectId(id);
      notify("success", `项目 "${newProjectName}" 已创建`);
    } catch (err) { notify("error", `创建项目失败: ${err}`); }
  }

  async function handleCreateConversation() {
    if (!activeProjectId || !newConvTitle.trim()) return;
    try {
      const db = await getDb();
      const id = crypto.randomUUID();
      const now = Date.now();
      await db.execute(
        "INSERT INTO conversations (id, project_id, title, agent_id, summary, status, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        [id, activeProjectId, newConvTitle.trim(), newConvAgent || null, null, "active", now, now]
      );
      setNewConvTitle(""); setNewConvAgent(""); setShowNewConv(false);
      await loadConversations(activeProjectId);
      setActiveConvId(id);
      lastOutputLenRef.current.set(id, 0);
      if (newConvAgent) {
        setActiveTerminalIds(prev => { const next = new Set(prev); next.add(id); return next; });
      }
      notify("success", `对话 "${newConvTitle}" 已创建`);
    } catch (err) { notify("error", `创建对话失败: ${err}`); }
  }

  async function handleDeleteMemory(memoryId: string) {
    if (!activeProjectId) return;
    try {
      const db = await getDb();
      await db.execute("UPDATE memories SET status = 'archived' WHERE id = $1", [memoryId]);
      await loadMemories(activeProjectId);
      await saveContextFile(activeProjectId);
    } catch (err) { notify("error", `删除记忆失败: ${err}`); }
  }

  function handleCopyContext() {
    const text = buildContextMd(extractedMapRef.current, conversationsRef.current, agentsRef.current, memories);
    if (!text || text.includes("暂无对话记录")) { notify("info", "暂无项目记忆"); return; }
    navigator.clipboard.writeText(text).then(() => notify("info", "项目上下文已复制到剪贴板"));
  }

  // 拖拽调整面板宽度
  function handleDragStart(e: React.MouseEvent, panel: "left" | "middle") {
    e.preventDefault();
    setIsDragging(panel);
    dragStartXRef.current = e.clientX;
    dragStartWidthsRef.current = { left: panelWidths.left, middle: panelWidths.middle };
    
    const handleMouseMove = (moveEvent: MouseEvent) => {
      const delta = moveEvent.clientX - dragStartXRef.current;
      const newWidths = { ...dragStartWidthsRef.current };
      
      if (panel === "left") {
        newWidths.left = Math.max(180, Math.min(400, dragStartWidthsRef.current.left + delta));
      } else if (panel === "middle") {
        newWidths.middle = Math.max(200, Math.min(500, dragStartWidthsRef.current.middle + delta));
      }
      
      setPanelWidths(newWidths);
    };
    
    const handleMouseUp = () => {
      setIsDragging(null);
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
    
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  }

  useEffect(() => {
    localStorage.setItem("agenthub_panel_widths", JSON.stringify(panelWidths));
  }, [panelWidths]);

  function handleInjectContext() {
    if (!contextFilePath) { notify("info", "暂无上下文文件"); return; }
    const handle = activeConvId ? terminalRefs.current.get(activeConvId) : null;
    if (handle) {
      handle.writeToPty(`请阅读项目上下文文件: ${contextFilePath}\n`);
      notify("success", `已注入文件引用: ${contextFilePath}`);
    } else {
      notify("error", "终端未就绪");
    }
  }

  async function handleDeleteConversation(e: React.MouseEvent, convId: string) {
    e.preventDefault();
    e.stopPropagation();
    logger.debug("[DeleteConversation] Triggered for:", convId);
    setConfirmDeleteConvId(convId);
  }

  async function confirmDeleteConversation(convId: string) {
    setConfirmDeleteConvId(null);
    try {
      const db = await getDb();
      await db.execute("DELETE FROM memories WHERE conversation_id = $1", [convId]);
      await db.execute("DELETE FROM conversations WHERE id = $1", [convId]);
      
      if (activeConvId === convId) {
        setActiveConvId(null);
      }
      
      setActiveTerminalIds(prev => {
        const next = new Set(prev);
        next.delete(convId);
        return next;
      });
      
      terminalRefs.current.delete(convId);
      extractedMapRef.current.delete(convId);
      lastOutputLenRef.current.delete(convId);
      
      if (activeProjectId) {
        await loadConversations(activeProjectId);
        await loadMemories(activeProjectId);
        await saveContextFile(activeProjectId);
      }
      notify("success", "对话已删除");
    } catch (err) {
      logger.error("[DeleteConversation] Failed:", err);
      notify("error", `删除对话失败: ${err}`);
    }
  }

  async function handleDeleteProject(e: React.MouseEvent, projectId: string) {
    e.stopPropagation();
    const proj = projectsRef.current.find(p => p.id === projectId);
    if (!proj) return;
    setDeleteProjectMode("soft");
    setDeleteProjectState({ id: proj.id, name: proj.name, path: proj.path });
  }

  async function confirmDeleteProject() {
    if (!deleteProjectState) return;
    const { id: projectId, path: projectPath } = deleteProjectState;
    setDeleteProjectState(null);
    try {
      const db = await getDb();

      const convs = await db.select<{ id: string }[]>(
        "SELECT id FROM conversations WHERE project_id = $1", [projectId]
      );
      for (const c of convs) {
        if (activeConvId === c.id) setActiveConvId(null);
        setActiveTerminalIds(prev => { const n = new Set(prev); n.delete(c.id); return n; });
        terminalRefs.current.delete(c.id);
        extractedMapRef.current.delete(c.id);
        lastOutputLenRef.current.delete(c.id);
      }

      await db.execute("DELETE FROM memories WHERE project_id = $1", [projectId]);
      await db.execute("DELETE FROM conversations WHERE project_id = $1", [projectId]);
      await db.execute("DELETE FROM projects WHERE id = $1", [projectId]);

      if (deleteProjectMode === "hard" && projectPath) {
        try {
          const { invoke } = await import("@tauri-apps/api/core");
          await invoke("remove_dir", { path: projectPath });
        } catch (dirErr) {
          logger.error("[DeleteProject] 删除目录失败:", dirErr);
          notify("error", `项目记录已删除，但目录删除失败: ${dirErr}`);
          await loadProjects();
          if (activeProjectId === projectId) setActiveProjectId(null);
          return;
        }
      }

      if (activeProjectId === projectId) setActiveProjectId(null);
      await loadProjects();
      notify("success", deleteProjectMode === "hard" ? "项目及目录已彻底删除" : "项目已移除（目录保留）");
    } catch (err) {
      logger.error("[DeleteProject] Failed:", err);
      notify("error", `删除项目失败: ${err}`);
    }
  }

  function handleSelectConversation(convId: string) {
    const conv = conversations.find((c) => c.id === convId);
    if (!conv) return;
    setActiveConvId(convId);
    if (conv.status === "active" && conv.agent_id) {
      setActiveTerminalIds(prev => { const next = new Set(prev); next.add(convId); return next; });
    }
  }

  function handleSaveSettings() {
    saveDistillConfig({ apiKey: llmApiKey, apiUrl: llmApiUrl, model: llmModel });
    setShowSettings(false);
    notify("success", "LLM 蒸馏配置已保存");
  }

  async function handleSyncSessions() {
    if (!activeProjectId) return;
    try {
      setDistillStatus("正在同步 Agent 日志...");
      const projectPath = getProjectDir(activeProjectId);
      const sessions = await readAllSessions(projectPath || undefined);
      logger.debug("[SyncSessions] 项目路径:", projectPath, "匹配到会话数:", sessions.size);
      sessionDataRef.current = sessions;
      let totalNewItems = 0;
      const db = await getDb();
      const pid = activeProjectId;

      // 跨对话聚合收集器
      const aggregatedByCategory: Record<MemoryCategory, { items: string[]; title: string; priority: number }> = {
        feedback: { items: [], title: "用户需求", priority: 8 },
        implementation: { items: [], title: "Agent回复", priority: 6 },
        general: { items: [], title: "思考过程", priority: 5 },
        variable: { items: [], title: "涉及文件", priority: 7 },
        decision: { items: [], title: "技术决策", priority: 9 },
      };

      for (const [sessionId, { agent, conv }] of sessions) {
        logger.debug(`[SyncSessions] 处理会话 ${sessionId} (agent=${agent}):`,
          "用户消息=", conv.userMessages.length,
          "回复=", conv.agentResponses.length,
          "思考=", conv.agentThinking.length,
          "文件=", conv.files.length
        );

        if (conv.userMessages.length === 0 && conv.agentResponses.length === 0) continue;

        const info = sessionConvToExtractedInfo(conv);
        const cid = sessionId;

        // 收集到聚合器
        info.user_requirements.forEach(item => {
          const key = item.slice(0, 100);
          if (!aggregatedByCategory.feedback.items.some(i => i.includes(key))) {
            aggregatedByCategory.feedback.items.push(item);
          }
        });
        
        info.agent_summary.forEach(item => {
          const key = item.slice(0, 100);
          if (!aggregatedByCategory.implementation.items.some(i => i.includes(key))) {
            aggregatedByCategory.implementation.items.push(item);
          }
        });
        
        info.agent_thinking.forEach(item => {
          const key = item.slice(0, 80);
          if (!aggregatedByCategory.general.items.some(i => i.includes(key))) {
            aggregatedByCategory.general.items.push(`[${cid}] ${item}`);
          }
        });
        
        info.key_files.forEach(file => {
          if (!aggregatedByCategory.variable.items.includes(file)) {
            aggregatedByCategory.variable.items.push(file);
          }
        });
        
        info.technical_decisions.forEach(dec => {
          if (!aggregatedByCategory.decision.items.includes(dec)) {
            aggregatedByCategory.decision.items.push(dec);
          }
        });

        // 保存提取信息到 ref
        const llmResult: DistillResult = {
          user_requirements: info.user_requirements,
          agent_summary: info.agent_summary,
          agent_thinking: info.agent_thinking,
          key_files: info.key_files,
          technical_decisions: info.technical_decisions,
        };
        extractedMapRef.current.set(cid, {
          llmResult,
          fallbackUserMessages: info.user_requirements,
          fallbackFiles: info.key_files,
          fallbackActions: info.agent_summary,
          fallbackThinkings: info.agent_thinking,
        });
      }

      // 聚合写入数据库（每个类别只有1条记录）
      for (const [category, { items, title, priority }] of Object.entries(aggregatedByCategory)) {
        if (items.length === 0) continue;
        
        // 限制每类最多显示数量，避免过长
        const maxItems = category === 'variable' ? 15 : 
                        category === 'general' ? 8 : 
                        category === 'implementation' ? 10 : 5;
        const limitedItems = items.slice(0, maxItems);
        
        const aggregatedContent = `[${title}] (${limitedItems.length}条)\n` + 
          limitedItems.map((item, idx) => `${idx + 1}. ${item.slice(0, 250).trim()}`).join('\n');
        
        try {
          const existing = await db.select<{ id: string, content: string }[]>(
            "SELECT id, content FROM memories WHERE project_id = $1 AND category = $2 AND conversation_id IS NULL",
            [pid, category]
          );
          
          if (existing.length > 0) {
            if (existing[0].content !== aggregatedContent) {
              await db.execute(
                "UPDATE memories SET content = $1, updated_at = $2 WHERE id = $3",
                [aggregatedContent, Date.now(), existing[0].id]
              );
            }
          } else {
            const id = crypto.randomUUID();
            const ts = Date.now();
            await db.execute(
              "INSERT INTO memories (id, project_id, conversation_id, category, content, detail, priority, status, tags, created_at, updated_at) VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, $9, $10)",
              [id, pid, category, aggregatedContent, null, priority, "active", null, ts, ts]
            );
            totalNewItems++;
          }
        } catch (dbErr) {
          logger.error(`[SyncSessions] 写入聚合记忆(${title})失败:`, dbErr);
        }
      }

      await loadMemories(pid);
      await saveContextFile(pid);
      setDistillStatus("");
      notify("success", `同步完成：${sessions.size} 个会话已聚合为 ${Object.values(aggregatedByCategory).filter(c => c.items.length > 0).length} 条记忆`);
    } catch (err) {
      logger.error("[SyncSessions] 同步失败:", err);
      setDistillStatus("");
      notify("error", `同步失败: ${err}`);
    }
  }

  const activeConv = conversations.find((c) => c.id === activeConvId);
  const hasLlmKey = !!localStorage.getItem("agenthub_llm_api_key");

  return (
    <div style={{ display: "flex", height: "100vh", background: "#1e1e1e", color: "#d4d4d4" }}>
      {notification && (
        <div style={{
          position: "fixed", top: 16, right: 16, padding: "10px 18px", borderRadius: 6,
          color: "white", fontWeight: 600, fontSize: 13, zIndex: 1000, maxWidth: 360,
          boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
          background: notification.type === "success" ? "#22c55e" : notification.type === "error" ? "#ef4444" : "#3b82f6",
        }}>
          {notification.message}
        </div>
      )}

      {confirmDeleteConvId && (
        <div style={{
          position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
          background: "rgba(0, 0, 0, 0.6)", zIndex: 2000,
          display: "flex", alignItems: "center", justifyContent: "center"
        }}>
          <div style={{
            background: "#252526", padding: "20px 24px", borderRadius: 8,
            boxShadow: "0 8px 24px rgba(0,0,0,0.5)", width: 320, border: "1px solid #333"
          }}>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 12, color: "#e2e2e2" }}>确认删除对话</div>
            <div style={{ fontSize: 13, color: "#aaa", marginBottom: 20, lineHeight: 1.5 }}>
              确定要删除对话 <strong>{conversations.find(c => c.id === confirmDeleteConvId)?.title}</strong> 及其所有记忆吗？此操作不可恢复。
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button onClick={() => setConfirmDeleteConvId(null)} style={{ padding: "6px 12px", background: "transparent" }}>取消</button>
              <button onClick={() => confirmDeleteConversation(confirmDeleteConvId)} style={{ padding: "6px 12px", background: "#ef4444", color: "white", border: "none" }}>确认删除</button>
            </div>
          </div>
        </div>
      )}

      {deleteProjectState && (
        <div style={{
          position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
          background: "rgba(0, 0, 0, 0.6)", zIndex: 2000,
          display: "flex", alignItems: "center", justifyContent: "center"
        }}>
          <div style={{
            background: "#252526", padding: "20px 24px", borderRadius: 8,
            boxShadow: "0 8px 24px rgba(0,0,0,0.5)", width: 400, border: "1px solid #333"
          }}>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 12, color: "#e2e2e2" }}>删除项目</div>
            <div style={{ fontSize: 13, color: "#aaa", marginBottom: 16, lineHeight: 1.5 }}>
              确定要删除项目 <strong style={{ color: "#e2e2e2" }}>{deleteProjectState.name}</strong> 吗？
            </div>
            <div style={{ fontSize: 12, color: "#888", marginBottom: 8 }}>项目路径：{deleteProjectState.path}</div>
            <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer", padding: "8px 12px", borderRadius: 6, border: deleteProjectMode === "soft" ? "1px solid #007acc" : "1px solid #444", background: deleteProjectMode === "soft" ? "rgba(0,122,204,0.1)" : "transparent" }}>
                <input type="radio" name="deleteMode" checked={deleteProjectMode === "soft"} onChange={() => setDeleteProjectMode("soft")} />
                <div>
                  <div style={{ fontWeight: 600, color: deleteProjectMode === "soft" ? "#007acc" : "#d4d4d4" }}>软删除</div>
                  <div style={{ fontSize: 11, color: "#888" }}>仅移除项目记录，保留文件</div>
                </div>
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer", padding: "8px 12px", borderRadius: 6, border: deleteProjectMode === "hard" ? "1px solid #ef4444" : "1px solid #444", background: deleteProjectMode === "hard" ? "rgba(239,68,68,0.1)" : "transparent" }}>
                <input type="radio" name="deleteMode" checked={deleteProjectMode === "hard"} onChange={() => setDeleteProjectMode("hard")} />
                <div>
                  <div style={{ fontWeight: 600, color: deleteProjectMode === "hard" ? "#ef4444" : "#d4d4d4" }}>硬删除</div>
                  <div style={{ fontSize: 11, color: "#888" }}>同时删除项目目录及所有文件</div>
                </div>
              </label>
            </div>
            {deleteProjectMode === "hard" && (
              <div style={{ fontSize: 12, color: "#ef4444", marginBottom: 12, padding: "6px 10px", background: "rgba(239,68,68,0.1)", borderRadius: 4 }}>
                ⚠️ 硬删除将永久移除项目目录下的所有文件，此操作不可恢复！
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button onClick={() => setDeleteProjectState(null)} style={{ padding: "6px 12px", background: "transparent" }}>取消</button>
              <button onClick={confirmDeleteProject} style={{ padding: "6px 12px", background: deleteProjectMode === "hard" ? "#ef4444" : "#f59e0b", color: deleteProjectMode === "hard" ? "white" : "#1a1a2e", border: "none", fontWeight: 600 }}>
                {deleteProjectMode === "hard" ? "彻底删除" : "移除项目"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 左侧面板 - 项目和对话列表 */}
      <div style={{ 
        width: panelWidths.left, 
        minWidth: 180, 
        maxWidth: 400,
        borderRight: "1px solid #333", 
        display: "flex", 
        flexDirection: "column", 
        background: "#252526",
        position: "relative"
      }}>
        <div className="panel-header">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%" }}>
            <span style={{ fontSize: 14, fontWeight: 700, letterSpacing: "0.5px" }}>AgentHub</span>
            <div style={{ display: "flex", gap: 6 }}>
              <button onClick={() => setShowSettings(!showSettings)} style={{ fontSize: 12, padding: "4px 8px" }} title="设置">⚙️</button>
              <button onClick={() => setShowNewProject(!showNewProject)} className="primary-btn" style={{ fontSize: 12, padding: "4px 8px" }}>+ 项目</button>
            </div>
          </div>
        </div>
        {showSettings && (
          <div style={{ margin: "8px 12px", background: "#1e1e1e", padding: 12, borderRadius: 6, fontSize: 11, border: "1px solid #444" }}>
            <div style={{ marginBottom: 8, fontWeight: 600, color: "#e2e2e2" }}>LLM 蒸馏配置</div>
            <input value={llmApiKey} onChange={(e) => setLlmApiKey(e.target.value)}
              placeholder="API Key (如 GLM API Key)" type="password"
              style={{ width: "100%", fontSize: 12, padding: "6px 8px", marginBottom: 6, background: "#2d2d2d", border: "1px solid #555", color: "#d4d4d4", borderRadius: 4 }}
            />
            <input value={llmApiUrl} onChange={(e) => setLlmApiUrl(e.target.value)}
              placeholder="API URL"
              style={{ width: "100%", fontSize: 12, padding: "6px 8px", marginBottom: 6, background: "#2d2d2d", border: "1px solid #555", color: "#d4d4d4", borderRadius: 4 }}
            />
            <input value={llmModel} onChange={(e) => setLlmModel(e.target.value)}
              placeholder="模型 (如 glm-4-flash)"
              style={{ width: "100%", fontSize: 12, padding: "6px 8px", marginBottom: 8, background: "#2d2d2d", border: "1px solid #555", color: "#d4d4d4", borderRadius: 4 }}
            />
            <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
              <button onClick={() => setShowSettings(false)} style={{ fontSize: 11, padding: "4px 10px", background: "transparent" }}>取消</button>
              <button onClick={handleSaveSettings} className="primary-btn" style={{ fontSize: 11, padding: "4px 10px" }}>保存</button>
            </div>
          </div>
        )}
        {showNewProject && (
          <div style={{ margin: "8px 12px", background: "#1e1e1e", padding: 12, borderRadius: 6, border: "1px solid #444" }}>
            <input value={newProjectName} onChange={(e) => setNewProjectName(e.target.value)}
              placeholder="项目名称" autoFocus
              style={{ width: "100%", fontSize: 12, padding: "6px 8px", marginBottom: 6, background: "#2d2d2d", border: "1px solid #555", color: "#d4d4d4", borderRadius: 4 }}
            />
            <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
              <input value={newProjectPath} onChange={(e) => setNewProjectPath(e.target.value)}
                placeholder="请选择项目文件夹"
                style={{ flex: 1, fontSize: 12, padding: "6px 8px", background: "#2d2d2d", border: "1px solid #555", color: "#d4d4d4", borderRadius: 4 }}
              />
              <button onClick={handleSelectProjectFolder} style={{ fontSize: 11, padding: "4px 10px", whiteSpace: "nowrap" }}>📂 选择</button>
            </div>
            <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
              <button onClick={() => { setShowNewProject(false); setNewProjectName(""); setNewProjectPath(""); }} style={{ fontSize: 11, padding: "4px 10px", background: "transparent" }}>取消</button>
              <button onClick={handleCreateProject} className="primary-btn" style={{ fontSize: 11, padding: "4px 10px" }}>创建</button>
            </div>
          </div>
        )}

        <div style={{ flex: 1, overflow: "auto" }}>
          {projects.map((p) => (
            <div key={p.id}>
              <div 
                className={`project-item ${activeProjectId === p.id ? "active" : ""}`}
                onClick={() => setActiveProjectId(p.id)}
              >
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>📁 {p.name}</span>
                <button 
                  className="delete-btn" 
                  onClick={(e) => handleDeleteProject(e, p.id)}
                  title="删除项目"
                >🗑️</button>
              </div>
              {activeProjectId === p.id && conversations.map((c) => (
                <div key={c.id} 
                  className={`conv-item ${activeConvId === c.id ? "active" : ""} ${c.status === "completed" ? "completed" : ""}`}
                  onClick={() => handleSelectConversation(c.id)}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 6, overflow: "hidden" }}>
                    <span>{c.status === "completed" ? "✅" : "💬"}</span>
                    <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.title}</span>
                    {c.agent_id && <span style={{ fontSize: 10, color: "#888", flexShrink: 0 }}>({agents.find(a => a.id === c.agent_id)?.name || c.agent_id})</span>}
                  </div>
                  <button 
                    className="delete-btn" 
                    onClick={(e) => handleDeleteConversation(e, c.id)}
                    title="删除对话"
                  >
                    🗑️
                  </button>
                </div>
              ))}
              {activeProjectId === p.id && (
                <div style={{ padding: "8px 16px 8px 32px" }}>
                  {showNewConv ? (
                    <div style={{ background: "#1e1e1e", padding: 12, borderRadius: 6, border: "1px solid #444" }}>
                      <input value={newConvTitle} onChange={(e) => setNewConvTitle(e.target.value)}
                        placeholder="对话标题" autoFocus
                        style={{ width: "100%", fontSize: 12, padding: "6px 8px", marginBottom: 6, background: "#2d2d2d", border: "1px solid #555", color: "#d4d4d4", borderRadius: 4 }}
                        onKeyDown={(e) => e.key === "Enter" && handleCreateConversation()}
                      />
                      <select value={newConvAgent} onChange={(e) => setNewConvAgent(e.target.value)}
                        style={{ width: "100%", fontSize: 12, padding: "6px 8px", marginBottom: 8, background: "#2d2d2d", border: "1px solid #555", color: "#d4d4d4", borderRadius: 4 }}
                      >
                        <option value="">选择 Agent（可选）</option>
                        {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                      </select>
                      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                        <button onClick={() => setShowNewConv(false)} style={{ fontSize: 11, padding: "4px 10px", background: "transparent" }}>取消</button>
                        <button onClick={handleCreateConversation} className="primary-btn" style={{ fontSize: 11, padding: "4px 10px" }}>创建</button>
                      </div>
                    </div>
                  ) : (
                    <button onClick={() => setShowNewConv(true)} style={{ fontSize: 12, padding: "6px 8px", width: "100%", borderStyle: "dashed" }}>+ 新对话</button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
        <div style={{ padding: "10px 16px", borderTop: "1px solid #333", fontSize: 11, color: "#888", display: "flex", justifyContent: "space-between", alignItems: "center", background: "#252526" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: dbReady ? "#22c55e" : "#f59e0b" }}></div>
              {dbReady ? "DB 就绪" : "初始化中..."}
            </span>
            {hasLlmKey && <span style={{ color: "#3b82f6", fontWeight: 600 }}>🧠 LLM</span>}
          </div>
          <button onClick={handleSyncSessions} className="warning-btn" style={{ fontSize: 11, padding: "4px 10px", fontWeight: 600 }}>
            📂 同步日志
          </button>
        </div>
      </div>

      {/* 第一个拖拽手柄 */}
      <div
        onMouseDown={(e) => handleDragStart(e, "left")}
        style={{
          width: 4,
          cursor: "col-resize",
          background: isDragging === "left" ? "#007acc" : "#333",
          transition: isDragging === "left" ? "none" : "background 0.2s",
          flexShrink: 0,
          zIndex: 10,
        }}
        title="拖动调整宽度"
      />

      {/* 中间面板 - 项目记忆 */}
      <div style={{ 
        width: panelWidths.middle, 
        minWidth: 200, 
        maxWidth: 500,
        borderRight: "1px solid #333", 
        display: "flex", 
        flexDirection: "column", 
        background: "#1e1e1e" 
      }}>
        <div className="panel-header-column">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%" }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>项目记忆</span>
            <button onClick={handleCopyContext} style={{ fontSize: 11, padding: "4px 8px" }} title="复制上下文">📋 复制</button>
          </div>
          {contextFilePath && (
            <div style={{ fontSize: 10, color: "#0dbc79", marginTop: 4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={contextFilePath}>
              📄 {contextFilePath}
            </div>
          )}
        </div>
        <div style={{ flex: 1, overflow: "auto", padding: 12 }}>
          {memories.length === 0 ? (
            <div style={{ color: "#555", fontSize: 12, textAlign: "center", marginTop: 40 }}>
              暂无项目记忆<br />
              <span style={{ fontSize: 11, color: "#444" }}>系统会自动从终端对话中提取上下文</span>
            </div>
          ) : (
            memories.map((m) => (
              <div key={m.id} className="memory-card" style={{
                borderLeft: `3px solid ${CATEGORY_COLORS[m.category] || "#9ca3af"}`,
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                  <span style={{ fontSize: 10, color: CATEGORY_COLORS[m.category], fontWeight: 600, background: `${CATEGORY_COLORS[m.category]}15`, padding: "2px 6px", borderRadius: 4 }}>
                    {CATEGORY_LABELS[m.category] || m.category}
                  </span>
                  <button onClick={() => handleDeleteMemory(m.id)}
                    style={{ fontSize: 10, padding: "2px 6px", background: "transparent", border: "none", color: "#888", cursor: "pointer" }}
                    title="删除记忆"
                  >✕</button>
                </div>
                <div style={{ fontSize: 12, lineHeight: 1.5, color: "#e2e2e2", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{m.content}</div>
                {m.detail && <div style={{ fontSize: 11, color: "#999", marginTop: 4, padding: "4px 8px", background: "rgba(0,0,0,0.2)", borderRadius: 4, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{m.detail}</div>}
              </div>
            ))
          )}
        </div>
      </div>

      {/* 第二个拖拽手柄 */}
      <div
        onMouseDown={(e) => handleDragStart(e, "middle")}
        style={{
          width: 4,
          cursor: "col-resize",
          background: isDragging === "middle" ? "#007acc" : "#333",
          transition: isDragging === "middle" ? "none" : "background 0.2s",
          flexShrink: 0,
          zIndex: 10,
        }}
        title="拖动调整宽度"
      />

      {/* 右侧面板 - 终端区域 */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", background: "#1e1e1e" }}>
        {activeConv && (
          <div className="panel-header">
            <div>
              <span style={{ fontSize: 14, fontWeight: 600 }}>💬 {activeConv.title}</span>
              {activeConv.agent_id && (
                <span style={{ fontSize: 12, color: "#888", marginLeft: 12 }}>
                  Agent: {agents.find(a => a.id === activeConv.agent_id)?.name || activeConv.agent_id}
                </span>
              )}
              {distillStatus && <span style={{ fontSize: 11, color: "#0dbc79", marginLeft: 12, padding: "2px 6px", background: "rgba(13, 188, 121, 0.1)", borderRadius: 4 }}>{distillStatus}</span>}
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {activeConv.status === "active" && activeConv.agent_id && (
                <button onClick={() => autoDistill()} className="success-btn" style={{ fontSize: 12, padding: "4px 10px" }}>
                  🔄 蒸馏
                </button>
              )}
              {activeConv.status === "active" && activeConv.agent_id && (
                <button onClick={handleInjectContext} className="primary-btn" style={{ fontSize: 12, padding: "4px 10px" }}>
                  📥 注入上下文
                </button>
              )}
            </div>
          </div>
        )}

        <div style={{ flex: 1, position: "relative" }}>
          {Array.from(activeTerminalIds).map(convId => {
            const conv = conversations.find(c => c.id === convId);
            if (!conv || !conv.agent_id) return null;
            const isActive = convId === activeConvId;
            return (
              <div key={convId} style={{
                display: isActive ? "flex" : "none",
                flexDirection: "column",
                width: "100%",
                height: "100%",
              }}>
                <TerminalPanel
                  ref={(el) => {
                    if (el) terminalRefs.current.set(convId, el);
                    else terminalRefs.current.delete(convId);
                  }}
                  agentId={conv.agent_id}
                  workingDir={activeProjectId && projects.find(p => p.id === activeProjectId)?.path || null}
                  onExit={(agentId, code) => {
                    notify("info", `${agentId} 已退出，退出码: ${code ?? "unknown"}`);
                  }}
                />
              </div>
            );
          })}

          {(activeTerminalIds.size === 0 || !activeConvId || !conversations.find(c => c.id === activeConvId)?.agent_id) && (
            <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "#555" }}>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 40, marginBottom: 12 }}>⌨️</div>
                <div>{activeConv?.status === "completed" ? "对话已归档" : "选择一个对话并启动 Agent"}</div>
                <div style={{ fontSize: 12, marginTop: 4, color: "#444" }}>
                  左侧创建新对话 → 选择 Agent → 开始交互
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;
