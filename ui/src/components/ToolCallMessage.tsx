import { useState } from 'react'
import { Wrench, ChevronDown, ChevronRight, Check, X, Loader2, Code2 } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ToolCall {
  id: string
  name: string
  arguments: string
  status: 'pending' | 'executing' | 'success' | 'error'
  result?: string
  error?: string
}

interface ToolCallMessageProps {
  toolCalls: ToolCall[]
  className?: string
}

export function ToolCallMessage({ toolCalls, className }: ToolCallMessageProps) {
  return (
    <div className={cn('space-y-2', className)}>
      {toolCalls.map((call) => (
        <ToolCallCard key={call.id} call={call} />
      ))}
    </div>
  )
}

function ToolCallCard({ call }: { call: ToolCall }) {
  const [expanded, setExpanded] = useState(call.status === 'error')
  const [showArgs, setShowArgs] = useState(false)

  // Parse arguments for display
  let parsedArgs: Record<string, unknown> = {}
  try {
    parsedArgs = JSON.parse(call.arguments)
  } catch {
    // Keep empty object
  }

  const argEntries = Object.entries(parsedArgs)

  return (
    <div
      className={cn(
        'rounded-lg border overflow-hidden transition-all duration-200',
        call.status === 'executing'
          ? 'border-amber-500/50 bg-amber-500/5'
          : call.status === 'success'
          ? 'border-emerald-500/30 bg-emerald-500/5'
          : call.status === 'error'
          ? 'border-red-500/30 bg-red-500/5'
          : 'border-border bg-secondary/30'
      )}
    >
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-secondary/50 transition-colors"
      >
        {/* Status Icon */}
        <div
          className={cn(
            'w-6 h-6 rounded flex items-center justify-center shrink-0',
            call.status === 'executing'
              ? 'bg-amber-500/20'
              : call.status === 'success'
              ? 'bg-emerald-500/20'
              : call.status === 'error'
              ? 'bg-red-500/20'
              : 'bg-secondary'
          )}
        >
          {call.status === 'executing' ? (
            <Loader2 className="w-3.5 h-3.5 text-amber-500 animate-spin" />
          ) : call.status === 'success' ? (
            <Check className="w-3.5 h-3.5 text-emerald-500" />
          ) : call.status === 'error' ? (
            <X className="w-3.5 h-3.5 text-red-500" />
          ) : (
            <Wrench className="w-3.5 h-3.5 text-muted-foreground" />
          )}
        </div>

        {/* Tool Name */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm font-medium truncate">{call.name}</span>
            {argEntries.length > 0 && (
              <span className="text-2xs text-muted-foreground/70">
                ({argEntries.length} arg{argEntries.length !== 1 ? 's' : ''})
              </span>
            )}
          </div>
          {call.status === 'executing' && (
            <p className="text-2xs text-amber-500/80 font-mono">Executing...</p>
          )}
        </div>

        {/* Expand Icon */}
        {expanded ? (
          <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
        )}
      </button>

      {/* Expanded Content */}
      {expanded && (
        <div className="border-t border-border/50 animate-slide-in-bottom">
          {/* Arguments */}
          {argEntries.length > 0 && (
            <div className="px-3 py-2 border-b border-border/30">
              <button
                onClick={() => setShowArgs(!showArgs)}
                className="flex items-center gap-1 text-2xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <Code2 className="w-3 h-3" />
                <span>Arguments</span>
                {showArgs ? (
                  <ChevronDown className="w-3 h-3" />
                ) : (
                  <ChevronRight className="w-3 h-3" />
                )}
              </button>
              {showArgs && (
                <pre className="mt-2 text-2xs font-mono bg-background/50 rounded p-2 overflow-x-auto">
                  {JSON.stringify(parsedArgs, null, 2)}
                </pre>
              )}
              {!showArgs && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {argEntries.slice(0, 3).map(([key, value]) => (
                    <span
                      key={key}
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-background/50 rounded text-2xs font-mono"
                    >
                      <span className="text-muted-foreground">{key}:</span>
                      <span className="truncate max-w-20">
                        {typeof value === 'string' ? value : JSON.stringify(value)}
                      </span>
                    </span>
                  ))}
                  {argEntries.length > 3 && (
                    <span className="text-2xs text-muted-foreground/70">
                      +{argEntries.length - 3} more
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Result or Error */}
          {(call.result || call.error) && (
            <div className="px-3 py-2">
              <p className="text-2xs text-muted-foreground mb-1">
                {call.error ? 'Error' : 'Result'}
              </p>
              <div
                className={cn(
                  'text-xs font-mono whitespace-pre-wrap break-words max-h-40 overflow-y-auto rounded p-2',
                  call.error
                    ? 'bg-red-500/10 text-red-400'
                    : 'bg-background/50 text-foreground'
                )}
              >
                {call.error || call.result}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// Export the ToolCall type for use in other components
export type { ToolCall }
