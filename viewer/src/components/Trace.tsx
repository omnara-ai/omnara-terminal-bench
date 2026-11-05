import { useEffect, useState } from 'react'

import type { Span, Timeline } from '../../shared/trace'
import { ms, percent } from '../format'

interface Props {
  timeline: Timeline
  selected: Span | null
  onSelect: (span: Span) => void
}

export function Trace({ timeline, selected, onSelect }: Props) {
  const [hover, setHover] = useState<{ span: Span; x: number; y: number } | null>(null)
  const [view, setView] = useState<[number, number] | null>(null)
  const [drag, setDrag] = useState<{ x0: number; x1: number; left: number; width: number } | null>(null)
  const { start, end, spans, modelMs, toolMs } = timeline
  const total = Math.max(end - start, 1)
  const [from, to] = view ?? [start, end]
  const span = Math.max(to - from, 1)
  const pos = (t: number) => ((t - from) / span) * 100
  const visible = view ? spans.filter((s) => s.kind === 'agent' || (s.end >= from && s.start <= to)) : spans
  const otherMs = Math.max(total - modelMs - toolMs, 0)
  const breakdown = [
    { label: 'model', value: modelMs, color: 'var(--model)' },
    { label: 'tools', value: toolMs, color: 'var(--tool)' },
    { label: 'other', value: otherMs, color: 'var(--axis)' },
  ]

  const startDrag = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    setDrag({ x0: e.clientX - rect.left, x1: e.clientX - rect.left, left: rect.left, width: rect.width })
  }
  useEffect(() => {
    if (!drag) return
    const move = (e: MouseEvent) => setDrag((d) => d && { ...d, x1: Math.min(Math.max(e.clientX - d.left, 0), d.width) })
    const up = () => {
      setDrag((d) => {
        if (d && Math.abs(d.x1 - d.x0) > 4) {
          const at = (x: number) => from + (x / d.width) * span
          setView([at(Math.min(d.x0, d.x1)), at(Math.max(d.x0, d.x1))])
        }
        return null
      })
    }
    addEventListener('mousemove', move)
    addEventListener('mouseup', up)
    return () => {
      removeEventListener('mousemove', move)
      removeEventListener('mouseup', up)
    }
  }, [drag, from, span])

  const zoomTo = (s: Span) => {
    const pad = Math.max((s.end - s.start) * 0.1, 500)
    setView(s.kind === 'agent' ? null : [s.start - pad, s.end + pad])
  }

  return (
    <div className="pane">
      <div className="pane-title">
        <span>
          Trace · {spans.length - 1} spans · {ms(total)}
          {view && (
            <button type="button" className="zoom-reset" onClick={() => setView(null)}>
              Reset zoom ({ms(span)} shown)
            </button>
          )}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span className="breakdown" aria-hidden>
            {breakdown.map((b) => (
              <div key={b.label} style={{ width: `${(b.value / total) * 100}%`, background: b.color }} />
            ))}
          </span>
          <span className="legend" style={{ marginTop: 0 }}>
            {breakdown.map((b) => (
              <span key={b.label}>
                <span className="swatch" style={{ background: b.color }} />
                {b.label} {ms(b.value)} ({percent(b.value / total, 0)})
              </span>
            ))}
          </span>
        </span>
      </div>
      <div className="trace" onMouseLeave={() => setHover(null)}>
        <div className="trace-axis">
          <span />
          <div className="ticks" onMouseDown={startDrag}>
            {[0, 0.25, 0.5, 0.75, 1].map((f) => (
              <span key={f} style={{ left: `${f * 100}%`, transform: f === 1 ? 'translateX(-100%)' : f === 0 ? 'none' : undefined }}>
                {ms(from - start + span * f)}
              </span>
            ))}
            {drag && (
              <div
                className="drag-window"
                style={{ left: Math.min(drag.x0, drag.x1), width: Math.abs(drag.x1 - drag.x0) }}
              />
            )}
          </div>
          <span />
        </div>
        {visible.map((s) => (
          <div
            key={s.id}
            className={`trace-row${selected?.id === s.id ? ' selected' : ''}`}
            onClick={() => onSelect(s)}
            onDoubleClick={() => zoomTo(s)}
            onMouseMove={(e) => setHover({ span: s, x: e.clientX, y: e.clientY })}
          >
            <div className="label" style={{ paddingLeft: 8 + s.depth * 14 }}>
              <span className="kind">{s.kind === 'tool' ? '⚙' : s.kind === 'model' ? '◇' : '▣'}</span>
              {s.kind === 'tool' ? `${s.name} ${s.attributes['tool.input'] ?? ''}` : s.name}
            </div>
            <div className="lane">
              <div
                className={`bar ${s.status === 'error' ? 'error' : s.kind}${s.status === 'unfinished' ? ' unfinished' : ''}`}
                style={{ left: `${pos(s.start)}%`, width: `${pos(s.end) - pos(s.start)}%` }}
              />
            </div>
            <div className="dur num">{ms(s.end - s.start)}</div>
          </div>
        ))}
      </div>
      {hover && <SpanTooltip {...hover} start={start} />}
    </div>
  )
}

function SpanTooltip({ span, x, y, start }: { span: Span; x: number; y: number; start: number }) {
  const left = Math.max(8, Math.min(x + 14, innerWidth - 440))
  const top = y + 14 > innerHeight - 200 ? y - 180 : y + 14
  return (
    <div className="tooltip" style={{ left, top }}>
      <div className="t">
        {span.kind} · {span.name}
      </div>
      <dl>
        <dt>duration</dt>
        <dd>{ms(span.end - span.start)}</dd>
        <dt>offset</dt>
        <dd>+{ms(span.start - start)}</dd>
        <dt>status</dt>
        <dd>{span.status}</dd>
        {Object.entries(span.attributes).map(([k, v]) => (
          <FragmentRow key={k} k={k} v={v} />
        ))}
      </dl>
    </div>
  )
}

function FragmentRow({ k, v }: { k: string; v: string | number }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{typeof v === 'number' ? v.toLocaleString() : v}</dd>
    </>
  )
}
