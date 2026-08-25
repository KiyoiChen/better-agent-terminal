import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { host } from '../host-api'
import { settingsStore } from '../stores/settings-store'
import { workspaceStore } from '../stores/workspace-store'
import type { EnvVariable, TerminalInstance } from '../types'
import { ChatMarkdown } from './ChatMarkdown'

type AgyStatus = 'starting' | 'ready' | 'running' | 'stopped' | 'error'
type AgyRole = 'user' | 'assistant' | 'tool' | 'thinking' | 'system'

type AgyMessage = {
  id: string
  role: AgyRole
  text: string
  timestamp: number
  isError?: boolean
}

type AgyUsage = {
  input_tokens?: number
  output_tokens?: number
  thinking_tokens?: number
  cache_read_tokens?: number
  total_tokens?: number
}

type AgyControls = {
  model: string
  effort: string
  autoApprove: boolean
  sandbox: boolean
}

interface AgyAgentPanelProps {
  terminal: TerminalInstance
  isActive: boolean
  workspaceId?: string
  showUserMsg?: boolean
  showAssistantMsg?: boolean
  showToolMsg?: boolean
  showThinkingMsg?: boolean
}

function mergeEnvVars(global: EnvVariable[] = [], workspace: EnvVariable[] = []): Record<string, string> {
  const result: Record<string, string> = {}
  for (const env of global) {
    if (env.enabled && env.key) result[env.key] = env.value
  }
  for (const env of workspace) {
    if (env.enabled && env.key) result[env.key] = env.value
  }
  return result
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stripAnsi(value: string): string {
  return value
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B[@-Z\\-_]/g, '')
}

