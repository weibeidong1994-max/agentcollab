const IS_DEV = import.meta.env.DEV;

export const logger = {
  debug: (...args: unknown[]) => { if (IS_DEV) console.log("[AgentHub]", ...args); },
  error: (...args: unknown[]) => { if (IS_DEV) console.error("[AgentHub]", ...args); },
};
