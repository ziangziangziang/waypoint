import { useState, useEffect, useRef, memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import mermaid from 'mermaid'
import { Copy, Check, ChevronDown, ChevronUp, Brain } from 'lucide-react'
import { cn } from '@/lib/utils'
import { parseMessageContent } from './messageContentParser'

// Initialize mermaid with dark theme
mermaid.initialize({
  startOnLoad: false,
  theme: 'dark',
  securityLevel: 'loose',
  fontFamily: 'JetBrains Mono, monospace',
  suppressErrorRendering: true, // Don't render error SVGs to DOM
})

// Clean up any mermaid error elements that might have been appended to body
function cleanupMermaidErrors() {
  // Remove orphaned mermaid error SVGs from body
  document.querySelectorAll('body > svg[id^="mermaid-"]').forEach(el => el.remove())
  document.querySelectorAll('body > #d').forEach(el => el.remove())
}

interface MessageContentProps {
  content: string
  className?: string
}

// Mermaid diagram component with debounced rendering
const MermaidDiagram = memo(({ code }: { code: string }) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const [svg, setSvg] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [isRendering, setIsRendering] = useState(true)
  const renderTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  useEffect(() => {
    // Clear any pending render
    if (renderTimeoutRef.current) {
      clearTimeout(renderTimeoutRef.current)
    }
    
    setIsRendering(true)
    
    // Debounce rendering to avoid rendering during streaming
    renderTimeoutRef.current = setTimeout(async () => {
      try {
        // Clean up any orphaned error elements first
        cleanupMermaidErrors()
        
        const id = `mermaid-${Math.random().toString(36).substr(2, 9)}`
        const { svg } = await mermaid.render(id, code)
        setSvg(svg)
        setError(null)
      } catch (err) {
        // Don't show error during streaming - might be incomplete code
        setError((err as Error).message)
        setSvg('')
      } finally {
        setIsRendering(false)
        // Clean up again after render attempt
        cleanupMermaidErrors()
      }
    }, 300) // 300ms debounce
    
    return () => {
      if (renderTimeoutRef.current) {
        clearTimeout(renderTimeoutRef.current)
      }
      cleanupMermaidErrors()
    }
  }, [code])

  if (isRendering) {
    return (
      <div className="my-4 p-4 bg-secondary/50 rounded-lg flex items-center gap-2 text-muted-foreground">
        <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
        <span className="text-sm font-mono">Rendering diagram...</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className="bg-destructive/10 border border-destructive/30 rounded-lg p-4 my-2">
        <p className="text-destructive text-sm font-mono">Mermaid Error: {error}</p>
        <pre className="mt-2 text-xs text-muted-foreground overflow-x-auto">{code}</pre>
      </div>
    )
  }

  return (
    <div 
      ref={containerRef}
      className="my-4 p-4 bg-secondary/50 rounded-lg overflow-x-auto"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
})
MermaidDiagram.displayName = 'MermaidDiagram'

// Thinking block component
const ThinkingBlock = memo(({ content }: { content: string }) => {
  const [expanded, setExpanded] = useState(false)
  
  return (
    <div className="my-3 border border-border/50 rounded-lg bg-secondary/30 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-3 py-2 flex items-center gap-2 text-left hover:bg-secondary/50 transition-colors"
      >
        <Brain className="w-4 h-4 text-muted-foreground" />
        <span className="text-xs font-mono text-muted-foreground flex-1">Thinking process</span>
        {expanded ? (
          <ChevronUp className="w-4 h-4 text-muted-foreground" />
        ) : (
          <ChevronDown className="w-4 h-4 text-muted-foreground" />
        )}
      </button>
      <div
        className={cn(
          'overflow-hidden transition-all duration-300 ease-in-out',
          expanded ? 'max-h-[2000px]' : 'max-h-0'
        )}
      >
        <div className="px-3 pb-3 pt-1 border-t border-border/30 overflow-x-auto">
          <pre className="text-xs text-muted-foreground font-mono whitespace-pre-wrap break-words">
            {content.trim()}
          </pre>
        </div>
      </div>
    </div>
  )
})
ThinkingBlock.displayName = 'ThinkingBlock'

// Copy button component
const CopyButton = ({ text, className }: { text: string; className?: string }) => {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }

  return (
    <button
      onClick={handleCopy}
      className={cn(
        'p-1.5 rounded hover:bg-secondary transition-colors',
        className
      )}
      title="Copy raw content"
    >
      {copied ? (
        <Check className="w-3.5 h-3.5 text-green-500" />
      ) : (
        <Copy className="w-3.5 h-3.5 text-muted-foreground" />
      )}
    </button>
  )
}