function formatTimestamp(timestamp: number): string {
  if (!timestamp) return ''
  try {
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

function userContent(message: unknown): string {
  if (!isRecord(message)) return ''
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : '')
    .filter(Boolean)
    .join('\n')
}

function firstText(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function progressText(step: Record<string, unknown>): string {
  const kind = typeof step.step_type === 'string' ? step.step_type : 'step'
  const state = typeof step.state === 'string' ? step.state : ''
  const detail = firstText(step, ['description', 'message', 'command', 'tool_name', 'toolName', 'name', 'title'])
  const label = kind.replace(/_/g, ' ')
  return [label, detail, state ? state.toLowerCase() : ''].filter(Boolean).join(' · ')
}

function conversationIdFrom(frame: Record<string, unknown>): string | null {
  if (typeof frame.conversation_id === 'string' && frame.conversation_id) return frame.conversation_id
  for (const key of ['init', 'step_update', 'result']) {
    const value = frame[key]
    if (isRecord(value) && typeof value.conversation_id === 'string' && value.conversation_id) {
      return value.conversation_id
    }
  }
  return null
}

export const AgyAgentPanel = memo(function AgyAgentPanel({
  terminal,
  isActive,
  workspaceId,
  showUserMsg = true,
  showAssistantMsg = true,
  showToolMsg = true,
  showThinkingMsg = true,
}: Readonly<AgyAgentPanelProps>) {
  const initialParams = terminal.agentParams || {}
  const settings = settingsStore.getSettings()
  const [controls, setControls] = useState<AgyControls>({
    model: typeof initialParams.model === 'string' ? initialParams.model : '',
    effort: typeof initialParams.effort === 'string' ? initialParams.effort : '',
    autoApprove: initialParams.autoApprove === true || (initialParams.autoApprove == null && settings.allowBypassPermissions === true),
    sandbox: initialParams.sandbox === true,
  })
  const [conversationId, setConversationId] = useState<string | null>(
    typeof initialParams.conversationId === 'string' && initialParams.conversationId
      ? initialParams.conversationId
      : null,
  )
  const [status, setStatus] = useState<AgyStatus>('starting')
  const [messages, setMessages] = useState<AgyMessage[]>([])
  const [streamingText, setStreamingText] = useState('')
  const [streamingThinking, setStreamingThinking] = useState('')
  const [usage, setUsage] = useState<AgyUsage | null>(null)
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isSending, setIsSending] = useState(false)
  const [restartToken, setRestartToken] = useState(0)
  const listRef = useRef<HTMLDivElement | null>(null)
  const lineBufferRef = useRef('')
  const controlsRef = useRef(controls)
  const conversationRef = useRef(conversationId)

  const runtimeId = useMemo(() => `${terminal.id}__agy__${restartToken}`, [restartToken, terminal.id])

  useEffect(() => { controlsRef.current = controls }, [controls])
  useEffect(() => { conversationRef.current = conversationId }, [conversationId])

  const rememberConversation = useCallback((id: string | null) => {
    if (!id || conversationRef.current === id) return
    conversationRef.current = id
    setConversationId(id)
    workspaceStore.updateTerminalAgentParams(terminal.id, { conversationId: id })
  }, [terminal.id])

  const upsertMessage = useCallback((message: AgyMessage) => {
    setMessages(prev => {
      const index = prev.findIndex(existing => existing.id === message.id)
      if (index === -1) return [...prev, message]
      const next = [...prev]
      next[index] = message
      return next
    })
  }, [])

  const appendUser = useCallback((text: string, id = `agy-user-${Date.now()}`) => {
    if (!text.trim()) return
    setMessages(prev => {
      const last = prev[prev.length - 1]
      if (last?.role === 'user' && last.text === text) return prev
      return [...prev, { id, role: 'user', text, timestamp: Date.now() }]
    })
  }, [])

  const handleFrame = useCallback((frame: Record<string, unknown>) => {
    const nextConversationId = conversationIdFrom(frame)
    if (nextConversationId) rememberConversation(nextConversationId)

    const event = typeof frame.event === 'string' ? frame.event : ''
    if (event === 'init') {
      setStatus('ready')
      setError(null)
      return
    }

    if (event === 'user') {
      const text = userContent(frame.message)
      if (text) appendUser(text, `agy-user-echo-${Date.now()}`)
      return
    }

    if (event === 'step_update' && isRecord(frame.step_update)) {
      const step = frame.step_update
      const stepType = typeof step.step_type === 'string' ? step.step_type : ''
      const delta = typeof step.text_delta === 'string' ? step.text_delta : ''
      if (stepType === 'agent_response') {
        if (delta) setStreamingText(prev => prev + delta)
        return
      }
      if (stepType.includes('thinking') || stepType.includes('reason')) {
        if (delta) setStreamingThinking(prev => prev + delta)
        return
      }
      if (stepType === 'user_input') return

      const index = typeof step.step_index === 'number' ? step.step_index : Date.now()
      const text = progressText(step)
      if (text) {
        upsertMessage({
          id: `agy-step-${nextConversationId || conversationRef.current || 'session'}-${index}`,
          role: 'tool',
          text,
          timestamp: Date.now(),
          isError: typeof step.state === 'string' && step.state.toUpperCase() === 'ERROR',
        })
      }
      return
    }

    if (event === 'result' && isRecord(frame.result)) {
      const result = frame.result
      const resultStatus = typeof result.status === 'string' ? result.status.toUpperCase() : 'UNKNOWN'
      const response = typeof result.response === 'string' ? result.response.trimEnd() : ''
      const resultError = typeof result.error === 'string' ? result.error.trim() : ''
      if (isRecord(result.usage)) setUsage(result.usage as AgyUsage)

      if (response) {
        upsertMessage({
          id: `agy-result-${nextConversationId || conversationRef.current || 'session'}-${String(result.num_turns ?? Date.now())}`,
          role: 'assistant',
          text: response,
          timestamp: Date.now(),
        })
      }
      setStreamingText('')
      setStreamingThinking('')
      setIsSending(false)
      workspaceStore.setTerminalAgentRunning(terminal.id, false)

      if (resultStatus === 'SUCCESS') {
        setStatus('ready')
        setError(null)
      } else if (resultStatus === 'CANCELED' || resultStatus === 'INTERRUPTED') {
        setStatus('ready')
        if (resultError) setError(resultError)
      } else {
        const message = resultError || `Antigravity ended the turn with status ${resultStatus}.`
        setStatus('error')
        setError(message)
        upsertMessage({
          id: `agy-error-${Date.now()}`,
          role: 'system',
          text: message,
          timestamp: Date.now(),
          isError: true,
        })
      }
    }
  }, [appendUser, rememberConversation, terminal.id, upsertMessage])

  const handleLine = useCallback((rawLine: string) => {
    const line = stripAnsi(rawLine).replace(/\r/g, '').trim()
    if (!line) return
    try {
      const parsed = JSON.parse(line)
      if (isRecord(parsed)) handleFrame(parsed)
      return
    } catch {
      // stderr diagnostics are merged into PTY output. Surface useful lines,
      // while keeping ordinary terminal noise out of the structured timeline.
    }
    if (/error|warning|auth|permission|not found|failed/i.test(line)) {
      upsertMessage({
        id: `agy-diagnostic-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        role: 'system',
        text: line,
        timestamp: Date.now(),
        isError: /error|failed|not found/i.test(line),
      })
    }
  }, [handleFrame, upsertMessage])

  const feedOutput = useCallback((chunk: string) => {
    lineBufferRef.current += chunk
    const lines = lineBufferRef.current.split('\n')
    lineBufferRef.current = lines.pop() || ''
    for (const line of lines) handleLine(line)
  }, [handleLine])

  useEffect(() => {
    let cancelled = false
    let reused = false
    lineBufferRef.current = ''
    setStatus('starting')
    setError(null)

    const unOutput = host.pty.onOutput((id: string, data: string) => {
      if (id !== runtimeId) return
      workspaceStore.updateTerminalActivity(terminal.id)
      feedOutput(data)
    })
    const unExit = host.pty.onExit((id: string, exitCode: number) => {
      if (id !== runtimeId || cancelled) return
      setIsSending(false)
      workspaceStore.setTerminalAgentRunning(terminal.id, false)
      if (exitCode === 0) {
        setStatus('stopped')
      } else {
        setStatus('error')
        setError(prev => prev || `Antigravity process exited with code ${exitCode}.`)
      }
    })

    const start = async () => {
      const selected = controlsRef.current
      const args = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--print-timeout', '30m']
      const resumeId = conversationRef.current
      if (resumeId) args.push('--conversation', resumeId)
      if (selected.model.trim()) args.push('--model', selected.model.trim())
      if (selected.effort) args.push('--effort', selected.effort)
      if (selected.autoApprove) args.push('--dangerously-skip-permissions')
      if (selected.sandbox) args.push('--sandbox')

      const allSettings = settingsStore.getSettings()
      const workspace = workspaceStore.getState().workspaces.find(item => item.id === terminal.workspaceId)
      const customEnv = mergeEnvVars(allSettings.globalEnvVars, workspace?.envVars)
      const windows = host.platform === 'win32'
      try {
        await host.pty.create({
          id: runtimeId,
          cwd: terminal.cwd || workspace?.folderPath || '',
          type: 'terminal',
          agentPreset: terminal.agentPreset,
          command: windows ? 'cmd.exe' : 'agy',
          args: windows ? ['/D', '/C', 'agy', ...args] : args,
          cols: 120,
          rows: 30,
          customEnv,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (message.includes('already exists')) {
          reused = true
        } else {
          throw err
        }
      }

      if (cancelled) return
      if (reused) {
        const buffered = await host.pty.readBuffer(runtimeId).catch(() => '')
        if (buffered && !cancelled) feedOutput(buffered)
      }
    }

    void start().catch(err => {
      if (cancelled) return
      const message = err instanceof Error ? err.message : String(err)
      setStatus('error')
      setError(
        /not found|not recognized|os error 2/i.test(message)
          ? `Antigravity CLI (agy) was not found. Install/sign in to AGY first. ${message}`
          : message,
      )
    })

    return () => {
      cancelled = true
      unOutput?.()
      unExit?.()
      // Panels can be LRU-unmounted or moved to a remote client. Keep the
      // persistent AGY process alive unless the terminal itself was deleted.
      window.setTimeout(() => {
        const stillExists = workspaceStore.getState().terminals.some(item => item.id === terminal.id)
        if (!stillExists) void host.pty.kill(runtimeId).catch(() => {})
      }, 0)
    }
  }, [feedOutput, runtimeId, terminal.agentPreset, terminal.cwd, terminal.id, terminal.workspaceId])

  useEffect(() => {
    if (!isActive) return
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [isActive, messages.length, streamingText, streamingThinking])

  const visibleMessages = useMemo(() => messages.filter(message => {
    if (message.role === 'user') return showUserMsg
    if (message.role === 'assistant') return showAssistantMsg
    if (message.role === 'tool') return showToolMsg
    if (message.role === 'thinking') return showThinkingMsg
    return true
  }), [messages, showAssistantMsg, showThinkingMsg, showToolMsg, showUserMsg])

  const persistControls = useCallback((next: AgyControls) => {
    setControls(next)
    controlsRef.current = next
    workspaceStore.updateTerminalAgentParams(terminal.id, {
      model: next.model,
      effort: next.effort,
      autoApprove: next.autoApprove,
      sandbox: next.sandbox,
    })
  }, [terminal.id])

  const send = useCallback(async () => {
    const prompt = input.trim()
    if (!prompt || isSending || status !== 'ready') return
    setInput('')
    appendUser(prompt)
    setStreamingText('')
    setStreamingThinking('')
    setError(null)
    setStatus('running')
    setIsSending(true)
    workspaceStore.setTerminalAgentRunning(terminal.id, true)
    try {
      await host.pty.write(runtimeId, `${JSON.stringify({ event: 'user', message: { content: prompt } })}\n`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setIsSending(false)
      setStatus('error')
      setError(message)
      workspaceStore.setTerminalAgentRunning(terminal.id, false)
    }
  }, [appendUser, input, isSending, runtimeId, status, terminal.id])

  const stop = useCallback(async () => {
    // SIGINT is preferable to killing the process: AGY can report an
    // INTERRUPTED result and preserve the conversation for the next turn.
    await host.pty.write(runtimeId, '\x03').catch(() => host.pty.kill(runtimeId))
  }, [runtimeId])

  const restart = useCallback(async () => {
    await host.pty.kill(runtimeId).catch(() => {})
    setStreamingText('')
    setStreamingThinking('')
    setIsSending(false)
    setStatus('starting')
    workspaceStore.setTerminalAgentRunning(terminal.id, false)
    setRestartToken(value => value + 1)
  }, [runtimeId, terminal.id])

  const newSession = useCallback(async () => {
    await host.pty.kill(runtimeId).catch(() => {})
    conversationRef.current = null
    setConversationId(null)
    workspaceStore.updateTerminalAgentParams(terminal.id, { conversationId: '' })
    setMessages([])
    setUsage(null)
    setStreamingText('')
    setStreamingThinking('')
    setIsSending(false)
    setStatus('starting')
    workspaceStore.setTerminalAgentRunning(terminal.id, false)
    setRestartToken(value => value + 1)
  }, [runtimeId, terminal.id])

  const canSend = status === 'ready' && !isSending

  return (
    <div
      className="claude-agent-panel claude-channel-panel"
      style={{ '--agent-color': '#4285f4' } as CSSProperties}
    >
      <div className="claude-messages-shell">
        <div ref={listRef} className="claude-messages claude-timeline claude-channel-messages">
          {visibleMessages.length === 0 && !streamingText && (
            <div className="tl-item">
              <div className="tl-dot dot-system" />
              <div className="tl-content claude-message-system">
                Antigravity is connected directly through the local AGY CLI. This session stays independent from Codex and Claude.
              </div>
            </div>
          )}
          {visibleMessages.map(message => {
            const dotClass = message.role === 'user'
              ? 'dot-user'
              : message.role === 'assistant'
                ? 'dot-assistant'
                : message.role === 'tool'
                  ? (message.isError ? 'dot-error' : 'dot-tool-use')
                  : message.role === 'thinking'
                    ? 'dot-thinking'
                    : message.isError ? 'dot-error' : 'dot-system'
            const contentClass = message.role === 'user'
              ? 'claude-message-user'
              : message.role === 'assistant'
                ? 'claude-message-assistant'
                : message.role === 'tool'
                  ? 'claude-message-tool-use'
                  : message.role === 'thinking'
                    ? 'claude-message-thinking'
                    : 'claude-message-system'
            return (
              <div key={message.id} className="tl-item claude-channel-message">
                <div className={`tl-dot ${dotClass}`} />
                <div className={`tl-content ${contentClass}`}>
                  {message.role === 'assistant' ? (
                    <ChatMarkdown text={message.text} cwd={terminal.cwd} className="claude-markdown" />
                  ) : message.text}
                  <span className="claude-msg-time">{formatTimestamp(message.timestamp)}</span>
                </div>
              </div>
            )
          })}
          {showThinkingMsg && streamingThinking && (
            <div className="tl-item">
              <div className="tl-dot dot-thinking" />
              <div className="tl-content claude-message-thinking">
                <span className="claude-thinking-label">thinking</span>
                <span className="claude-thinking-preview"> {streamingThinking}</span>
              </div>
            </div>
          )}
          {showAssistantMsg && streamingText && (
            <div className="tl-item claude-channel-message">
              <div className="tl-dot dot-assistant" />
              <div className="tl-content claude-message-assistant">
                <ChatMarkdown text={streamingText} cwd={terminal.cwd} className="claude-markdown" resolvePathLinks={false} />
              </div>
            </div>
          )}
          {error && (
            <div className="tl-item tl-item-system">
              <div className="tl-dot dot-error" />
              <div className="tl-content claude-message-system claude-channel-error-message">{error}</div>
            </div>
          )}
          {(status === 'starting' || (status === 'running' && !streamingText)) && (
            <div className="tl-item">
              <div className="tl-dot dot-thinking" />
              <div className="tl-content claude-thinking">
                <span className="claude-thinking-text">{status === 'starting' ? 'Starting Antigravity' : 'Antigravity is working'}</span>
                <span className="claude-thinking-dots"><span>.</span><span>.</span><span>.</span></span>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="claude-input-area claude-channel-input-area">
        <textarea
          className="claude-input claude-channel-input"
          value={input}
          onChange={event => setInput(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void send()
            }
          }}
          disabled={!canSend}
          placeholder={status === 'ready' ? 'Message Antigravity directly…' : `Antigravity: ${status}`}
        />
        <div className="claude-input-footer">
          <div className="claude-input-controls">
            <input
              value={controls.model}
              onChange={event => persistControls({ ...controls, model: event.target.value })}
              placeholder="AGY default model"
              title="Optional AGY model slug. Restart to apply."
              style={{ width: 150, minWidth: 90, background: 'transparent', color: 'inherit', border: '1px solid var(--border-color)', borderRadius: 4, padding: '2px 6px', fontSize: 11 }}
            />
            <select
              className="claude-effort-select"
              value={controls.effort}
              onChange={event => persistControls({ ...controls, effort: event.target.value })}
              title="AGY reasoning effort. Restart to apply."
            >
              <option value="">effort: default</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
            </select>
            <span
              className={`claude-status-btn${controls.autoApprove ? ' active' : ''}`}
              onClick={() => persistControls({ ...controls, autoApprove: !controls.autoApprove })}
              title="Auto-approve AGY tool permissions (--dangerously-skip-permissions). Restart to apply."
            >
              {controls.autoApprove ? 'auto approve: on' : 'auto approve: off'}
            </span>
            <span
              className={`claude-status-btn${controls.sandbox ? ' active' : ''}`}
              onClick={() => persistControls({ ...controls, sandbox: !controls.sandbox })}
              title="Run AGY with --sandbox. Restart to apply."
            >
              {controls.sandbox ? 'sandbox: on' : 'sandbox: off'}
            </span>
          </div>
          <div className="claude-input-actions">
            {status === 'running' ? (
              <button className="claude-send-btn claude-stop-btn" onClick={() => void stop()} title="Interrupt AGY turn">■</button>
            ) : (
              <button className="claude-send-btn" onClick={() => void send()} disabled={!input.trim() || !canSend} title="Send to Antigravity">▶</button>
            )}
          </div>
        </div>
      </div>

      <div className="claude-statusline-bar attached">
        <div className="claude-statusline">
          <div className="claude-statusline-left">
            <span className="claude-statusline-item">AGY</span>
            <span className="claude-statusline-item" title={conversationId || 'New conversation'}>
              {conversationId ? `session ${conversationId.slice(0, 8)}` : 'new session'}
            </span>
            <span className="claude-statusline-item">{status}</span>
            <span className="claude-statusline-item claude-statusline-clickable" onClick={() => void restart()} title="Restart AGY and resume the same conversation">restart</span>
            <span className="claude-statusline-item claude-statusline-clickable" onClick={() => void newSession()} title="Start a brand-new AGY conversation">new</span>
          </div>
          <div className="claude-statusline-right">
            {usage && (
              <span
                className="claude-statusline-item"
                title={[
                  `input: ${usage.input_tokens ?? 0}`,
                  `output: ${usage.output_tokens ?? 0}`,
                  `thinking: ${usage.thinking_tokens ?? 0}`,
                  `cache read: ${usage.cache_read_tokens ?? 0}`,
                  `total: ${usage.total_tokens ?? 0}`,
                ].join('\n')}
              >
                {`${usage.input_tokens ?? 0}↑/${usage.output_tokens ?? 0}↓`}
              </span>
            )}
            <span className="claude-statusline-item">stream-json</span>
          </div>
        </div>
      </div>
    </div>
  )
})
