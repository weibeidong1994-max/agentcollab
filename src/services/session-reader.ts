import { logger } from "../utils/log";
import { readFile, listDir } from "./pty";

export interface SessionConversation {
  userMessages: string[];
  agentThinking: string[];
  agentResponses: string[];
  toolCalls: { name: string; args: string }[];
  files: string[];
}

let _homeDir: string | null = null;

async function getHome(): Promise<string> {
  if (_homeDir) return _homeDir;
  const { homeDir } = await import("@tauri-apps/api/path");
  _homeDir = await homeDir();
  return _homeDir;
}

export async function getKimiSessionsDir(): Promise<string> {
  return `${await getHome()}/.kimi/sessions`;
}

export async function getClaudeProjectsDir(): Promise<string> {
  return `${await getHome()}/.claude/projects`;
}

function isSessionRelevantToProject(conv: SessionConversation, projectPath: string): boolean {
  const normalizedProject = projectPath.replace(/^~/, "").replace(/\/+$/, "");
  for (const file of conv.files) {
    const normalizedFile = file.replace(/^~/, "");
    if (normalizedFile.includes(normalizedProject) || normalizedProject.includes(normalizedFile.split("/").slice(0, -1).join("/"))) {
      return true;
    }
  }
  for (const tc of conv.toolCalls) {
    if (tc.args.includes(normalizedProject)) return true;
  }
  for (const msg of conv.agentResponses) {
    if (msg.includes(normalizedProject)) return true;
  }
  return false;
}

export async function readKimiSessions(projectPath?: string): Promise<Map<string, SessionConversation>> {
  const result = new Map<string, SessionConversation>();
  try {
    const KIMI_SESSIONS_DIR = await getKimiSessionsDir();
    const userDirs = await listDir(KIMI_SESSIONS_DIR);
    logger.debug("[SessionReader] Kimi用户目录数:", userDirs.length);
    for (const userDirName of userDirs) {
      const userPath = `${KIMI_SESSIONS_DIR}/${userDirName}`;
      try {
        const sessionDirs = await listDir(userPath);
        logger.debug(`[SessionReader] ${userDirName} 下会话数:`, sessionDirs.length);
        for (const sessionDirName of sessionDirs) {
          const contextPath = `${userPath}/${sessionDirName}/context.jsonl`;
          try {
            const content = await readFile(contextPath);
            const conv = parseKimiContextJsonl(content);
            if (conv && (conv.userMessages.length > 0 || conv.agentResponses.length > 0)) {
              if (projectPath && !isSessionRelevantToProject(conv, projectPath)) continue;
              logger.debug(`[SessionReader] 匹配成功 ${sessionDirName}: user=${conv.userMessages.length} text=${conv.agentResponses.length} think=${conv.agentThinking.length} files=${conv.files.length}`);
              result.set(sessionDirName, conv);
            }
          } catch (err) {
            logger.debug(`[SessionReader] 读取失败 ${contextPath}:`, String(err).slice(0, 80));
          }
        }
      } catch (err) {
        logger.error("[SessionReader] 列目录失败:", userPath, String(err).slice(0, 80));
      }
    }
  } catch (err) {
    logger.error("[SessionReader] 读取Kimi会话失败:", err);
  }
  logger.debug("[SessionReader] Kimi有效会话总数:", result.size);
  return result;
}

function parseKimiContextJsonl(content: string): SessionConversation | null {
  const conv: SessionConversation = {
    userMessages: [],
    agentThinking: [],
    agentResponses: [],
    toolCalls: [],
    files: [],
  };
  const lines = content.split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.role === "user" && typeof obj.content === "string" && obj.content.trim()) {
        const text = obj.content.trim();
        if (!isNoiseMessage(text)) {
          conv.userMessages.push(text);
        }
      } else if (obj.role === "assistant") {
        if (Array.isArray(obj.content)) {
          for (const part of obj.content) {
            if (part.type === "think" && part.think && part.think.trim()) {
              conv.agentThinking.push(part.think.trim());
            } else if (part.type === "text" && part.text && part.text.trim()) {
              conv.agentResponses.push(part.text.trim());
            } else if (part.type === "tool_use" && part.name) {
              conv.toolCalls.push({ name: part.name, args: JSON.stringify(part.input || {}) });
              if (part.name === "WriteFile" || part.name === "EditFile") {
                if (part.input?.path) conv.files.push(part.input.path);
              }
            }
          }
        }
        if (Array.isArray(obj.tool_calls)) {
          for (const tc of obj.tool_calls) {
            if (tc.function) {
              conv.toolCalls.push({ name: tc.function.name || "", args: tc.function.arguments || "" });
              if (tc.function.name === "WriteFile" || tc.function.name === "EditFile") {
                try {
                  const args = JSON.parse(tc.function.arguments);
                  if (args.path) conv.files.push(args.path);
                } catch {}
              }
            }
          }
        }
      }
    } catch {}
  }
  return conv;
}

function isNoiseMessage(text: string): boolean {
  const noisePatterns = [
    /^(y|yes|n|no|ok|okay|好的|确认|继续|可以)$/i,
    /^\/(exit|quit|clear|help)$/,
    /^\.{1,3}$/,
    /^请阅读项目上下文文件/,
  ];
  return noisePatterns.some(p => p.test(text.trim()));
}

