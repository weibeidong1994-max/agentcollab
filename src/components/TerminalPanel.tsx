import { useEffect, useRef, useImperativeHandle, forwardRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { ptySpawn, ptyWrite, ptyResize, ptyKill, listenPtyOutput, listenPtyExit } from "../services/pty";
import type { UnlistenFn } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";

interface TerminalPanelProps {
  agentId: string;
  workingDir: string | null;
  onExit?: (agentId: string, exitCode: number | null) => void;
}

export interface TerminalPanelHandle {
  writeToPty: (text: string) => void;
  getOutput: () => string;
  getRawOutput: () => string;
  refit: () => void;
}

const agentConfigs: Record<string, { command: string; buildArgs: () => string[] }> = {
  "claude-code": { command: "claude", buildArgs: () => [] },
  kimicode:      { command: "kimi", buildArgs: () => [] },
  hermes:        { command: "hermes", buildArgs: () => [] },
};

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\x1b\].*?\x07/g, "")
    .replace(/\x1b\[\?[0-9]+[hl]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "");
}

const TerminalPanel = forwardRef<TerminalPanelHandle, TerminalPanelProps>(
  function TerminalPanel({ agentId, workingDir, onExit }, ref) {
    const termRef = useRef<HTMLDivElement>(null);
    const xtermRef = useRef<Terminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const sessionIdRef = useRef<string | null>(null);
    const unlistenRef = useRef<UnlistenFn[]>([]);
    const onDataDisposerRef = useRef<(() => void) | null>(null);
    const mountedRef = useRef(false);
    const outputBufferRef = useRef<string>("");
    const rawBufferRef = useRef<string>("");

    useImperativeHandle(ref, () => ({
      writeToPty(text: string) {
        if (sessionIdRef.current) {
          ptyWrite(sessionIdRef.current, text).catch(() => {});
        }
      },
      getOutput() {
        return outputBufferRef.current;
      },
      getRawOutput() {
        return rawBufferRef.current;
      },
      refit() {
        try {
          if (fitAddonRef.current && xtermRef.current && termRef.current) {
            fitAddonRef.current.fit();
            if (sessionIdRef.current && xtermRef.current.cols && xtermRef.current.rows) {
              ptyResize(sessionIdRef.current, xtermRef.current.cols, xtermRef.current.rows).catch(() => {});
            }
          }
        } catch {}
      },
    }));

    useEffect(() => {
      if (!termRef.current || !agentId) return;

      outputBufferRef.current = "";
      rawBufferRef.current = "";

      const xterm = new Terminal({
        cursorBlink: true,
        fontSize: 14,
        fontFamily: "Menlo, Monaco, 'Courier New', monospace",
        scrollback: 10000,
        theme: {
          background: "#1e1e1e", foreground: "#d4d4d4", cursor: "#d4d4d4",
          selectionBackground: "#264f78",
          black: "#000000", red: "#cd3131", green: "#0dbc79", yellow: "#e5e510",
          blue: "#2472c8", magenta: "#bc3fbc", cyan: "#11a8cd", white: "#e5e5e5",
          brightBlack: "#666666", brightRed: "#f14c4c", brightGreen: "#23d18b",
          brightYellow: "#f5f543", brightBlue: "#3b8eea", brightMagenta: "#d670d6",
          brightCyan: "#29b8db", brightWhite: "#ffffff",
        },
        allowProposedApi: true,
      });

      const fitAddon = new FitAddon();
      xterm.loadAddon(fitAddon);
      xterm.loadAddon(new WebLinksAddon());
      xterm.open(termRef.current);
      fitAddon.fit();
      xtermRef.current = xterm;
      fitAddonRef.current = fitAddon;
      mountedRef.current = true;

      const config = agentConfigs[agentId];
      if (!config) {
        xterm.writeln(`\x1b[31m未知 Agent: ${agentId}\x1b[0m`);
        return;
      }

      const args = config.buildArgs();

      xterm.writeln(`\x1b[33m╔══════════════════════════════════════════════════╗\x1b[0m`);
      xterm.writeln(`\x1b[33m║  AgentHub — 启动 ${agentId.padEnd(19)}║\x1b[0m`);
      xterm.writeln(`\x1b[33m╚══════════════════════════════════════════════════╝\x1b[0m`);
      xterm.writeln("");

      let cancelled = false;

      (async () => {
        try {
          const { homeDir } = await import("@tauri-apps/api/path");
          const home = await homeDir();
          if (cancelled) return;

          const env: Record<string, string> = {
            PATH: `/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${home}/.npm-global/bin:${home}/.cargo/bin:${home}/.local/bin`,
            HOME: home,
            LANG: "en_US.UTF-8",
            TERM: "xterm-256color",
          };

          const sessionId = await ptySpawn({
            command: config.command,
            args,
            cwd: workingDir || home,
            env,
            cols: xterm.cols,
            rows: xterm.rows,
          });
          if (cancelled) return;

          sessionIdRef.current = sessionId;

          const unlistenOutput = await listenPtyOutput((id, data) => {
            if (id === sessionIdRef.current && mountedRef.current) {
              xterm.write(data);
              const text = new TextDecoder().decode(data);
              rawBufferRef.current += text;
              const clean = stripAnsi(text);
              outputBufferRef.current += clean;
              if (outputBufferRef.current.length > 200000) {
                outputBufferRef.current = outputBufferRef.current.slice(-150000);
                rawBufferRef.current = rawBufferRef.current.slice(-150000);
              }
            }
          });

          const unlistenExit = await listenPtyExit((id, exitCode) => {
            if (id === sessionIdRef.current) {
              xterm.writeln("");
              xterm.writeln(`\x1b[33m[AgentHub] 进程已退出，退出码: ${exitCode ?? "unknown"}\x1b[0m`);
              sessionIdRef.current = null;
              onExit?.(agentId, exitCode);
            }
          });

          unlistenRef.current = [unlistenOutput, unlistenExit];

          const disposer = xterm.onData((data: string) => {
            if (sessionIdRef.current) {
              ptyWrite(sessionIdRef.current, data).catch(() => {});
            }
          });
          onDataDisposerRef.current = () => disposer.dispose();
        } catch (err) {
          if (cancelled) return;
          xterm.writeln(`\x1b[31m启动失败: ${err}\x1b[0m`);
        }
      })();

      const resizeObserver = new ResizeObserver(() => {
        try {
          if (fitAddonRef.current && xtermRef.current) {
            fitAddonRef.current.fit();
            if (sessionIdRef.current && xtermRef.current.cols && xtermRef.current.rows) {
              ptyResize(sessionIdRef.current, xtermRef.current.cols, xtermRef.current.rows).catch(() => {});
            }
          }
        } catch {}
      });
      resizeObserver.observe(termRef.current);

      return () => {
        cancelled = true;
        mountedRef.current = false;
        resizeObserver.disconnect();
        unlistenRef.current.forEach((fn) => fn());
        unlistenRef.current = [];
        if (onDataDisposerRef.current) {
          onDataDisposerRef.current();
          onDataDisposerRef.current = null;
        }
        if (sessionIdRef.current) {
          ptyKill(sessionIdRef.current).catch(() => {});
          sessionIdRef.current = null;
        }
        xterm.dispose();
        xtermRef.current = null;
        fitAddonRef.current = null;
      };
    }, [agentId]);

    return (
      <div ref={termRef} style={{ width: "100%", height: "100%", background: "#1e1e1e" }} />
    );
  }
);

export default TerminalPanel;
