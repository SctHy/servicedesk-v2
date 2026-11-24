import { useEffect, useRef, useState, type PointerEvent, type KeyboardEvent } from 'react'

export function useResizableWidth(side: 'left' | 'right', initial: number, min: number, max: number) {
  const key = 'desk-width-' + side
  const clamp = (value: number) => Math.max(min, Math.min(max, Math.round(value)))
  const [width, setWidth] = useState(() => {
    const saved = localStorage.getItem(key)
    return saved && Number.isFinite(Number(saved)) ? clamp(Number(saved)) : initial
  })
  const origin = useRef<{ x: number; width: number; pointer: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const direction = side === 'left' ? 1 : -1
  useEffect(() => {
    if (!dragging) localStorage.setItem(key, String(width))
  }, [key, width, dragging])
  useEffect(() => {
    if (!dragging) return
    const onMove = (e: globalThis.PointerEvent) => {
      const start = origin.current
      if (start && e.pointerId === start.pointer)
        setWidth(clamp(start.width + direction * (e.clientX - start.x)))
    }
    const stop = () => {
      origin.current = null
      setDragging(false)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
    }
  }, [dragging, direction, min, max])
  const handle = {
    role: 'separator',
    tabIndex: 0,
    'aria-label': side === 'left' ? '侧栏宽度' : '审计面板宽度',
    'aria-orientation': 'vertical' as const,
    'aria-valuemin': min,
    'aria-valuemax': max,
    'aria-valuenow': width,
    'data-resize-handle': side,
    onDoubleClick: () => setWidth(initial),
    onKeyDown: (e: KeyboardEvent) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(e.key)) return
      e.preventDefault()
      setWidth(e.key === 'Home' ? initial : clamp(width + (e.key === 'ArrowRight' ? 8 : -8) * direction))
    },
    onPointerDown: (e: PointerEvent) => {
      if (e.button !== 0 || origin.current) return
      e.preventDefault()
      origin.current = { x: e.clientX, width, pointer: e.pointerId }
      setDragging(true)
    },
  }
  return { width, dragging, handle }
}