export async function readClaudeSessions(projectPath?: string): Promise<Map<string, SessionConversation>> {
  const result = new Map<string, SessionConversation>();
  try {
    const CLAUDE_PROJECTS_DIR = await getClaudeProjectsDir();
    const projectDirs = await listDir(CLAUDE_PROJECTS_DIR);
    logger.debug("[SessionReader] Claude项目目录数:", projectDirs.length);
    for (const projectDirName of projectDirs) {
      if (projectPath && !projectDirName.includes(projectPath.replace(/\//g, "-"))) continue;
      const projPath = `${CLAUDE_PROJECTS_DIR}/${projectDirName}`;
      try {
        const files = await listDir(projPath);
        for (const fileName of files) {
          if (!fileName.endsWith(".jsonl")) continue;
          try {
            const content = await readFile(`${projPath}/${fileName}`);
            const conv = parseClaudeSessionJsonl(content);
            if (conv && (conv.userMessages.length > 0 || conv.agentResponses.length > 0)) {
              result.set(fileName.replace(".jsonl", ""), conv);
            }
          } catch {}
        }
      } catch {}
    }
  } catch (err) {
    logger.error("[SessionReader] 读取Claude会话失败:", err);
  }
  logger.debug("[SessionReader] Claude有效会话总数:", result.size);
  return result;
}

function parseClaudeSessionJsonl(content: string): SessionConversation | null {
  const conv: SessionConversation = {
    userMessages: [],
    agentThinking: [],
    agentResponses: [],
    toolCalls: [],
    files: [],
  };
  const lines = content.split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === "user" && obj.message?.role === "user") {
        const text = typeof obj.message.content === "string"
          ? obj.message.content
          : Array.isArray(obj.message.content)
            ? obj.message.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join(" ")
            : "";
        if (text.trim() && !isNoiseMessage(text.trim())) {
          conv.userMessages.push(text.trim());
        }
      } else if (obj.type === "assistant" && obj.message?.role === "assistant") {
        const content = obj.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "thinking" && block.thinking?.trim()) {
              conv.agentThinking.push(block.thinking.trim());
            } else if (block.type === "text" && block.text?.trim()) {
              conv.agentResponses.push(block.text.trim());
            } else if (block.type === "tool_use" && block.name) {
              conv.toolCalls.push({ name: block.name, args: JSON.stringify(block.input || {}) });
              if (block.name === "Write" || block.name === "Edit" || block.name === "MultiEdit") {
                if (block.input?.file_path) conv.files.push(block.input.file_path);
              }
            }
          }
        } else if (typeof content === "string" && content.trim()) {
          conv.agentResponses.push(content.trim());
        }
      }
    } catch {}
  }
  return conv;
}

export async function readAllSessions(projectPath?: string): Promise<Map<string, { agent: string; conv: SessionConversation }>> {
  const result = new Map<string, { agent: string; conv: SessionConversation }>();

  const kimiSessions = await readKimiSessions(projectPath);
  for (const [id, conv] of kimiSessions) {
    result.set(`kimi:${id}`, { agent: "kimicode", conv });
  }

  const claudeSessions = await readClaudeSessions(projectPath);
  for (const [id, conv] of claudeSessions) {
    result.set(`claude:${id}`, { agent: "claude-code", conv });
  }

  return result;
}

export function sessionConvToExtractedInfo(conv: SessionConversation) {
  const user_requirements: string[] = [];
  for (const msg of conv.userMessages) {
    if (msg.length >= 4 && !isNoiseMessage(msg)) {
      user_requirements.push(msg.slice(0, 500));
    }
  }

  const agent_summary: string[] = [];
  for (const resp of conv.agentResponses) {
    const cleaned = resp.replace(/^(好的|明白|我来|让我|我会|我将|已创建|已修改|已完成|完成)[，,]?\s*/, "");
    if (cleaned.length >= 10) {
      agent_summary.push(cleaned.slice(0, 500));
    }
  }

  const agent_thinking: string[] = [];
  for (const think of conv.agentThinking) {
    if (think.length >= 20 && (think.includes("决定") || think.includes("选择") || think.includes("因为") || think.includes("需要") || think.includes("方案") || think.includes("实现"))) {
      agent_thinking.push(think.slice(0, 400));
    }
  }

  const key_files = [...new Set(conv.files)].slice(0, 20);

  const technical_decisions: string[] = [];
  for (const tc of conv.toolCalls) {
    if (tc.name === "Shell" || tc.name === "Bash") {
      try {
        const args = typeof tc.args === "string" ? JSON.parse(tc.args) : tc.args;
        const cmd = args.command || args.cmd || tc.args;
        if (typeof cmd === "string" && (cmd.includes("install") || cmd.includes("init") || cmd.includes("create") || cmd.includes("build"))) {
          technical_decisions.push(`执行: ${cmd.slice(0, 150)}`);
        }
      } catch {
        if (typeof tc.args === "string" && (tc.args.includes("install") || tc.args.includes("init"))) {
          technical_decisions.push(`执行: ${tc.args.slice(0, 150)}`);
        }
      }
    }
  }

  for (const think of conv.agentThinking) {
    const decisionPatterns = [
      /使用(.{2,20})(?:框架|库|工具|方案|技术)/,
      /选择(.{2,20})(?:而不是|而非|优于)/,
      /决定(?:采用|使用|选择)(.{2,30})/,
      /(?:架构|设计|方案)(?:是|为|采用)(.{2,30})/,
    ];
    for (const pattern of decisionPatterns) {
      const match = think.match(pattern);
      if (match) {
        const decision = match[0].slice(0, 150);
        if (!technical_decisions.some(d => d.includes(decision.slice(0, 20)))) {
          technical_decisions.push(decision);
        }
      }
    }
  }

  return {
    user_requirements: user_requirements.slice(0, 10),
    agent_summary: agent_summary.slice(0, 10),
    agent_thinking: agent_thinking.slice(0, 8),
    key_files,
    technical_decisions: technical_decisions.slice(0, 8),
  };
}
