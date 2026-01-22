import { useState, useRef, useEffect, useCallback } from 'react'
import { 
  Send, ImagePlus, Loader2, Bot, User, Sparkles, Plus, Trash2, 
  MessageSquare, ChevronRight, X, Image as ImageIcon 
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { MessageContent } from '@/components/MessageContent'
import { cn } from '@/lib/utils'
import { 
  streamChatCompletion, 
  listModels, 
  listSessions,
  getSession,
  createSession,
  deleteSession,
  addMessageToSession,
  generateImage,
  type ChatMessage,
  type ContentPart,
  type SessionListItem,
  type Model,
  type EndpointType,
} from '@/api/client'
import { loadSettings, IMAGE_SIZE_OPTIONS, type ImageSize } from '@/stores/settings'

interface Message extends ChatMessage {
  id: string
  images?: string[]
  createdAt: Date
}

// Helper to extract text from content (string or multimodal array)
function getTextContent(content: string | ContentPart[] | null): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  return content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map(p => p.text)
    .join('')
}

// Helper to extract images from multimodal content
function getImageUrls(content: string | ContentPart[] | null): string[] {
  if (!content || typeof content === 'string') return []
  return content
    .filter((p): p is { type: 'image_url'; image_url: { url: string } } => p.type === 'image_url')
    .map(p => p.image_url.url)
}

