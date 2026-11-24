import { useEffect, useRef, useState } from 'react'
import type { ComponentProps, ReactNode } from 'react'
import { Button as BaseButton } from '@base-ui/react/button'
import { Collapsible as Fold } from '@base-ui/react/collapsible'
import { Select as List } from '@base-ui/react/select'
import { Switch as Toggle } from '@base-ui/react/switch'
import { Tooltip as Tip } from '@base-ui/react/tooltip'
import { Check, ChevronDown, ChevronRight, Copy } from 'lucide-react'
import { cva } from 'class-variance-authority'
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { toast } from 'sonner'

export const cn = (...values: ClassValue[]) => twMerge(clsx(values))
const button = cva('btn', {
  variants: {
    variant: { ghost: 'ghost', outline: 'outline-btn', primary: 'primary' },
  },
  defaultVariants: { variant: 'ghost' },
})
export function Button({
  variant,
  className,
  ...props
}: ComponentProps<'button'> & { variant?: 'ghost' | 'outline' | 'primary' }) {
  return (
    <BaseButton {...props} className={cn(button({ variant }), className)} />
  )
}
export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode
  tone?: string
}) {
  return (
    <span className="badge" data-tone={tone}>
      {children}
    </span>
  )
}
export function Panel(props: ComponentProps<'article'>) {
  return <article {...props} className={cn('panel', props.className)} />
}
export const TooltipProvider = Tip.Provider
export function IconButton({
  label,
  children,
  ...props
}: ComponentProps<typeof Button> & { label: string }) {
  return (
    <Tip.Root>
      <Tip.Trigger render={<Button {...props} aria-label={label} />}>
        {children}
      </Tip.Trigger>
      <Tip.Portal>
        <Tip.Positioner sideOffset={5}>
          <Tip.Popup className="tip">{label}</Tip.Popup>
        </Tip.Positioner>
      </Tip.Portal>
    </Tip.Root>
  )
}
export function CopyButton({
  value,
  short,
  citation,
}: {
  value: string
  short?: boolean
  citation?: boolean
}) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  return (
    <IconButton
      className={citation ? 'citation' : 'copy-button'}
      label={'复制 ' + value}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value)
          clearTimeout(timer.current)
          setCopied(true)
          timer.current = setTimeout(() => setCopied(false), 1500)
          toast.success('已复制到剪贴板')
        } catch {
          toast.error('复制失败')
        }
      }}
    >
      {short && <code>{value.slice(0, 8)}</code>}
      {citation ? (
        <code>[{value.slice(0, 8)}]</code>
      ) : (
        <span className="copy-icons" data-copied={copied}>
          <Copy size={13} />
          <Check size={13} />
        </span>
      )}
    </IconButton>
  )
}
export function Select({
  label,
  value,
  disabled,
  options,
  onChange,
}: {
  label: string
  value: string
  disabled?: boolean
  options: { value: string; label: string }[]
  onChange: (v: string) => void
}) {
  return (
    <List.Root
      disabled={disabled}
      items={options}
      value={value}
      onValueChange={(v) => {
        if (v !== null) onChange(v)
      }}
    >
      <List.Trigger className="select" aria-label={label}>
        <List.Value />
        <ChevronDown size={13} />
      </List.Trigger>
      <List.Portal>
        <List.Positioner
          align="start"
          sideOffset={5}
          alignItemWithTrigger={false}
          className="z-50"
        >
          <List.Popup className="popup">
            <List.List>
              {options.map((o) => (
                <List.Item className="option" key={o.value} value={o.value}>
                  <List.ItemText>{o.label}</List.ItemText>
                  <List.ItemIndicator>
                    <Check size={13} />
                  </List.ItemIndicator>
                </List.Item>
              ))}
            </List.List>
          </List.Popup>
        </List.Positioner>
      </List.Portal>
    </List.Root>
  )
}
export function Switch({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string
  checked: boolean
  disabled: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <Toggle.Root
      className="switch"
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onCheckedChange={onChange}
    >
      <Toggle.Thumb />
    </Toggle.Root>
  )
}
export function Collapsible({
  title,
  children,
  onOpenChange,
  action,
}: {
  title: ReactNode
  children: ReactNode
  onOpenChange?: (open: boolean) => void
  action?: ReactNode
}) {
  return (
    <Fold.Root onOpenChange={onOpenChange}>
      <div className="fold-row">
        <Fold.Trigger className="fold">
          <ChevronRight size={14} />
          {title}
        </Fold.Trigger>
        {action}
      </div>
      <Fold.Panel className="fold-panel">
        <div className="fold-content">{children}</div>
      </Fold.Panel>
    </Fold.Root>
  )
}
