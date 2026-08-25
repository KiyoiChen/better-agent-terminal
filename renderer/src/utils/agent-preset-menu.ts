import type { AgentPreset } from '../types/agent-presets'

export interface AgentPresetMenuGroups {
  standardAgents: AgentPreset[]
  standardCli: AgentPreset[]
  worktreeAgents: AgentPreset[]
  worktreeCli: AgentPreset[]
}

const PRESET_ORDER = [
  'claude-code',
  'claude-channel',
  'agy-agent',
  'codex-agent',
  'claude-cli',
  'codex-cli',
  'claude-code-worktree',
  'codex-agent-worktree',
  'claude-cli-worktree',
]

function presetOrder(preset: AgentPreset): number {
  const index = PRESET_ORDER.indexOf(preset.id)
  return index === -1 ? PRESET_ORDER.length : index
}

function isWorktreePreset(preset: AgentPreset): boolean {
  return preset.needsGitRepo === true || preset.id.endsWith('-worktree')
}

function isAgentPreset(preset: AgentPreset): boolean {
  return preset.backend === 'sdk' || preset.backend === 'channel' || preset.backend === 'agy'
}

function sortPresets(presets: AgentPreset[]): AgentPreset[] {
  return [...presets].sort((a, b) => presetOrder(a) - presetOrder(b) || a.name.localeCompare(b.name))
}

export function groupAgentPresetsForMenu(presets: AgentPreset[]): AgentPresetMenuGroups {
  return {
    standardAgents: sortPresets(presets.filter(preset => !isWorktreePreset(preset) && isAgentPreset(preset))),
    standardCli: sortPresets(presets.filter(preset => !isWorktreePreset(preset) && !isAgentPreset(preset))),
    worktreeAgents: sortPresets(presets.filter(preset => isWorktreePreset(preset) && isAgentPreset(preset))),
    worktreeCli: sortPresets(presets.filter(preset => isWorktreePreset(preset) && !isAgentPreset(preset))),
  }
}

export function worktreeMenuName(name: string): string {
  return name.replace(/\s*\(worktree\)$/i, '')
}