export function Playground() {
  // Session state
  const [sessions, setSessions] = useState<SessionListItem[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [sessionName, setSessionName] = useState('')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  
  // Chat state
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [selectedModel, setSelectedModel] = useState<string>('')
  const [models, setModels] = useState<Model[]>([])
  
  // Get the endpoint type for the selected model
  const getSelectedModelType = (): EndpointType => {
    const model = models.find(m => m.id === selectedModel)
    return model?.endpoint_type ?? 'llm'
  }
  
  // Image input state
  const [pendingImages, setPendingImages] = useState<string[]>([])
  const [isDragging, setIsDragging] = useState(false)
  
  // Image generation settings
  const [imageSize, setImageSize] = useState<ImageSize>(() => loadSettings().defaultImageSize)
  
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const abortControllerRef = useRef<AbortController | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const isStreamingRef = useRef(false)

  // Load models on mount
  useEffect(() => {
    async function loadModels() {
      try {
        const response = await listModels()
        setModels(response.data)
        if (response.data.length > 0 && !selectedModel) {
          setSelectedModel(response.data[0].id)
        }
      } catch (error) {
        console.error('Failed to load models:', error)
      }
    }
    loadModels()
  }, [selectedModel])

  // Load sessions on mount
  useEffect(() => {
    async function loadSessions() {
      try {
        const response = await listSessions()
        setSessions(response.data)
      } catch (error) {
        console.error('Failed to load sessions:', error)
      }
    }
    loadSessions()
  }, [])

  // Auto-scroll to bottom - use direct scrollTop manipulation to prevent jitter
  useEffect(() => {
    const container = messagesContainerRef.current
    if (!container) return
    
    // Only auto-scroll if user is near the bottom (within 150px)
    // This prevents jumping when user is scrolling up to read history
    const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 150
    
    if (isNearBottom || isStreamingRef.current) {
      // Use requestAnimationFrame for smoother scrolling during streaming
      requestAnimationFrame(() => {
        container.scrollTop = container.scrollHeight
      })
    }
  }, [messages])

  // Load session messages when switching
  const loadSession = useCallback(async (sessionId: string) => {
    try {
      const session = await getSession(sessionId)
      setActiveSessionId(session.id)
      setSessionName(session.name)
      if (session.model) setSelectedModel(session.model)
      setMessages(session.messages.map(m => ({
        id: crypto.randomUUID(),
        role: m.role,
        content: m.content,
        images: m.images,
        createdAt: new Date(m.timestamp),
      })))
    } catch (error) {
      console.error('Failed to load session:', error)
    }
  }, [])

  // Create new session
  const handleNewSession = async () => {
    try {
      const session = await createSession(undefined, selectedModel)
      setSessions(prev => [{ 
        id: session.id, 
        name: session.name, 
        model: session.model,
        messageCount: 0,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      }, ...prev])
      setActiveSessionId(session.id)
      setSessionName(session.name)
      setMessages([])
    } catch (error) {
      console.error('Failed to create session:', error)
    }
  }

  // Delete session
  const handleDeleteSession = async (sessionId: string) => {
    try {
      await deleteSession(sessionId)
      setSessions(prev => prev.filter(s => s.id !== sessionId))
      if (activeSessionId === sessionId) {
        setActiveSessionId(null)
        setMessages([])
        setSessionName('')
      }
    } catch (error) {
      console.error('Failed to delete session:', error)
    }
  }

  // Image handling
  const processImages = useCallback((files: FileList | File[]) => {
    Array.from(files).forEach(file => {
      if (!file.type.startsWith('image/')) return
      const reader = new FileReader()
      reader.onload = (e) => {
        const base64 = e.target?.result as string
        setPendingImages(prev => [...prev, base64])
      }
      reader.readAsDataURL(file)
    })
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    if (e.dataTransfer.files.length > 0) {
      processImages(e.dataTransfer.files)
    }
  }, [processImages])

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData.items
    const files: File[] = []
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        const file = items[i].getAsFile()
        if (file) files.push(file)
      }
    }
    if (files.length > 0) {
      processImages(files)
    }
  }, [processImages])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if ((!input.trim() && pendingImages.length === 0) || isLoading) return

    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: input.trim(),
      images: pendingImages.length > 0 ? [...pendingImages] : undefined,
      createdAt: new Date(),
    }

    setMessages(prev => [...prev, userMessage])
    setInput('')
    setPendingImages([])
    setIsLoading(true)

    // Save user message to session
    if (activeSessionId) {
      try {
        await addMessageToSession(activeSessionId, {
          role: 'user',
          content: getTextContent(userMessage.content),
          images: userMessage.images,
          timestamp: userMessage.createdAt.toISOString(),
        })
      } catch (error) {
        console.error('Failed to save user message:', error)
      }
    }

    const assistantMessage: Message = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: '',
      createdAt: new Date(),
    }
    setMessages(prev => [...prev, assistantMessage])

    try {
      const modelType = getSelectedModelType()
      
      if (modelType === 'diffusion') {
        // Image generation mode
        const prompt = getTextContent(userMessage.content)
        if (!prompt) {
          throw new Error('Please enter a prompt for image generation')
        }
        
        const imageResponse = await generateImage({
          model: selectedModel,
          prompt,
          n: 1,
          size: imageSize,
          response_format: 'b64_json',
        })
        
        // Convert response to content with image
        const imageData = imageResponse.data[0]
        const imageUrl = imageData.url || (imageData.b64_json ? `data:image/png;base64,${imageData.b64_json}` : '')
        
        const imageContent: ContentPart[] = []
        if (imageData.revised_prompt) {
          imageContent.push({ type: 'text', text: imageData.revised_prompt })
        }
        if (imageUrl) {
          imageContent.push({ type: 'image_url', image_url: { url: imageUrl } })
        }
        
        setMessages(prev =>
          prev.map(m =>
            m.id === assistantMessage.id
              ? { ...m, content: imageContent }
              : m
          )
        )
        
        // Save to session
        if (activeSessionId) {
          try {
            await addMessageToSession(activeSessionId, {
              role: 'assistant',
              content: imageContent,
              timestamp: new Date().toISOString(),
            })
          } catch (error) {
            console.error('Failed to save assistant message:', error)
          }
        }
      } else {
        // Regular chat mode (LLM, embedding, audio)
        abortControllerRef.current = new AbortController()
        isStreamingRef.current = true
      
        // Build messages with image support for VL models
        const chatMessages = [...messages, userMessage].map(m => {
          if (m.images && m.images.length > 0) {
            return {
              role: m.role,
              content: [
                ...(m.content ? [{ type: 'text' as const, text: m.content }] : []),
                ...m.images.map(img => ({
                  type: 'image_url' as const,
                  image_url: { url: img },
                })),
              ],
            }
          }
          return { role: m.role, content: m.content }
        })

        let fullContent = ''
        for await (const chunk of streamChatCompletion(
          { model: selectedModel, messages: chatMessages as ChatMessage[] },
          abortControllerRef.current.signal
        )) {
          fullContent += chunk
          setMessages(prev => 
            prev.map(m => 
              m.id === assistantMessage.id 
                ? { ...m, content: fullContent }
                : m
            )
          )
        }

        isStreamingRef.current = false
        
        // Save assistant message to session
        if (activeSessionId && fullContent) {
          try {
            await addMessageToSession(activeSessionId, {
              role: 'assistant',
              content: fullContent,
              timestamp: new Date().toISOString(),
            })
          } catch (error) {
            console.error('Failed to save assistant message:', error)
          }
        }
      }
    } catch (error) {
      isStreamingRef.current = false
      if ((error as Error).name === 'AbortError') return
      console.error('Chat error:', error)
      setMessages(prev => 
        prev.map(m => 
          m.id === assistantMessage.id 
            ? { ...m, content: 'Error occurred. Please try again.' }
            : m
        )
      )
    } finally {
      setIsLoading(false)
      abortControllerRef.current = null
      isStreamingRef.current = false
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit(e)
    }
  }

  return (
    <div className="flex-1 flex h-screen">
      {/* Sessions Sidebar */}
      <aside className={cn(
        'border-r border-border flex flex-col shrink-0 transition-all duration-300',
        sidebarCollapsed ? 'w-12' : 'w-64'
      )}>
        <div className="h-14 border-b border-border flex items-center justify-between px-3">
          {!sidebarCollapsed && (
            <span className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
              Sessions
            </span>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          >
            <ChevronRight className={cn(
              'w-4 h-4 transition-transform',
              !sidebarCollapsed && 'rotate-180'
            )} />
          </Button>
        </div>
        
        {!sidebarCollapsed && (
          <>
            <div className="p-2">
              <Button 
                onClick={handleNewSession}
                className="w-full justify-start gap-2"
                variant="outline"
              >
                <Plus className="w-4 h-4" />
                New Chat
              </Button>
            </div>
            
            <div className="flex-1 overflow-y-auto">
              {sessions.map(session => (
                <div 
                  key={session.id}
                  className={cn(
                    'group flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-secondary/50 transition-colors',
                    activeSessionId === session.id && 'bg-secondary border-l-2 border-primary'
                  )}
                  onClick={() => loadSession(session.id)}
                >
                  <MessageSquare className="w-4 h-4 text-muted-foreground shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm truncate">{session.name}</p>
                    <p className="text-2xs text-muted-foreground">
                      {session.messageCount} messages
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={(e) => {
                      e.stopPropagation()
                      handleDeleteSession(session.id)
                    }}
                  >
                    <Trash2 className="w-3 h-3 text-destructive" />
                  </Button>
                </div>
              ))}
              
              {sessions.length === 0 && (
                <div className="p-4 text-center text-muted-foreground text-sm">
                  No sessions yet
                </div>
              )}
            </div>
          </>
        )}
      </aside>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col">
        {/* Header */}
        <header className="h-14 border-b border-border flex items-center px-6 gap-4 shrink-0">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-primary" />
            <h2 className="font-mono font-semibold text-sm uppercase tracking-wider">
              {sessionName || 'Playground'}
            </h2>
          </div>
          <div className="flex-1" />
          <select 
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
            className="bg-input border border-border rounded px-3 py-1.5 text-sm font-mono focus:ring-1 focus:ring-primary focus:outline-none"
          >
            {models.length === 0 && <option value="">No models available</option>}
            {models.map(model => (
              <option key={model.id} value={model.id}>
                {model.id} {model.endpoint_type && model.endpoint_type !== 'llm' ? `[${model.endpoint_type}]` : ''}
              </option>
            ))}
          </select>
        </header>

        {/* Messages Area */}
        <div 
          ref={messagesContainerRef}
          className={cn(
            'flex-1 overflow-y-auto p-6 space-y-4 relative',
            isDragging && 'bg-primary/5 border-2 border-dashed border-primary/30'
          )}
          onDragOver={(e) => { e.preventDefault(); setIsDragging(true) }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
        >
          {isDragging && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
              <div className="bg-background/90 rounded-lg p-6 text-center">
                <ImageIcon className="w-12 h-12 text-primary mx-auto mb-2" />
                <p className="font-mono text-sm">Drop image here</p>
              </div>
            </div>
          )}
          
          {messages.length === 0 && (
            <div className="flex-1 flex items-center justify-center h-full">
              <div className="text-center space-y-4 animate-fade-in">
                <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto">
                  <Bot className="w-8 h-8 text-primary" />
                </div>
                <div>
                  <h3 className="font-mono font-semibold text-lg">Ready to chat</h3>
                  <p className="text-muted-foreground text-sm mt-1">
                    Select a model and start a conversation
                  </p>
                  <p className="text-muted-foreground text-xs mt-2">
                    Supports images via drag, drop, paste, or upload
                  </p>
                </div>
              </div>
            </div>
          )}
          
          {messages.map((message, index) => (
            <div
              key={message.id}
              className={cn(
                'flex gap-3 animate-slide-in-bottom',
                message.role === 'user' ? 'justify-end' : 'justify-start'
              )}
              style={{ animationDelay: `${index * 50}ms` }}
            >
              {message.role === 'assistant' && (
                <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center shrink-0">
                  <Bot className="w-4 h-4 text-muted-foreground" />
                </div>
              )}
              <div
                className={cn(
                  'max-w-[70%] rounded-lg px-4 py-3',
                  message.role === 'user'
                    ? 'bg-primary/10 border border-primary/20'
                    : 'bg-secondary border border-border'
                )}
              >
                {/* Render explicitly attached images */}
                {message.images && message.images.length > 0 && (
                  <div className="flex flex-wrap gap-2 mb-2">
                    {message.images.map((img, i) => (
                      <img 
                        key={i} 
                        src={img} 
                        alt={`Attached ${i + 1}`}
                        className="max-w-32 max-h-32 rounded border border-border"
                      />
                    ))}
                  </div>
                )}
                {/* Render images from multimodal content (e.g., image generation responses) */}
                {getImageUrls(message.content).length > 0 && (
                  <div className="flex flex-wrap gap-2 mb-2">
                    {getImageUrls(message.content).map((url, i) => (
                      <a 
                        key={i}
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block"
                      >
                        <img 
                          src={url} 
                          alt={`Generated ${i + 1}`}
                          className="max-w-xs max-h-64 rounded border border-border hover:border-primary transition-colors cursor-pointer"
                        />
                      </a>
                    ))}
                  </div>
                )}
                {/* Render text content with markdown support */}
                {getTextContent(message.content) && (
                  message.role === 'user' ? (
                    <p className="text-sm whitespace-pre-wrap">{getTextContent(message.content)}</p>
                  ) : (
                    <MessageContent content={getTextContent(message.content)} />
                  )
                )}
              </div>
              {message.role === 'user' && (
                <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center shrink-0">
                  <User className="w-4 h-4 text-primary" />
                </div>
              )}
            </div>
          ))}
          
          {isLoading && messages[messages.length - 1]?.content === '' && (
            <div className="flex gap-3 items-center text-muted-foreground">
              <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center">
                <Loader2 className="w-4 h-4 animate-spin" />
              </div>
              <span className="text-sm font-mono">Thinking...</span>
            </div>
          )}
          
          <div ref={messagesEndRef} />
        </div>

        {/* Pending Images Preview */}
        {pendingImages.length > 0 && (
          <div className="border-t border-border px-4 py-2 flex gap-2 flex-wrap bg-secondary/30">
            {pendingImages.map((img, i) => (
              <div key={i} className="relative group">
                <img 
                  src={img} 
                  alt={`Pending ${i + 1}`}
                  className="h-16 w-16 object-cover rounded border border-border"
                />
                <button
                  onClick={() => setPendingImages(prev => prev.filter((_, j) => j !== i))}
                  className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Input Area */}
        <div className="border-t border-border p-4">
          {/* Image Size Picker (shown for diffusion models) */}
          {getSelectedModelType() === 'diffusion' && (
            <div className="mb-3 flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Image Size:</span>
              <div className="flex gap-1 flex-wrap">
                {IMAGE_SIZE_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setImageSize(option.value)}
                    className={cn(
                      'px-2 py-1 text-xs font-mono rounded transition-colors',
                      imageSize === option.value
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-secondary text-muted-foreground hover:text-foreground hover:bg-secondary/80'
                    )}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          <form onSubmit={handleSubmit} className="flex gap-3">
            <input
              type="file"
              ref={fileInputRef}
              className="hidden"
              accept="image/*"
              multiple
              onChange={(e) => e.target.files && processImages(e.target.files)}
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="shrink-0"
              title="Attach image"
              onClick={() => fileInputRef.current?.click()}
            >
              <ImagePlus className="w-4 h-4" />
            </Button>
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder="Type a message... (paste or drop images)"
              className="min-h-[44px] max-h-32"
              rows={1}
            />
            <Button
              type="submit"
              disabled={(!input.trim() && pendingImages.length === 0) || isLoading}
              className="shrink-0"
            >
              {isLoading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Send className="w-4 h-4" />
              )}
            </Button>
          </form>
          <p className="text-2xs text-muted-foreground mt-2 text-center font-mono">
            Enter to send | Shift+Enter for new line | Paste or drop images for VL models
          </p>
        </div>
      </div>
    </div>
  )
}
