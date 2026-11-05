import { memo, useEffect, useRef, useState } from 'react'

import type { Message, MessageKind, Timeline } from '../../shared/trace'
import { ms } from '../format'

const LINES: Record<MessageKind, number> = {
  system: 8,
  user: 30,
  assistant: 200,
  reasoning: 4,
  tool_call: 24,
  tool_result: 10,
  checkpoint: 8,
}
const WHO: Record<MessageKind, string> = {
  system: 'system',
  user: 'user',
  assistant: 'assistant',
  reasoning: 'reasoning',
  tool_call: 'tool call',
  tool_result: 'tool result',
  checkpoint: 'context checkpoint',
}

interface Props {
  timeline: Timeline
  focus: string | null
}

export function Conversation({ timeline, focus }: Props) {
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!focus || !root.current) return
    const el = root.current.querySelector<HTMLElement>(`[data-id="${CSS.escape(focus)}"]`)
    if (!el) return
    el.scrollIntoView({ block: 'start', behavior: 'smooth' })
    el.classList.add('flash')
    const timer = setTimeout(() => el.classList.remove('flash'), 1600)
    return () => clearTimeout(timer)
  }, [focus])

  return (
    <div className="pane" style={{ borderBottom: 0 }}>
      <div className="pane-title">
        <span>Conversation · {timeline.messages.length} messages</span>
      </div>
      <div className="conversation" ref={root}>
        {timeline.messages.map((m) => (
          <MessageView key={m.id} message={m} start={timeline.start} />
        ))}
      </div>
    </div>
  )
}

const MessageView = memo(function MessageView({ message, start }: { message: Message; start: number }) {
  const [expanded, setExpanded] = useState(false)
  const lines = message.text.split('\n')
  const limit = LINES[message.kind]
  const clipped = !expanded && lines.length > limit
  const body = clipped ? lines.slice(0, limit).join('\n') : message.text
  const code = message.kind === 'tool_call' || message.kind === 'tool_result'
  const failed = message.outcome && message.outcome !== 'succeeded'

  return (
    <div className={`msg ${message.kind}${failed ? ' failed' : ''}`} data-id={message.id}>
      <div className="meta">
        <span className="who">{WHO[message.kind]}</span>
        {message.toolName && <span className="mono">{message.toolName}</span>}
        {message.outcome && <span>{message.outcome}</span>}
        <span className="num">+{ms(message.at - start)}</span>
      </div>
      {code ? <pre>{body}</pre> : <div className="body">{body}</div>}
      {clipped && (
        <button type="button" className="more" onClick={() => setExpanded(true)}>
          Show {lines.length - limit} more lines
        </button>
      )}
      {expanded && lines.length > limit && (
        <button type="button" className="more" onClick={() => setExpanded(false)}>
          Show less
        </button>
      )}
    </div>
  )
})
