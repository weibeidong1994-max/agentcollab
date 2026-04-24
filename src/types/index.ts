export interface Project {
  id: string;
  name: string;
  path: string;
  description: string | null;
  created_at: number;
  updated_at: number;
}

export interface Conversation {
  id: string;
  project_id: string;
  title: string;
  agent_id: string | null;
  summary: string | null;
  status: "active" | "completed" | "archived";
  created_at: number;
  updated_at: number;
}

export type MemoryCategory = "decision" | "implementation" | "variable" | "feedback" | "general";

export interface Memory {
  id: string;
  project_id: string;
  conversation_id: string | null;
  category: MemoryCategory;
  content: string;
  detail: string | null;
  priority: number;
  status: "active" | "archived";
  tags: string | null;
  created_at: number;
  updated_at: number;
}

export interface AgentProfile {
  id: string;
  name: string;
  role: string;
  capabilities: string;
  transport: string;
  command: string | null;
  args_template: string | null;
  working_dir_template: string | null;
  timeout_seconds: number;
  permissions: string;
  healthcheck_command: string | null;
  output_schema_type: string | null;
  orchestration_mode: string;
  supports_streaming: number;
  supports_abort: number;
  memory_sync_protocol: string;
  quota_source: string | null;
  model_mapping: string | null;
  enabled: number;
  created_at: number;
  updated_at: number;
}

export const CATEGORY_LABELS: Record<MemoryCategory, string> = {
  decision: "决策",
  implementation: "实现",
  variable: "变量",
  feedback: "反馈",
  general: "通用",
};

export const CATEGORY_COLORS: Record<MemoryCategory, string> = {
  decision: "#f59e0b",
  implementation: "#3b82f6",
  variable: "#22c55e",
  feedback: "#a855f7",
  general: "#9ca3af",
};
