import Database from "@tauri-apps/plugin-sql";
import type { AgentProfile } from "../types";

const DB_NAME = "sqlite:agenthub.db";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  description TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  agent_id TEXT,
  summary TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  conversation_id TEXT REFERENCES conversations(id),
  category TEXT NOT NULL DEFAULT 'general',
  content TEXT NOT NULL,
  detail TEXT,
  priority INTEGER NOT NULL DEFAULT 5,
  status TEXT NOT NULL DEFAULT 'active',
  tags TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  capabilities TEXT NOT NULL DEFAULT '[]',
  transport TEXT NOT NULL DEFAULT 'cli',
  command TEXT,
  args_template TEXT,
  working_dir_template TEXT,
  timeout_seconds INTEGER NOT NULL DEFAULT 300,
  permissions TEXT NOT NULL DEFAULT '{}',
  healthcheck_command TEXT,
  output_schema_type TEXT,
  orchestration_mode TEXT NOT NULL DEFAULT 'delegated',
  supports_streaming INTEGER NOT NULL DEFAULT 0,
  supports_abort INTEGER NOT NULL DEFAULT 0,
  memory_sync_protocol TEXT NOT NULL DEFAULT 'none',
  quota_source TEXT,
  model_mapping TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_id, category);
CREATE INDEX IF NOT EXISTS idx_memories_conversation ON memories(conversation_id);
CREATE INDEX IF NOT EXISTS idx_memories_priority ON memories(priority DESC);
`;

let _db: Database | null = null;

export function isTauriContext(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function getDb(): Promise<Database> {
  if (_db) return _db;
  if (!isTauriContext()) {
    throw new Error("Not running in Tauri context.");
  }
  _db = await Database.load(DB_NAME);
  return _db;
}

let _initPromise: Promise<void> | null = null;

export async function initDatabase(): Promise<void> {
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    const db = await getDb();
    await db.execute(SCHEMA_SQL);
    await seedDefaultProject(db);
    await seedDefaultAgents(db);
  })();
  return _initPromise;
}

async function seedDefaultProject(db: Database): Promise<void> {
  const now = Date.now();
  await db.execute(
    "INSERT OR IGNORE INTO projects (id, name, path, description, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)",
    ["default", "默认项目", "~/projects/default", "AgentHub 默认项目", now, now]
  );
}

async function seedDefaultAgents(db: Database): Promise<void> {
  const existing = await db.select<{ count: number }[]>(
    "SELECT COUNT(*) as count FROM agent_profiles"
  );
  if (existing[0].count > 0) return;

  const now = Date.now();

  const agents = [
    {
      id: "claude-code", name: "Claude Code", role: "coder",
      capabilities: ["code-generation", "code-refactoring", "debugging", "code-review"],
      command: "claude", quota_source: "glm-pro",
      model_mapping: { peak: "glm-4.7", off_peak: "glm-5.1" },
    },
    {
      id: "kimicode", name: "KimiCode", role: "assistant-coder",
      capabilities: ["code-generation", "long-context", "chinese-optimized"],
      command: "kimi", quota_source: "kimi-moderato",
      model_mapping: { default: "kimi-k2.5" },
    },
    {
      id: "hermes", name: "Hermes Agent", role: "scheduler",
      capabilities: ["cron-scheduling", "notification", "background-process"],
      command: "hermes", quota_source: "glm-pro",
      model_mapping: { peak: "glm-4.7", off_peak: "glm-5.1" },
    },
  ];

  for (const a of agents) {
    await db.execute(
      `INSERT OR IGNORE INTO agent_profiles (id, name, role, capabilities, transport, command, timeout_seconds, permissions, orchestration_mode, supports_streaming, supports_abort, quota_source, model_mapping, enabled, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        a.id, a.name, a.role,
        JSON.stringify(a.capabilities), "cli", a.command, 300,
        JSON.stringify({ file_read: true, file_write: true, shell_exec: true, network: true }),
        "delegated", 1, 1, a.quota_source,
        JSON.stringify(a.model_mapping), 1, now, now,
      ]
    );
  }
}

export async function loadEnabledAgents(): Promise<AgentProfile[]> {
  const db = await getDb();
  return db.select<AgentProfile[]>("SELECT * FROM agent_profiles WHERE enabled = 1");
}
