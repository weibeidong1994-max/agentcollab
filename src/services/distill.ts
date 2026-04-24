import { logger } from "../utils/log";
const DEFAULT_API_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const DEFAULT_MODEL = "glm-4-flash";

const DISTILL_SYSTEM_PROMPT = `你是一个对话上下文提取助手。你的任务是从AI编程助手（如Claude Code、KimiCode）的终端对话输出中，提取出对后续对话有价值的关键信息。

终端输出中混杂了多种内容，你需要区分：
- 用户输入：通常以 › 或 > 开头，或者是中文指令
- Agent思考：Agent内部的推理过程，通常包含"我可以用...实现"、"让我创建..."等
- Agent回复：Agent给用户的最终回复，包含实现结果、特性说明等
- 工具调用：文件读写、命令执行等操作
- UI噪声：进度条、审批提示、状态信息等

请以纯JSON格式返回（不要markdown代码块），包含以下字段：

{
  "user_requirements": ["用户的原始需求，用自然语言完整描述"],
  "agent_summary": ["Agent最终告诉用户的关键结果，保留原文核心内容"],
  "agent_thinking": ["Agent思考过程中的关键决策点和方案选择"],
  "key_files": ["涉及或创建的文件完整路径"],
  "technical_decisions": ["技术方案选择和架构决策"]
}

提取要求：
1. user_requirements：只提取用户明确说出的需求，不要把Agent的思考当作用户需求
   - 正确："写一个贪食蛇小游戏"
   - 错误："我可以用一个HTML文件实现"（这是Agent思考）
2. agent_summary：提取Agent给用户的最终回复的核心内容，保留关键细节
   - 包括：创建了什么、保存在哪里、有什么特性、怎么使用
   - 保留有价值的格式信息（如emoji、文件路径）
3. agent_thinking：只提取Agent思考中真正有价值的决策点
   - 正确："用一个HTML文件实现，包含Canvas和键盘事件监听"
   - 错误："这是一个相对简单的任务"（无信息量）
4. key_files：只提取真实存在的文件路径，不要提取URL片段或部分路径
5. technical_decisions：技术选型和架构决策
6. 每个字段最多10条，按重要性排序
7. 去除所有UI噪声（进度条、审批提示、状态码等）
8. 返回纯JSON，不要任何额外文字或markdown标记`;

const DISTILL_USER_PROMPT = `请从以下终端对话输出中提取关键上下文信息。注意区分用户输入、Agent思考、Agent回复和UI噪声。

---

`;

export interface DistillResult {
  user_requirements: string[];
  agent_summary: string[];
  agent_thinking: string[];
  key_files: string[];
  technical_decisions: string[];
}

export interface DistillConfig {
  apiKey: string;
  apiUrl: string;
  model: string;
}

export function getDistillConfig(): DistillConfig {
  let apiKey = localStorage.getItem("agenthub_llm_api_key") || "";
  let apiUrl = localStorage.getItem("agenthub_llm_api_url") || DEFAULT_API_URL;
  let model = localStorage.getItem("agenthub_llm_model") || DEFAULT_MODEL;

  if (!apiUrl || apiUrl.includes("/v4/") || apiUrl.includes("/v4\\")) {
    apiUrl = DEFAULT_API_URL;
    localStorage.setItem("agenthub_llm_api_url", apiUrl);
  }

  return { apiKey, apiUrl, model };
}

export function saveDistillConfig(config: Partial<DistillConfig>): void {
  if (config.apiKey !== undefined) localStorage.setItem("agenthub_llm_api_key", config.apiKey);
  if (config.apiUrl !== undefined) localStorage.setItem("agenthub_llm_api_url", config.apiUrl);
  if (config.model !== undefined) localStorage.setItem("agenthub_llm_model", config.model);
}

export async function llmDistill(
  terminalOutput: string,
  config?: DistillConfig
): Promise<DistillResult | null> {
  const cfg = config || getDistillConfig();
  if (!cfg.apiKey || !terminalOutput.trim()) return null;

  const truncatedOutput = terminalOutput.slice(-8000);

  try {
    const response = await fetch(cfg.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: "system", content: DISTILL_SYSTEM_PROMPT },
          { role: "user", content: DISTILL_USER_PROMPT + truncatedOutput },
        ],
        temperature: 0.1,
        max_tokens: 2000,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      logger.error("[Distill] LLM API error:", response.status, errText);
      return null;
    }

    const data = await response.json();
    const content: string = data.choices?.[0]?.message?.content || "";

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.error("[Distill] No JSON found in LLM response:", content.slice(0, 200));
      return null;
    }

    const result = JSON.parse(jsonMatch[0]) as DistillResult;

    if (!result.user_requirements) result.user_requirements = [];
    if (!result.agent_summary) result.agent_summary = [];
    if (!result.agent_thinking) result.agent_thinking = [];
    if (!result.key_files) result.key_files = [];
    if (!result.technical_decisions) result.technical_decisions = [];

    return result;
  } catch (err) {
    logger.error("[Distill] LLM distill error:", err);
    return null;
  }
}
