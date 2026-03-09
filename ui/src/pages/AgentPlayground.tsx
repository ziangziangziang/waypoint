import { useState, useRef, useEffect, useCallback } from 'react'
import { 
  Send, ImagePlus, Loader2, Bot, User, Sparkles, Plus, Trash2, 
  MessageSquare, ChevronRight, X, Image as ImageIcon, Wrench,
  ToggleLeft, ToggleRight, StopCircle, Mic, PhoneCall, PhoneOff
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { ToolPicker } from '@/components/ToolPicker'
import { ToolCallMessage, type ToolCall } from '@/components/ToolCallMessage'
import { MessageContent } from '@/components/MessageContent'
import { cn } from '@/lib/utils'
import { 
  streamChatCompletion, 
  createChatCompletionRaw,
  listModels, 
  listSessions,
  getSession,
  createSession,
  deleteSession,
  addMessageToSession,
  autoTitleSession,
  listMcpTools,
  executeMcpTool,
  generateImage,
  storeImage as cacheImage,
  storeMedia,
  normalizeContentMedia,
  normalizeSessionMessageMedia,
  resolveMediaUrl,
  ApiError,
  type ChatMessage as ApiChatMessage,
  type SessionListItem,
  type McpTool,
  type Model,
} from '@/api/client'
import { loadSettings, IMAGE_SIZE_OPTIONS, type ImageSize } from '@/stores/settings'
import {
  buildUserPayload,
  findNonDataImageUrls,
  toApiMessage,
} from './agentPlaygroundPayload'
import {
  applyThinkingChunk,
  createThinkingStreamState,
  toDisplayContent,
  toFinalContent,
} from './agentThinkingContent'

// Content can be a string or array of content parts (multimodal)
type ContentPart = 
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'input_audio'; input_audio: { url?: string; data?: string; format?: string } }
  | { type: 'audio'; audio: { url?: string; data?: string; format?: string } }

interface Message {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string | ContentPart[] | null
  images?: string[]
  requestImages?: string[]
  toolCalls?: ToolCall[]
  toolCallId?: string
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
    .map(p => resolveMediaUrl(p.image_url.url))
}

function getAudioUrls(content: string | ContentPart[] | null): string[] {
  if (!content || typeof content === 'string') return []
  const urls: string[] = []
  for (const part of content) {
    if (part.type === 'audio' && part.audio?.url) {
      urls.push(resolveMediaUrl(part.audio.url))
    }
    if (part.type === 'input_audio' && part.input_audio?.url) {
      urls.push(resolveMediaUrl(part.input_audio.url))
    }
  }
  return urls
}

function formatModelTag(model: Model): string {
  const caps = model.capabilities
  if (caps && caps.input.length > 0 && caps.output.length > 0) {
    return `[${caps.input.join('+')}->${caps.output.join('+')}]`
  }
  if (model.endpoint_type && model.endpoint_type !== 'llm') {
    return `[${model.endpoint_type}]`
  }
  return ''
}

function modelHealthStatus(model: Model): 'up' | 'down' | 'unknown' {
  return model.waypoint_health?.status ?? 'unknown'
}

function isModelSelectable(model: Model): boolean {
  return modelHealthStatus(model) !== 'down'
}

function firstSelectableModelId(models: Model[]): string {
  return models.find(isModelSelectable)?.id ?? ''
}

// Maximum tool iterations per user message to prevent infinite loops
const MAX_TOOL_ITERATIONS = 10
const MAX_IMAGE_PIXELS = 1080 * 720 - 1

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    reader.onload = () => resolve(reader.result as string)
    reader.readAsDataURL(file)
  })
}

