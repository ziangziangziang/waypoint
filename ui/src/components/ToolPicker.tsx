import { useState, useEffect, useCallback } from 'react'
import {
  Wrench,
  Server,
  Plug,
  PlugZap,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  Check,
  X,
  AlertCircle,
  Loader2,
  Plus,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import {
  listMcpServers,
  listMcpTools,
  connectMcpServer,
  disconnectMcpServer,
  discoverMcpTools,
  addMcpServer,
  deleteMcpServer,
  type McpServer,
  type McpTool,
} from '@/api/client'

interface ToolPickerProps {
  selectedTools: Set<string>
  onToolsChange: (tools: Set<string>) => void
  className?: string
}

interface ServerWithTools extends McpServer {
  tools: McpTool[]
  expanded: boolean
}

export function ToolPicker({ selectedTools, onToolsChange, className }: ToolPickerProps) {
  const [servers, setServers] = useState<ServerWithTools[]>([])
  const [allTools, setAllTools] = useState<McpTool[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isConnecting, setIsConnecting] = useState<string | null>(null)
  const [showAddServer, setShowAddServer] = useState(false)
  const [newServerName, setNewServerName] = useState('')
  const [newServerUrl, setNewServerUrl] = useState('')
  const [addError, setAddError] = useState<string | null>(null)

  // Load servers and tools
  const loadData = useCallback(async () => {
    setIsLoading(true)
    try {
      const [serversRes, toolsRes] = await Promise.all([
        listMcpServers(),
        listMcpTools(),
      ])

      const tools = toolsRes.data
      setAllTools(tools)

      // Group tools by server
      const serverMap = new Map<string, McpTool[]>()
      for (const tool of tools) {
        const existing = serverMap.get(tool.serverId) || []
        serverMap.set(tool.serverId, [...existing, tool])
      }

      setServers(
        serversRes.data.map((s) => ({
          ...s,
          tools: serverMap.get(s.id) || [],
          expanded: true,
        }))
      )
    } catch (error) {
      console.error('Failed to load MCP data:', error)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    loadData()
  }, [loadData])

  // Connect to a server
  const handleConnect = async (serverId: string) => {
    setIsConnecting(serverId)
    try {
      await connectMcpServer(serverId)
      await loadData() // Reload to get new tools
    } catch (error) {
      console.error('Failed to connect:', error)
    } finally {
      setIsConnecting(null)
    }
  }

  // Disconnect from a server
  const handleDisconnect = async (serverId: string) => {
    setIsConnecting(serverId)
    try {
      await disconnectMcpServer(serverId)
      // Remove tools from selection
      const serverTools = allTools.filter((t) => t.serverId === serverId)
      const newSelected = new Set(selectedTools)
      serverTools.forEach((t) => newSelected.delete(t.name))
      onToolsChange(newSelected)
      await loadData()
    } catch (error) {
      console.error('Failed to disconnect:', error)
    } finally {
      setIsConnecting(null)
    }
  }

  // Discover all tools
  const handleDiscoverAll = async () => {
    setIsLoading(true)
    try {
      await discoverMcpTools()
      await loadData()
    } catch (error) {
      console.error('Failed to discover tools:', error)
    } finally {
      setIsLoading(false)
    }
  }

  // Add new server
  const handleAddServer = async () => {
    if (!newServerName.trim() || !newServerUrl.trim()) {
      setAddError('Name and URL are required')
      return
    }

    setAddError(null)
    try {
      await addMcpServer(newServerName.trim(), newServerUrl.trim(), true)
      setNewServerName('')
      setNewServerUrl('')
      setShowAddServer(false)
      await loadData()
    } catch (error) {
      setAddError((error as Error).message || 'Failed to add server')
    }
  }

  // Delete server
  const handleDeleteServer = async (serverId: string) => {
    try {
      await deleteMcpServer(serverId)
      await loadData()
    } catch (error) {
      console.error('Failed to delete server:', error)
    }
  }

  // Toggle tool selection
  const toggleTool = (toolName: string) => {
    const newSelected = new Set(selectedTools)
    if (newSelected.has(toolName)) {
      newSelected.delete(toolName)
    } else {
      newSelected.add(toolName)
    }
    onToolsChange(newSelected)
  }

  // Toggle all tools from a server
  const toggleServerTools = (server: ServerWithTools) => {
    const serverToolNames = server.tools.map((t) => t.name)
    const allSelected = serverToolNames.every((name) => selectedTools.has(name))

    const newSelected = new Set(selectedTools)
    if (allSelected) {
      serverToolNames.forEach((name) => newSelected.delete(name))
    } else {
      serverToolNames.forEach((name) => newSelected.add(name))
    }
    onToolsChange(newSelected)
  }

  // Toggle server expanded state
  const toggleServerExpanded = (serverId: string) => {
    setServers((prev) =>
      prev.map((s) =>
        s.id === serverId ? { ...s, expanded: !s.expanded } : s
      )
    )
  }

  return (
    <div className={cn('flex flex-col', className)}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <div className="flex items-center gap-2">
          <Wrench className="w-4 h-4 text-primary" />
          <span className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
            Tools
          </span>
          {selectedTools.size > 0 && (
            <span className="px-1.5 py-0.5 bg-primary/20 text-primary text-2xs rounded font-mono">
              {selectedTools.size}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => setShowAddServer(!showAddServer)}
            title="Add server"
          >
            <Plus className="w-3.5 h-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={handleDiscoverAll}
            disabled={isLoading}
            title="Discover all tools"
          >
            <RefreshCw className={cn('w-3.5 h-3.5', isLoading && 'animate-spin')} />
          </Button>
        </div>
      </div>

      {/* Add Server Form */}
      {showAddServer && (
        <div className="p-3 border-b border-border bg-secondary/30 space-y-2 animate-slide-in-bottom">
          <Input
            placeholder="Server name"
            value={newServerName}
            onChange={(e) => setNewServerName(e.target.value)}
            className="h-8 text-sm"
          />
          <Input
            placeholder="http://localhost:3000/mcp"
            value={newServerUrl}
            onChange={(e) => setNewServerUrl(e.target.value)}
            className="h-8 text-sm font-mono"
          />
          {addError && (
            <p className="text-destructive text-2xs flex items-center gap-1">
              <AlertCircle className="w-3 h-3" />
              {addError}
            </p>
          )}
          <div className="flex gap-2">
            <Button size="sm" className="flex-1 h-7 text-xs" onClick={handleAddServer}>
              Add
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() => {
                setShowAddServer(false)
                setAddError(null)
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* Server and Tools List */}
      <div className="flex-1 overflow-y-auto">
        {servers.length === 0 && !isLoading && (
          <div className="p-4 text-center">
            <Server className="w-8 h-8 text-muted-foreground/50 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">No MCP servers</p>
            <p className="text-2xs text-muted-foreground/70 mt-1">
              Add a server to discover tools
            </p>
          </div>
        )}

        {servers.map((server) => (
          <div key={server.id} className="border-b border-border/50 last:border-0">
            {/* Server Header */}
            <div
              className={cn(
                'flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-secondary/50 transition-colors',
                server.connected && 'bg-emerald-500/5'
              )}
              onClick={() => toggleServerExpanded(server.id)}
            >
              {server.expanded ? (
                <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              )}

              <div
                className={cn(
                  'w-2 h-2 rounded-full shrink-0',
                  server.connected
                    ? 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.5)]'
                    : server.status === 'error'
                    ? 'bg-red-500'
                    : 'bg-muted-foreground/30'
                )}
              />

              <span className="text-sm font-medium truncate flex-1">{server.name}</span>

              {server.tools.length > 0 && (
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    toggleServerTools(server)
                  }}
                  className={cn(
                    'w-5 h-5 rounded flex items-center justify-center transition-colors',
                    server.tools.every((t) => selectedTools.has(t.name))
                      ? 'bg-primary text-primary-foreground'
                      : server.tools.some((t) => selectedTools.has(t.name))
                      ? 'bg-primary/50 text-primary-foreground'
                      : 'bg-secondary hover:bg-secondary/80'
                  )}
                >
                  <Check className="w-3 h-3" />
                </button>
              )}

              {isConnecting === server.id ? (
                <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
              ) : server.connected ? (
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    handleDisconnect(server.id)
                  }}
                  className="p-1 hover:bg-destructive/20 rounded transition-colors"
                  title="Disconnect"
                >
                  <PlugZap className="w-3.5 h-3.5 text-emerald-500" />
                </button>
              ) : (
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    handleConnect(server.id)
                  }}
                  className="p-1 hover:bg-primary/20 rounded transition-colors"
                  title="Connect"
                >
                  <Plug className="w-3.5 h-3.5 text-muted-foreground" />
                </button>
              )}

              <button
                onClick={(e) => {
                  e.stopPropagation()
                  handleDeleteServer(server.id)
                }}
                className="p-1 hover:bg-destructive/20 rounded transition-colors opacity-50 hover:opacity-100"
                title="Delete server"
              >
                <X className="w-3 h-3 text-destructive" />
              </button>
            </div>

            {/* Tools List */}
            {server.expanded && (
              <div className="pb-1">
                {server.tools.length === 0 ? (
                  <div className="px-8 py-2 text-2xs text-muted-foreground/70">
                    {server.connected ? 'No tools available' : 'Connect to discover tools'}
                  </div>
                ) : (
                  server.tools.map((tool) => (
                    <button
                      key={tool.name}
                      onClick={() => toggleTool(tool.name)}
                      className={cn(
                        'w-full flex items-start gap-2 px-8 py-1.5 text-left hover:bg-secondary/50 transition-colors',
                        selectedTools.has(tool.name) && 'bg-primary/5'
                      )}
                    >
                      <div
                        className={cn(
                          'w-4 h-4 rounded border flex items-center justify-center shrink-0 mt-0.5 transition-colors',
                          selectedTools.has(tool.name)
                            ? 'bg-primary border-primary'
                            : 'border-border'
                        )}
                      >
                        {selectedTools.has(tool.name) && (
                          <Check className="w-2.5 h-2.5 text-primary-foreground" />
                        )}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-mono truncate">{tool.name}</p>
                        {tool.description && (
                          <p className="text-2xs text-muted-foreground/70 line-clamp-2">
                            {tool.description}
                          </p>
                        )}
                      </div>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