// Code block component with copy and mermaid support
const CodeBlock = ({ 
  className, 
  children, 
  ...props 
}: React.HTMLAttributes<HTMLElement> & { children?: React.ReactNode }) => {
  const [copied, setCopied] = useState(false)
  const code = String(children).replace(/\n$/, '')
  const match = /language-(\w+)/.exec(className || '')
  const language = match ? match[1] : ''

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }

  // Render mermaid diagrams
  if (language === 'mermaid') {
    return <MermaidDiagram code={code} />
  }

  // Render SVG code blocks as actual SVG
  if (language === 'svg') {
    // Validate it looks like SVG before rendering
    const trimmedCode = code.trim()
    if (trimmedCode.startsWith('<svg') || trimmedCode.startsWith('<?xml')) {
      return (
        <div className="relative my-4 group">
          <div className="absolute top-2 right-2 z-10 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              onClick={handleCopy}
              className="p-1.5 rounded bg-secondary/80 hover:bg-secondary transition-colors"
              title="Copy SVG"
            >
              {copied ? (
                <Check className="w-3.5 h-3.5 text-green-500" />
              ) : (
                <Copy className="w-3.5 h-3.5 text-muted-foreground" />
              )}
            </button>
          </div>
          <div 
            className="p-4 bg-secondary/50 rounded-lg overflow-x-auto flex items-center justify-center"
            dangerouslySetInnerHTML={{ __html: code }}
          />
        </div>
      )
    }
  }

  // Inline code
  if (!match) {
    return (
      <code className="bg-secondary px-1.5 py-0.5 rounded text-sm font-mono" {...props}>
        {children}
      </code>
    )
  }

  // Code block with copy button
  return (
    <div className="relative my-3 group">
      <div className="absolute top-2 right-2 flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
        {language && (
          <span className="text-xs text-muted-foreground font-mono">{language}</span>
        )}
        <button
          onClick={handleCopy}
          className="p-1.5 rounded bg-secondary/80 hover:bg-secondary transition-colors"
          title="Copy code"
        >
          {copied ? (
            <Check className="w-3.5 h-3.5 text-green-500" />
          ) : (
            <Copy className="w-3.5 h-3.5 text-muted-foreground" />
          )}
        </button>
      </div>
      <pre className="bg-secondary/50 border border-border rounded-lg p-4 overflow-x-auto">
        <code className={cn('text-sm font-mono', className)} {...props}>
          {children}
        </code>
      </pre>
    </div>
  )
}

export const MessageContent = memo(function MessageContent({ content, className }: MessageContentProps) {
  const parts = parseMessageContent(content)
  
  return (
    <div className={cn('relative group', className)}>
      {/* Copy raw button */}
      <div className="absolute -top-1 -right-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <CopyButton text={content} />
      </div>
      
      {/* Render content parts */}
      <div className="prose prose-sm prose-invert max-w-none">
        {parts.map((part, index) => {
          if (part.type === 'thinking') {
            return <ThinkingBlock key={index} content={part.content} />
          }
          
          return (
            <ReactMarkdown
              key={index}
              remarkPlugins={[remarkGfm]}
              components={{
                code: CodeBlock,
                // Style other elements
                p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
                ul: ({ children }) => <ul className="list-disc list-inside mb-3 space-y-1">{children}</ul>,
                ol: ({ children }) => <ol className="list-decimal list-inside mb-3 space-y-1">{children}</ol>,
                li: ({ children }) => <li className="text-sm">{children}</li>,
                h1: ({ children }) => <h1 className="text-xl font-bold mb-3 mt-4">{children}</h1>,
                h2: ({ children }) => <h2 className="text-lg font-bold mb-2 mt-3">{children}</h2>,
                h3: ({ children }) => <h3 className="text-base font-bold mb-2 mt-3">{children}</h3>,
                blockquote: ({ children }) => (
                  <blockquote className="border-l-2 border-primary/50 pl-4 my-3 italic text-muted-foreground">
                    {children}
                  </blockquote>
                ),
                a: ({ href, children }) => (
                  <a 
                    href={href} 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="text-primary hover:underline"
                  >
                    {children}
                  </a>
                ),
                table: ({ children }) => (
                  <div className="overflow-x-auto my-3">
                    <table className="min-w-full border border-border rounded">
                      {children}
                    </table>
                  </div>
                ),
                th: ({ children }) => (
                  <th className="bg-secondary px-3 py-2 text-left text-sm font-semibold border-b border-border">
                    {children}
                  </th>
                ),
                td: ({ children }) => (
                  <td className="px-3 py-2 text-sm border-b border-border/50">
                    {children}
                  </td>
                ),
                hr: () => <hr className="my-4 border-border" />,
              }}
            >
              {part.content}
            </ReactMarkdown>
          )
        })}
      </div>
    </div>
  )
})
MessageContent.displayName = 'MessageContent'