async function compressImageFile(file: File): Promise<string> {
  const objectUrl = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.src = objectUrl
    await image.decode()
    const area = image.width * image.height
    if (area <= MAX_IMAGE_PIXELS) {
      return await fileToDataUrl(file)
    }

    const scale = Math.sqrt(MAX_IMAGE_PIXELS / area)
    const targetWidth = Math.max(1, Math.floor(image.width * scale))
    const targetHeight = Math.max(1, Math.floor(image.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = targetWidth
    canvas.height = targetHeight
    const context = canvas.getContext('2d')
    if (!context) {
      return await fileToDataUrl(file)
    }
    context.drawImage(image, 0, 0, targetWidth, targetHeight)
    const mimeType = file.type === 'image/jpeg' || file.type === 'image/png' ? file.type : 'image/png'
    return canvas.toDataURL(mimeType, mimeType === 'image/jpeg' ? 0.9 : undefined)
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

export function AgentPlayground() {
  // Session state
  const [sessions, setSessions] = useState<SessionListItem[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [activeSessionStorageVersion, setActiveSessionStorageVersion] = useState<number>(2)
  const [sessionName, setSessionName] = useState('')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  
  // Chat state
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [selectedModel, setSelectedModel] = useState<string>('')
  const [models, setModels] = useState<Model[]>([])

  const selectedModelSupportsImageOutput = (): boolean => {
    const model = models.find(m => m.id === selectedModel)
    if (!model) return false
    if (model.capabilities?.output?.includes('image')) return true
    return (model.endpoint_type ?? 'llm') === 'diffusion'
  }

  const selectedModelSupportsCall = (): boolean => {
    const model = models.find(m => m.id === selectedModel)
    if (!model?.capabilities) return false
    return model.capabilities.input.includes('audio') && model.capabilities.output.includes('audio')
  }

  const modelSupportsCall = selectedModelSupportsCall()
  const selectedModelConfig = models.find((model) => model.id === selectedModel)
  const selectedModelIsSelectable = selectedModelConfig ? isModelSelectable(selectedModelConfig) : false
  
  // Image input state
  const [pendingImages, setPendingImages] = useState<string[]>([])
  const [pendingAudio, setPendingAudio] = useState<string | null>(null)
  const [pendingAudioMimeType, setPendingAudioMimeType] = useState<string | undefined>(undefined)
  const [isDragging, setIsDragging] = useState(false)
  const [callModeEnabled, setCallModeEnabled] = useState(false)
  const [callStatus, setCallStatus] = useState<'idle' | 'recording' | 'sending' | 'playing'>('idle')
  const [callError, setCallError] = useState<string | null>(null)
  
  // Image generation settings
  const [imageSize, setImageSize] = useState<ImageSize>(() => loadSettings().defaultImageSize)
  
  // Agentic mode state
  const [agentModeEnabled, setAgentModeEnabled] = useState(false)
  const [showToolPicker, setShowToolPicker] = useState(false)
  const [selectedTools, setSelectedTools] = useState<Set<string>>(new Set())
  const [availableTools, setAvailableTools] = useState<McpTool[]>([])
  const [currentIteration, setCurrentIteration] = useState(0)
  const [isExecutingTools, setIsExecutingTools] = useState(false)
  
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const abortControllerRef = useRef<AbortController | null>(null)
  const stopAgentRef = useRef(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const isStreamingRef = useRef(false)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const recordingTimerRef = useRef<number | null>(null)
  const callAudioRef = useRef<HTMLAudioElement | null>(null)

  // Load models on mount
  useEffect(() => {
    async function loadModels() {
      try {
        const response = await listModels()
        setModels(response.data)
        if (response.data.length > 0 && !selectedModel) {
          setSelectedModel(firstSelectableModelId(response.data))
        }
      } catch (error) {
        console.error('Failed to load models:', error)
      }
    }
    loadModels()
  }, [selectedModel])

  // Ensure selected model stays selectable after health refreshes/session restore.
  useEffect(() => {
    if (models.length === 0) return
    const current = models.find((model) => model.id === selectedModel)
    if (!current || !isModelSelectable(current)) {
      setSelectedModel(firstSelectableModelId(models))
    }
  }, [models, selectedModel])

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

  // Load tools when agent mode is enabled
  useEffect(() => {
    if (agentModeEnabled) {
      loadTools()
    }
  }, [agentModeEnabled])

  const loadTools = async () => {
    try {
      const response = await listMcpTools()
      setAvailableTools(response.data)
    } catch (error) {
      console.error('Failed to load tools:', error)
    }
  }

  const normalizeMessageForUi = (message: Message): Message => ({
    ...message,
    content: normalizeContentMedia(message.content) as Message['content'],
    images: message.images?.map((value) => resolveMediaUrl(value)),
  })

  // Auto-scroll to bottom - use instant scroll during streaming to prevent jitter
  useEffect(() => {
    const container = messagesContainerRef.current
    if (!container) return
    
    // Use instant scroll during streaming, smooth otherwise
    const behavior = isStreamingRef.current ? 'auto' : 'smooth'
    messagesEndRef.current?.scrollIntoView({ behavior })
  }, [messages])

  // Load session messages when switching
  const loadSession = useCallback(async (sessionId: string) => {
    try {
      const session = await getSession(sessionId)
      setActiveSessionId(session.id)
      setActiveSessionStorageVersion(session.storageVersion ?? 1)
      setSessionName(session.name)
      if (session.model) setSelectedModel(session.model)
      setMessages(session.messages.map(m => {
        const normalized = normalizeSessionMessageMedia(m)
        return ({
        id: crypto.randomUUID(),
        role: normalized.role as Message['role'],
        content: normalizeContentMedia(normalized.content) as Message['content'],
        images: normalized.images,
        createdAt: new Date(m.createdAt ?? m.timestamp ?? new Date().toISOString()),
      })}))
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
      setActiveSessionStorageVersion(session.storageVersion ?? 2)
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
        setActiveSessionStorageVersion(2)
        setMessages([])
        setSessionName('')
      }
    } catch (error) {
      console.error('Failed to delete session:', error)
    }
  }

  // Image handling
  const processImages = useCallback((files: FileList | File[]) => {
    Array.from(files).forEach(async (file) => {
      if (!file.type.startsWith('image/')) return
      try {
        const base64 = await compressImageFile(file)
        setPendingImages(prev => [...prev, base64])
      } catch (error) {
        console.warn('Failed to compress image, using raw data URL:', error)
        const fallback = await fileToDataUrl(file)
        setPendingImages(prev => [...prev, fallback])
      }
    })
  }, [])

  const processAudioFile = useCallback((file: File) => {
    if (!file.type.startsWith('audio/')) return
    const reader = new FileReader()
    reader.onload = (e) => {
      const base64 = e.target?.result as string
      setPendingAudio(base64)
      setPendingAudioMimeType(file.type || undefined)
      setCallError(null)
    }
    reader.readAsDataURL(file)
  }, [])

  const processSelectedFiles = useCallback((files: FileList | File[]) => {
    const entries = Array.from(files)
    const imageFiles = entries.filter((file) => file.type.startsWith('image/'))
    if (imageFiles.length > 0) {
      processImages(imageFiles)
    }
    if (callModeEnabled) {
      const audioFile = entries.find((file) => file.type.startsWith('audio/'))
      if (audioFile) {
        processAudioFile(audioFile)
      }
    }
  }, [callModeEnabled, processAudioFile, processImages])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    if (e.dataTransfer.files.length > 0) {
      processSelectedFiles(e.dataTransfer.files)
    }
  }, [processSelectedFiles])

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData.items
    const imageFiles: File[] = []
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        const file = items[i].getAsFile()
        if (file) imageFiles.push(file)
      } else if (callModeEnabled && items[i].type.startsWith('audio/')) {
        const file = items[i].getAsFile()
        if (file) processAudioFile(file)
      }
    }
    if (imageFiles.length > 0) {
      processImages(imageFiles)
    }
  }, [callModeEnabled, processAudioFile, processImages])

  const stopPlayback = useCallback(() => {
    if (callAudioRef.current) {
      callAudioRef.current.pause()
      callAudioRef.current.currentTime = 0
      callAudioRef.current = null
    }
    if (callStatus === 'playing') {
      setCallStatus('idle')
    }
  }, [callStatus])

  const clearRecordingTimer = () => {
    if (recordingTimerRef.current !== null) {
      window.clearTimeout(recordingTimerRef.current)
      recordingTimerRef.current = null
    }
  }

  const stopMediaStream = () => {
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop())
      mediaStreamRef.current = null
    }
  }

  const stopRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current
    if (!recorder || recorder.state !== 'recording') {
      clearRecordingTimer()
      stopMediaStream()
      setCallStatus('idle')
      return
    }
    recorder.stop()
    clearRecordingTimer()
  }, [])

  const cancelRecording = useCallback(() => {
    stopRecording()
    setPendingAudio(null)
    setPendingAudioMimeType(undefined)
    setCallError(null)
  }, [stopRecording])

  const startRecording = useCallback(async () => {
    if (!selectedModelSupportsCall() || isLoading || callStatus === 'sending') {
      return
    }

    try {
      stopPlayback()
      setCallError(null)
      setCallStatus('recording')
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      mediaStreamRef.current = stream
      let recorder: MediaRecorder
      try {
        recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' })
      } catch {
        recorder = new MediaRecorder(stream)
      }
      mediaRecorderRef.current = recorder
      const chunks: BlobPart[] = []

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunks.push(event.data)
        }
      }

      recorder.onstop = async () => {
        stopMediaStream()
        clearRecordingTimer()
        if (chunks.length > 0) {
          const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })
          const reader = new FileReader()
          reader.onload = () => {
            const result = reader.result as string
            setPendingAudio(result)
            setPendingAudioMimeType(blob.type || 'audio/webm')
            setCallStatus('idle')
          }
          reader.readAsDataURL(blob)
        } else {
          setCallStatus('idle')
        }
      }

      recorder.start()
      recordingTimerRef.current = window.setTimeout(() => {
        stopRecording()
      }, 60_000)
    } catch (error) {
      console.error('Microphone access failed:', error)
      setCallStatus('idle')
      setCallError('Microphone permission denied or unavailable. You can upload an audio file instead.')
    }
  }, [callStatus, isLoading, modelSupportsCall, stopPlayback, stopRecording])

  useEffect(() => {
    if (!modelSupportsCall && callModeEnabled) {
      setCallModeEnabled(false)
      setPendingAudio(null)
      setPendingAudioMimeType(undefined)
      setCallStatus('idle')
      setCallError(null)
    }
  }, [callModeEnabled, modelSupportsCall])

  useEffect(() => {
    return () => {
      clearRecordingTimer()
      stopMediaStream()
      stopPlayback()
    }
  }, [stopPlayback])

  // Build tools array for the API
  const buildToolsForApi = () => {
    if (!agentModeEnabled || selectedTools.size === 0) return undefined
    
    return availableTools
      .filter(t => selectedTools.has(t.name))
      .map(t => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description || '',
          parameters: t.inputSchema,
        },
      }))
  }

  // Execute a tool and return result
  const executeToolCall = async (toolCall: ToolCall): Promise<string> => {
    try {
      const args = JSON.parse(toolCall.arguments)
      const result = await executeMcpTool(toolCall.name, args)
      return result.result
    } catch (error) {
      let reason = (error as Error).message
      if (error instanceof ApiError) {
        const body = error.body as { error?: { message?: string } } | undefined
        if (body?.error?.message) {
          reason = body.error.message
        }
      }
      throw new Error(`Tool execution failed: ${reason}`)
    }
  }

  // Stop the agent loop
  const stopAgent = () => {
    stopAgentRef.current = true
    abortControllerRef.current?.abort()
  }

  // The main agentic loop
  const runAgentLoop = async (
    conversationHistory: Message[],
    assistantMessageId: string
  ): Promise<void> => {
    let iteration = 0
    let currentHistory = [...conversationHistory]
    
    while (iteration < MAX_TOOL_ITERATIONS && !stopAgentRef.current) {
      setCurrentIteration(iteration + 1)
      
      // Build messages for API
      const chatMessages = currentHistory.map(m => {
        if (m.role === 'tool' && m.toolCallId) {
          return {
            role: 'tool' as const,
            tool_call_id: m.toolCallId,
            content: m.content,
          }
        }
        return toApiMessage(m)
      }) as ApiChatMessage[]
      warnIfNonDataImageUrls(chatMessages, 'agent-loop')

      // Stream the response
      abortControllerRef.current = new AbortController()
      isStreamingRef.current = true
      let fullContent = ''
      let toolCallsData: Array<{
        id: string
        function: { name: string; arguments: string }
      }> = []
      
      try {
        for await (const chunk of streamChatCompletionWithTools(
          { 
            model: selectedModel, 
            messages: chatMessages,
            tools: buildToolsForApi(),
            tool_choice: selectedTools.size > 0 ? 'auto' : undefined,
          },
          abortControllerRef.current.signal,
          (tc) => { toolCallsData = tc }
        )) {
          if (stopAgentRef.current) break
          fullContent += chunk
          setMessages(prev => 
            prev.map(m => 
              m.id === assistantMessageId 
                ? { ...m, content: fullContent }
                : m
            )
          )
        }
      } catch (error) {
        if ((error as Error).name === 'AbortError') return
        throw error
      }

      // Check if we have tool calls
      if (toolCallsData.length > 0 && !stopAgentRef.current) {
        // Create tool call objects
        const toolCalls: ToolCall[] = toolCallsData.map(tc => ({
          id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
          status: 'pending' as const,
        }))

        // Update message with tool calls
        setMessages(prev => 
          prev.map(m => 
            m.id === assistantMessageId 
              ? { ...m, content: fullContent || null, toolCalls }
              : m
          )
        )

        // Execute tools
        setIsExecutingTools(true)
        const toolResults: Message[] = []
        
        for (const toolCall of toolCalls) {
          if (stopAgentRef.current) break
          
          // Update status to executing
          setMessages(prev => 
            prev.map(m => 
              m.id === assistantMessageId 
                ? { 
                    ...m, 
                    toolCalls: m.toolCalls?.map(tc => 
                      tc.id === toolCall.id ? { ...tc, status: 'executing' as const } : tc
                    )
                  }
                : m
            )
          )

          try {
            const result = await executeToolCall(toolCall)
            
            // Update status to success
            setMessages(prev => 
              prev.map(m => 
                m.id === assistantMessageId 
                  ? { 
                      ...m, 
                      toolCalls: m.toolCalls?.map(tc => 
                        tc.id === toolCall.id 
                          ? { ...tc, status: 'success' as const, result } 
                          : tc
                      )
                    }
                  : m
              )
            )

            // Add tool result message
            toolResults.push({
              id: crypto.randomUUID(),
              role: 'tool',
              content: result,
              toolCallId: toolCall.id,
              createdAt: new Date(),
            })
          } catch (error) {
            const errorMsg = (error as Error).message
            
            // Update status to error
            setMessages(prev => 
              prev.map(m => 
                m.id === assistantMessageId 
                  ? { 
                      ...m, 
                      toolCalls: m.toolCalls?.map(tc => 
                        tc.id === toolCall.id 
                          ? { ...tc, status: 'error' as const, error: errorMsg } 
                          : tc
                      )
                    }
                  : m
              )
            )

            // Still add a tool result for the error
            toolResults.push({
              id: crypto.randomUUID(),
              role: 'tool',
              content: `Error: ${errorMsg}`,
              toolCallId: toolCall.id,
              createdAt: new Date(),
            })
          }
        }

        setIsExecutingTools(false)

        if (stopAgentRef.current) break

        // Add assistant message with tool calls and tool results to history
        const assistantWithToolCalls: Message = {
          id: assistantMessageId,
          role: 'assistant',
          content: fullContent || null,
          toolCalls,
          createdAt: new Date(),
        }
        
        currentHistory = [...currentHistory.slice(0, -1), assistantWithToolCalls, ...toolResults]
        
        // Create new assistant message for next iteration
        const newAssistantId = crypto.randomUUID()
        const newAssistantMessage: Message = {
          id: newAssistantId,
          role: 'assistant',
          content: '',
          createdAt: new Date(),
        }
        
        setMessages(prev => [...prev, ...toolResults, newAssistantMessage])
        assistantMessageId = newAssistantId
        currentHistory = [...currentHistory, newAssistantMessage]
        
        iteration++
      } else {
        // No tool calls, we're done
        break
      }
    }
    
    setCurrentIteration(0)
  }

  const warnIfNonDataImageUrls = (chatMessages: ApiChatMessage[], context: string) => {
    if (!import.meta.env.DEV) return
    const invalidUrls = findNonDataImageUrls(chatMessages)
    if (invalidUrls.length > 0) {
      console.warn(`[AgentPlayground][${context}] Non-data image URLs detected in chat payload`, invalidUrls)
    }
  }

  const extractAssistantAudio = (message: unknown): { url?: string; data?: string; format?: string } | null => {
    if (!message || typeof message !== 'object') return null
    const msg = message as Record<string, unknown>
    const direct = msg.audio as Record<string, unknown> | undefined
    if (direct && (typeof direct.url === 'string' || typeof direct.data === 'string')) {
      return {
        url: typeof direct.url === 'string' ? direct.url : undefined,
        data: typeof direct.data === 'string' ? direct.data : undefined,
        format: typeof direct.format === 'string' ? direct.format : undefined,
      }
    }
    const content = msg.content
    if (!Array.isArray(content)) return null
    for (const part of content) {
      if (!part || typeof part !== 'object') continue
      const p = part as Record<string, unknown>
      const audioObj = p.audio as Record<string, unknown> | undefined
      if ((p.type === 'audio' || p.type === 'output_audio') && audioObj) {
        return {
          url: typeof audioObj.url === 'string' ? audioObj.url : undefined,
          data: typeof audioObj.data === 'string' ? audioObj.data : undefined,
          format: typeof audioObj.format === 'string' ? audioObj.format : undefined,
        }
      }
    }
    return null
  }

  const formatToMimeType = (format?: string): string | undefined => {
    if (!format) return undefined
    const lower = format.toLowerCase()
    if (lower === 'wav') return 'audio/wav'
    if (lower === 'mp3' || lower === 'mpeg') return 'audio/mpeg'
    if (lower === 'ogg') return 'audio/ogg'
    if (lower === 'webm') return 'audio/webm'
    if (lower === 'm4a' || lower === 'mp4') return 'audio/mp4'
    return undefined
  }

  const maybeAutoTitleSession = async (seedText: string): Promise<void> => {
    if (!activeSessionId) return
    const trimmed = seedText.trim()
    if (!trimmed) return
    const defaultNamePattern = /^Session\s+\d{1,2}\/\d{1,2}\/\d{2,4}$/
    if (!defaultNamePattern.test(sessionName)) {
      return
    }
    try {
      const response = await autoTitleSession(activeSessionId, {
        model: selectedModel,
        seedText: trimmed,
      })
      setSessionName(response.name)
      setSessions((prev) =>
        prev.map((item) =>
          item.id === activeSessionId
            ? { ...item, name: response.name, titleStatus: response.titleStatus, titleUpdatedAt: response.titleUpdatedAt }
            : item
        )
      )
    } catch (error) {
      console.warn('Auto-title skipped:', error)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!selectedModelConfig || !isModelSelectable(selectedModelConfig)) {
      setCallError('Selected model is unavailable. Choose a healthy model and try again.')
      return
    }
    const hasText = input.trim().length > 0
    const canSend = callModeEnabled
      ? Boolean(pendingAudio)
      : hasText || pendingImages.length > 0
    if (!canSend || isLoading) return

    stopAgentRef.current = false
    setCallError(null)

    const requestImageUrls = pendingImages.length > 0 ? [...pendingImages] : []
    let displayImageRefs = requestImageUrls.length > 0 ? [...requestImageUrls] : undefined
    if ((activeSessionStorageVersion ?? 1) >= 2 && pendingImages.length > 0) {
      try {
        const cached = await Promise.all(
          pendingImages.map((image) => cacheImage(image, selectedModel))
        )
        displayImageRefs = cached.map((item) => item.url)
      } catch (error) {
        console.error('Failed to cache input images, falling back to inline images:', error)
      }
    }

    let audioRef: string | undefined
    if (pendingAudio) {
      if ((activeSessionStorageVersion ?? 1) >= 2) {
        try {
          const cachedAudio = await storeMedia(pendingAudio, selectedModel, pendingAudioMimeType)
          audioRef = cachedAudio.url
        } catch (error) {
          console.error('Failed to cache input audio, falling back to inline audio:', error)
          audioRef = pendingAudio
        }
      } else {
        audioRef = pendingAudio
      }
    }

    const payload = buildUserPayload({
      callModeEnabled,
      text: input,
      requestImageUrls,
      displayImageRefs,
      audioRef,
    })

    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: payload.content,
      images: payload.images,
      requestImages: payload.requestImages,
      createdAt: new Date(),
    }

    setMessages(prev => [...prev, normalizeMessageForUi(userMessage)])
    setInput('')
    setPendingImages([])
    setPendingAudio(null)
    setPendingAudioMimeType(undefined)
    setIsLoading(true)

    // Save user message to session
    if (activeSessionId) {
      try {
        await addMessageToSession(activeSessionId, {
          role: 'user',
          content: userMessage.content,
          images: userMessage.images,
          timestamp: userMessage.createdAt.toISOString(),
        })
        const textForTitle = getTextContent(userMessage.content)
        if (textForTitle) {
          void maybeAutoTitleSession(textForTitle)
        }
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
    setMessages(prev => [...prev, normalizeMessageForUi(assistantMessage)])

    try {
      if (callModeEnabled) {
        setCallStatus('sending')
        const chatMessages = [...messages, userMessage].map(toApiMessage)
        warnIfNonDataImageUrls(chatMessages, 'call-mode')
        const response = await createChatCompletionRaw({
          model: selectedModel,
          messages: chatMessages,
          stream: false,
        })
        const assistant = response.choices?.[0]?.message
        const assistantText =
          typeof assistant?.content === 'string'
            ? assistant.content
            : getTextContent((assistant?.content as ContentPart[] | null) ?? null)

        const audio = extractAssistantAudio(assistant)
        let assistantAudioUrl: string | undefined
        if (audio?.url) {
          assistantAudioUrl = resolveMediaUrl(audio.url)
        } else if (audio?.data) {
          const dataUrl = audio.data.startsWith('data:')
            ? audio.data
            : `data:${formatToMimeType(audio.format) ?? 'audio/wav'};base64,${audio.data}`
          if ((activeSessionStorageVersion ?? 1) >= 2) {
            const cached = await storeMedia(
              dataUrl,
              selectedModel,
              formatToMimeType(audio.format) ?? pendingAudioMimeType
            )
            assistantAudioUrl = cached.url
          } else {
            assistantAudioUrl = dataUrl
          }
        }

        const assistantContent: ContentPart[] = [
          ...(assistantText ? [{ type: 'text' as const, text: assistantText }] : []),
          ...(assistantAudioUrl
            ? [{ type: 'audio' as const, audio: { url: assistantAudioUrl, format: audio?.format } }]
            : []),
        ]

        setMessages(prev =>
          prev.map(m =>
            m.id === assistantMessage.id
              ? { ...m, content: assistantContent.length > 0 ? assistantContent : assistantText || '' }
              : m
          )
        )

        if (assistantAudioUrl) {
          stopPlayback()
          const player = new Audio(assistantAudioUrl)
          callAudioRef.current = player
          setCallStatus('playing')
          player.onended = () => {
            setCallStatus('idle')
            callAudioRef.current = null
          }
          player.onerror = () => {
            setCallStatus('idle')
            callAudioRef.current = null
          }
          void player.play().catch((error) => {
            console.warn('Audio playback failed:', error)
            setCallStatus('idle')
            callAudioRef.current = null
          })
        } else {
          setCallStatus('idle')
        }

        if (activeSessionId) {
          await addMessageToSession(activeSessionId, {
            role: 'assistant',
            content: assistantContent.length > 0 ? assistantContent : assistantText || '',
            timestamp: new Date().toISOString(),
          })
        }
      } else if (selectedModelSupportsImageOutput()) {
        // Image generation mode
        const prompt = getTextContent(userMessage.content)
        if (!prompt) {
          throw new Error('Please enter a prompt for image generation')
        }
        
        const editInputImageUrl = requestImageUrls.length > 0 ? requestImageUrls[0] : undefined
        const imageResponse = await generateImage({
          model: selectedModel,
          prompt,
          image_url: editInputImageUrl,
          n: 1,
          size: imageSize,
          response_format: 'b64_json',
        })
        
        // Convert response to content with image
        const imageData = imageResponse.data[0]
        let imageUrl = imageData.url || ''
        if (!imageUrl && imageData.b64_json) {
          if ((activeSessionStorageVersion ?? 1) >= 2) {
            try {
              const cached = await cacheImage(imageData.b64_json, selectedModel)
              imageUrl = cached.url
            } catch (error) {
              console.error('Failed to cache generated image, using inline payload:', error)
              imageUrl = `data:image/png;base64,${imageData.b64_json}`
            }
          } else {
            imageUrl = `data:image/png;base64,${imageData.b64_json}`
          }
        }
        
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
      } else if (agentModeEnabled && selectedTools.size > 0) {
        // Run agentic loop
        await runAgentLoop(
          [...messages, userMessage, assistantMessage],
          assistantMessage.id
        )
      } else {
        // Regular chat (LLM, embedding, audio handled as chat for now)
        abortControllerRef.current = new AbortController()
        isStreamingRef.current = true
        
        const chatMessages = [...messages, userMessage].map(toApiMessage) as ApiChatMessage[]
        warnIfNonDataImageUrls(chatMessages, 'chat-stream')

        let streamState = createThinkingStreamState()
        for await (const chunk of streamChatCompletion(
          { model: selectedModel, messages: chatMessages },
          abortControllerRef.current.signal
        )) {
          streamState = applyThinkingChunk(streamState, chunk)
          const displayContent = toDisplayContent(streamState)
          setMessages(prev => 
            prev.map(m => 
              m.id === assistantMessage.id 
                ? { ...m, content: displayContent }
                : m
            )
          )
        }
        const finalContent = toFinalContent(streamState)
        setMessages(prev =>
          prev.map(m =>
            m.id === assistantMessage.id
              ? { ...m, content: finalContent }
              : m
          )
        )

        // Save assistant message
        if (activeSessionId && finalContent) {
          try {
            await addMessageToSession(activeSessionId, {
              role: 'assistant',
              content: finalContent,
              timestamp: new Date().toISOString(),
            })
          } catch (error) {
            console.error('Failed to save assistant message:', error)
          }
        }
      }
    } catch (error) {
      if ((error as Error).name === 'AbortError') return
      console.error('Chat error:', error)
      if (callModeEnabled) {
        setCallError((error as Error).message || 'Call turn failed. Try again.')
      }
      setCallStatus('idle')
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
      stopAgentRef.current = false
      isStreamingRef.current = false
      if (!callAudioRef.current) {
        setCallStatus('idle')
      }
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit(e)
    }
  }

  return (
    <div className="flex-1 flex h-full min-h-0 overflow-hidden">
      {/* Sessions Sidebar */}
      <aside className={cn(
        'border-r border-border flex flex-col min-h-0 shrink-0 transition-all duration-300',
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
      <div className="flex-1 flex flex-col min-h-0">
        {/* Header */}
        <header className="sticky top-0 z-20 h-14 border-b border-border bg-background/95 backdrop-blur flex items-center px-6 gap-4 shrink-0">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-primary" />
            <h2 className="font-mono font-semibold text-sm uppercase tracking-wider">
              {sessionName || 'Playground'}
            </h2>
          </div>
          
          {/* Agent Mode Toggle */}
          <button
            onClick={() => {
              setAgentModeEnabled(!agentModeEnabled)
              if (!agentModeEnabled) setShowToolPicker(true)
            }}
            className={cn(
              'flex items-center gap-2 px-2 py-1 rounded-md text-xs font-mono transition-colors',
              agentModeEnabled
                ? 'bg-primary/20 text-primary border border-primary/30'
                : 'bg-secondary text-muted-foreground hover:text-foreground'
            )}
          >
            {agentModeEnabled ? (
              <ToggleRight className="w-4 h-4" />
            ) : (
              <ToggleLeft className="w-4 h-4" />
            )}
            Agent Mode
            {selectedTools.size > 0 && (
              <span className="px-1.5 py-0.5 bg-primary/30 rounded text-2xs">
                {selectedTools.size}
              </span>
            )}
          </button>

          {agentModeEnabled && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs gap-1"
              onClick={() => setShowToolPicker(!showToolPicker)}
            >
              <Wrench className="w-3.5 h-3.5" />
              Tools
            </Button>
          )}

          {modelSupportsCall && (
            <Button
              variant={callModeEnabled ? "default" : "ghost"}
              size="sm"
              className="h-7 text-xs gap-1"
              onClick={() => {
                setCallModeEnabled(!callModeEnabled)
                setPendingAudio(null)
                setPendingAudioMimeType(undefined)
                setCallError(null)
                if (callStatus === 'recording') {
                  stopRecording()
                }
                stopPlayback()
              }}
            >
              {callModeEnabled ? <PhoneCall className="w-3.5 h-3.5" /> : <PhoneOff className="w-3.5 h-3.5" />}
              Call
            </Button>
          )}
          
          <div className="flex-1" />
          
          <select 
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
            className="bg-input border border-border rounded px-3 py-1.5 text-sm font-mono focus:ring-1 focus:ring-primary focus:outline-none"
          >
            {models.length === 0 && <option value="">No models available</option>}
            {models.map(model => (
              <option key={model.id} value={model.id} disabled={!isModelSelectable(model)}>
                {model.id} {formatModelTag(model)} {!isModelSelectable(model) ? '(down)' : ''}
              </option>
            ))}
          </select>
        </header>

        <div className="flex-1 min-h-0 flex overflow-hidden">
          {/* Messages Area */}
          <div className="flex-1 min-h-0 flex flex-col">
        <div 
          ref={messagesContainerRef}
          className={cn(
            'flex-1 min-h-0 overflow-y-auto p-6 space-y-4 relative',
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
                    <p className="font-mono text-sm">
                      {callModeEnabled ? 'Drop image or audio here' : 'Drop image here'}
                    </p>
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
                        {agentModeEnabled 
                          ? 'Agent mode enabled - select tools to use'
                          : 'Select a model and start a conversation'}
                      </p>
                  <p className="text-muted-foreground text-xs mt-2">
                    {callModeEnabled
                      ? 'Call mode: push-to-talk + optional text/images'
                      : 'Supports images via drag, drop, paste, or upload'}
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
                    message.role === 'user' ? 'justify-end' : 'justify-start',
                    message.role === 'tool' && 'opacity-70'
                  )}
                  style={{ animationDelay: `${index * 50}ms` }}
                >
                  {message.role === 'assistant' && (
                    <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center shrink-0">
                      <Bot className="w-4 h-4 text-muted-foreground" />
                    </div>
                  )}
                  {message.role === 'tool' && (
                    <div className="w-8 h-8 rounded-full bg-amber-500/20 flex items-center justify-center shrink-0">
                      <Wrench className="w-4 h-4 text-amber-500" />
                    </div>
                  )}
                  <div
                    className={cn(
                      'max-w-[70%] rounded-lg px-4 py-3',
                      message.role === 'user'
                        ? 'bg-primary/10 border border-primary/20'
                        : message.role === 'tool'
                        ? 'bg-amber-500/5 border border-amber-500/20'
                        : 'bg-secondary border border-border'
                    )}
                  >
                    {/* Render explicitly attached images */}
                {message.images && message.images.length > 0 && (
                  <div className="flex flex-wrap gap-2 mb-2">
                    {message.images.map((img, i) => (
                      <img 
                        key={i} 
                        src={resolveMediaUrl(img)} 
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
                    {getAudioUrls(message.content).length > 0 && (
                      <div className="flex flex-col gap-2 mb-2">
                        {getAudioUrls(message.content).map((url, i) => (
                          <audio
                            key={i}
                            controls
                            src={url}
                            className="w-full max-w-sm"
                          />
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
                    {message.toolCalls && message.toolCalls.length > 0 && (
                      <div className="mt-2">
                        <ToolCallMessage toolCalls={message.toolCalls} />
                      </div>
                    )}
                  </div>
                  {message.role === 'user' && (
                    <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center shrink-0">
                      <User className="w-4 h-4 text-primary" />
                    </div>
                  )}
                </div>
              ))}
              
              {isLoading && messages[messages.length - 1]?.content === '' && !messages[messages.length - 1]?.toolCalls && (
                <div className="flex gap-3 items-center text-muted-foreground">
                  <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center">
                    <Loader2 className="w-4 h-4 animate-spin" />
                  </div>
                  <span className="text-sm font-mono">
                    {isExecutingTools 
                      ? 'Executing tools...'
                      : currentIteration > 0 
                      ? `Thinking (iteration ${currentIteration})...`
                      : 'Thinking...'}
                  </span>
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

            {callModeEnabled && pendingAudio && (
              <div className="border-t border-border px-4 py-2 bg-secondary/20">
                <div className="flex items-center gap-2">
                  <audio controls src={pendingAudio} className="w-full max-w-md" />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0"
                    onClick={cancelRecording}
                    title="Remove pending audio"
                  >
                    <X className="w-3 h-3" />
                  </Button>
                </div>
              </div>
            )}

            {/* Input Area */}
            <div className="border-t border-border p-4">
              {/* Image Size Picker (shown for diffusion models) */}
              {selectedModelSupportsImageOutput() && (
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
                  accept={callModeEnabled ? "image/*,audio/*" : "image/*"}
                  multiple
                  onChange={(e) => {
                    if (!e.target.files) return
                    processSelectedFiles(e.target.files)
                    e.target.value = ''
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="shrink-0"
                  title={callModeEnabled ? "Attach image/audio" : "Attach image"}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <ImagePlus className="w-4 h-4" />
                </Button>
                {callModeEnabled && (
                  <Button
                    type="button"
                    variant={callStatus === 'recording' ? 'destructive' : 'outline'}
                    size="icon"
                    className="shrink-0"
                    title={callStatus === 'recording' ? 'Stop recording' : 'Start recording'}
                    disabled={isLoading || callStatus === 'sending'}
                    onClick={() => {
                      if (callStatus === 'recording') {
                        stopRecording()
                      } else {
                        void startRecording()
                      }
                    }}
                  >
                    {callStatus === 'recording' ? (
                      <StopCircle className="w-4 h-4" />
                    ) : (
                      <Mic className="w-4 h-4" />
                    )}
                  </Button>
                )}
                <Textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  onPaste={handlePaste}
                  placeholder={
                    callModeEnabled
                      ? 'Record audio with mic, then optionally add text or images...'
                      : agentModeEnabled && selectedTools.size > 0
                      ? 'Ask me anything... (agent mode enabled)'
                      : 'Type a message... (paste or drop images)'
                  }
                  className="min-h-[44px] max-h-32"
                  rows={1}
                />
                {isLoading && callModeEnabled ? (
                  <Button
                    type="button"
                    disabled
                    className="shrink-0"
                  >
                    <Loader2 className="w-4 h-4 animate-spin" />
                  </Button>
                ) : isLoading ? (
                  <Button
                    type="button"
                    variant="destructive"
                    className="shrink-0"
                    onClick={stopAgent}
                  >
                    <StopCircle className="w-4 h-4" />
                  </Button>
                ) : (
                  <Button
                    type="submit"
                    disabled={
                      isLoading ||
                      !selectedModel ||
                      !selectedModelIsSelectable ||
                      (callModeEnabled
                        ? !pendingAudio
                        : (!input.trim() && pendingImages.length === 0))
                    }
                    className="shrink-0"
                  >
                    <Send className="w-4 h-4" />
                  </Button>
                )}
              </form>
              <p className="text-2xs text-muted-foreground mt-2 text-center font-mono">
                Enter to send | Shift+Enter for new line
                {agentModeEnabled && ' | Agent mode: max 10 iterations'}
                {callModeEnabled && ' | Call mode: record, then send'}
              </p>
              {callModeEnabled && (
                <p className="text-2xs text-muted-foreground mt-1 text-center font-mono">
                  Status: {callStatus}
                </p>
              )}
              {callError && (
                <p className="text-2xs text-destructive mt-1 text-center font-mono">
                  {callError}
                </p>
              )}
            </div>
          </div>

          {/* Tool Picker Sidebar */}
          {agentModeEnabled && showToolPicker && (
            <aside className="w-72 border-l border-border flex flex-col shrink-0 animate-slide-in-right">
              <ToolPicker
                selectedTools={selectedTools}
                onToolsChange={setSelectedTools}
                className="h-full"
              />
            </aside>
          )}
        </div>
      </div>
    </div>
  )
}

// Enhanced stream function that captures tool calls
async function* streamChatCompletionWithTools(
  request: {
    model: string
    messages: ApiChatMessage[]
    tools?: unknown[]
    tool_choice?: unknown
  },
  signal: AbortSignal,
  onToolCalls: (toolCalls: Array<{ id: string; function: { name: string; arguments: string } }>) => void
): AsyncGenerator<string, void, unknown> {
  // Build request body, omitting tools/tool_choice if not present
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages,
    stream: true,
  }
  
  // Only include tools if we have them
  // Note: We don't send tool_choice by default as many backends (like vLLM)
  // require special configuration for it. Models will still use tools if provided.
  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools
    // Uncomment if your backend supports tool_choice:
    // if (request.tool_choice) {
    //   body.tool_choice = request.tool_choice
    // }
  }
  
  const response = await fetch('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })

  if (!response.ok) {
    throw new Error(`API Error: ${response.status} ${response.statusText}`)
  }

  const reader = response.body?.getReader()
  if (!reader) throw new Error('No response body')

  const decoder = new TextDecoder()
  let buffer = ''
  const toolCallsMap = new Map<number, { id: string; function: { name: string; arguments: string } }>()

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6)
        if (data === '[DONE]') {
          // Finalize tool calls
          if (toolCallsMap.size > 0) {
            onToolCalls(Array.from(toolCallsMap.values()))
          }
          return
        }
        
        try {
          const parsed = JSON.parse(data)
          const delta = parsed.choices?.[0]?.delta
          
          // Handle text content
          if (delta?.content) {
            yield delta.content
          }
          
          // Handle tool calls (accumulated across chunks)
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const index = tc.index ?? 0
              const existing = toolCallsMap.get(index)
              
              if (!existing) {
                toolCallsMap.set(index, {
                  id: tc.id || '',
                  function: {
                    name: tc.function?.name || '',
                    arguments: tc.function?.arguments || '',
                  },
                })
              } else {
                if (tc.id) existing.id = tc.id
                if (tc.function?.name) existing.function.name += tc.function.name
                if (tc.function?.arguments) existing.function.arguments += tc.function.arguments
              }
            }
          }
        } catch {
          // Skip malformed JSON
        }
      }
    }
  }

  // Finalize any remaining tool calls
  if (toolCallsMap.size > 0) {
    onToolCalls(Array.from(toolCallsMap.values()))
  }
}
