/**
 * Agent 預設配置
 * 定義支援的 AI Agent CLI 工具及其屬性
 */

export interface AgentPreset {
  id: string;
  name: string;
  icon: string;
  color: string;
  command?: string;       // 可選的自動啟動命令（PTY 模式用）
  debug?: boolean;        // 僅在 debug 模式下顯示
  suggested?: boolean;    // 標記為推薦選項
  backend?: 'sdk' | 'channel' | 'cli' | 'pty' | 'agy';  // agy = structured Antigravity stream-json panel
  needsGitRepo?: boolean; // 需要 git repo（worktree 類）
}

export type AgentPresetId = 'claude-code' | 'claude-channel' | 'claude-cli-agent' | 'claude-code-v2' | 'claude-code-worktree' | 'claude-cli' | 'claude-cli-worktree' | 'agy-agent' | 'codex-agent' | 'codex-agent-worktree' | 'codex-fugu' | 'codex-cli' | 'none';

export const AGENT_PRESETS: AgentPreset[] = [
  {
    id: 'claude-code',
    name: 'Claude Agent',
    icon: '✦',
    color: '#d97706',
    command: 'claude --continue',
    suggested: true,
    backend: 'sdk',
  },
  {
    id: 'claude-code-v2',
    name: 'Claude Agent V2',
    icon: '✦',
    color: '#eab308',
    debug: true,
    backend: 'sdk',
  },
  {
    id: 'claude-channel',
    name: 'Claude Channel Agent',
    icon: '◉',
    color: '#f97316',
    debug: true,
    backend: 'channel',
  },
  {
    id: 'claude-cli-agent',
    name: 'Claude CLI Agent (Subscription)',
    icon: '◈',
    color: '#d97706',
    debug: true,
    backend: 'cli',
  },
  {
    id: 'claude-code-worktree',
    name: 'Claude Agent (Worktree)',
    icon: '✦',
    color: '#22c55e',
    backend: 'sdk',
    needsGitRepo: true,
  },
  {
    id: 'claude-cli',
    name: 'Claude CLI',
    icon: '▶',
    color: '#d97706',
    suggested: true,
    backend: 'cli',
  },
  {
    id: 'claude-cli-worktree',
    name: 'Claude CLI (Worktree)',
    icon: '▶',
    color: '#22c55e',
    backend: 'cli',
    needsGitRepo: true,
  },
  {
    id: 'agy-agent',
    name: 'Antigravity Agent',
    icon: '✧',
    color: '#4285f4',
    suggested: true,
    backend: 'agy',
  },
  {
    id: 'codex-agent',
    name: 'Codex Agent',
    icon: '⬡',
    color: '#10a37f',
    backend: 'sdk',
  },
  {
    id: 'codex-agent-worktree',
    name: 'Codex Agent (Worktree)',
    icon: '⬡',
    color: '#10a37f',
    backend: 'sdk',
    needsGitRepo: true,
  },
  {
    // Experimental Sakana Fugu provider via the Codex app-server (BAT_DEBUG
    // only). Same SDK runtime as Codex Agent; defaults to the "fugu" model
    // which routes thread/start through provider "sakana".
    id: 'codex-fugu',
    name: 'Codex Fugu Agent',
    icon: '🐡',
    color: '#06b6d4',
    backend: 'sdk',
    debug: true,
  },
  {
    id: 'codex-cli',
    name: 'Codex CLI',
    icon: '▶',
    color: '#10a37f',
    backend: 'pty',
  },
  {
    id: 'none',
    name: 'Terminal',
    icon: '⌘',
    color: '#888888',
  },
];

export function getAgentPreset(id: string): AgentPreset | undefined {
  return AGENT_PRESETS.find(p => p.id === id);
}

export function getDefaultAgentPreset(): AgentPreset {
  return AGENT_PRESETS.find(p => p.id === 'claude-code') || AGENT_PRESETS[0];
}

/** Get presets visible in UI, filtering debug-only presets unless BAT_DEBUG is set */
export function getVisiblePresets(isDebugOverride?: boolean): AgentPreset[] {
  const isDebug = typeof isDebugOverride === 'boolean'
    ? isDebugOverride
    : typeof window !== 'undefined'
      && (window as unknown as { batAppAPI?: { debug?: { isDebugMode?: boolean } } }).batAppAPI?.debug?.isDebugMode === true
  return AGENT_PRESETS.filter(p => p.id !== 'claude-code-v2' && (!p.debug || isDebug))
}
