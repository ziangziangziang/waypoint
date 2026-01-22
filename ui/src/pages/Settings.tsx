import { useState } from 'react'
import { Settings as SettingsIcon, ExternalLink, Image as ImageIcon, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { 
  loadSettings, 
  updateSetting, 
  IMAGE_SIZE_OPTIONS, 
  type ImageSize,
  type UserSettings 
} from '@/stores/settings'

export function Settings() {
  const [settings, setSettings] = useState<UserSettings>(loadSettings)
  
  const handleImageSizeChange = (size: ImageSize) => {
    const updated = updateSetting('defaultImageSize', size)
    setSettings(updated)
  }

  return (
    <div className="flex-1 flex flex-col h-screen">
      {/* Header */}
      <header className="h-14 border-b border-border flex items-center px-6 gap-4 shrink-0">
        <div className="flex items-center gap-2">
          <SettingsIcon className="w-4 h-4 text-primary" />
          <h2 className="font-mono font-semibold text-sm uppercase tracking-wider">Settings</h2>
        </div>
      </header>

      {/* Content */}
      <div className="flex-1 p-6 overflow-auto">
        <div className="max-w-2xl space-y-6">
          {/* Image Generation Settings */}
          <div className="panel">
            <div className="panel-header">
              <ImageIcon className="w-4 h-4 text-muted-foreground" />
              <span className="panel-title">Image Generation</span>
            </div>
            <div className="p-4 space-y-4">
              <div>
                <label className="text-sm font-medium block mb-2">Default Image Size</label>
                <p className="text-xs text-muted-foreground mb-3">
                  Used when generating images via diffusion models. Can be overridden per-request in the playground.
                </p>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {IMAGE_SIZE_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      onClick={() => handleImageSizeChange(option.value)}
                      className={cn(
                        'relative flex flex-col items-center p-3 rounded-lg border transition-all text-left',
                        settings.defaultImageSize === option.value
                          ? 'border-primary bg-primary/5 ring-1 ring-primary'
                          : 'border-border hover:border-primary/50 hover:bg-secondary/50'
                      )}
                    >
                      {settings.defaultImageSize === option.value && (
                        <div className="absolute top-1.5 right-1.5">
                          <Check className="w-3.5 h-3.5 text-primary" />
                        </div>
                      )}
                      <span className="font-mono text-sm font-medium">{option.label}</span>
                      <span className="text-2xs text-muted-foreground">{option.aspect}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Info Panel */}
          <div className="panel">
            <div className="panel-header">
              <span className="panel-title">About Waypoint</span>
            </div>
            <div className="p-4 space-y-4">
              <p className="text-sm text-muted-foreground">
                Waypoint is a local reverse proxy for LLM endpoints. It provides a unified 
                OpenAI-compatible API for multiple backends, with automatic failover, 
                health monitoring, and request statistics.
              </p>
              
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-2xs font-mono uppercase text-muted-foreground">Version</p>
                  <p className="font-mono">0.2.0</p>
                </div>
                <div>
                  <p className="text-2xs font-mono uppercase text-muted-foreground">Config Path</p>
                  <p className="font-mono text-sm truncate">~/.config/waypoint/config.yaml</p>
                </div>
              </div>
            </div>
          </div>

          {/* CLI Commands */}
          <div className="panel">
            <div className="panel-header">
              <span className="panel-title">CLI Commands</span>
            </div>
            <div className="p-4 space-y-3">
              <CommandRow 
                command="waypoint add" 
                description="Add a new endpoint" 
              />
              <CommandRow 
                command="waypoint ls" 
                description="List all endpoints" 
              />
              <CommandRow 
                command="waypoint rm <name>" 
                description="Remove an endpoint" 
              />
              <CommandRow 
                command="waypoint edit" 
                description="Edit config in $EDITOR" 
              />
              <CommandRow 
                command="waypoint stat" 
                description="Check endpoint health" 
              />
              <CommandRow 
                command="waypoint service start" 
                description="Start background service" 
              />
              <CommandRow 
                command="waypoint service stop" 
                description="Stop background service" 
              />
            </div>
          </div>

          {/* Links */}
          <div className="panel">
            <div className="panel-header">
              <span className="panel-title">Resources</span>
            </div>
            <div className="p-4 space-y-2">
              <a 
                href="https://github.com/ziangziangziang/waypoint"
                target="_blank" 
                rel="noopener noreferrer"
                className="flex items-center gap-2 text-sm text-primary hover:underline"
              >
                <ExternalLink className="w-3 h-3" />
                GitHub Repository
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function CommandRow({ command, description }: { command: string; description: string }) {
  return (
    <div className="flex items-center gap-4">
      <code className="font-mono text-sm bg-input px-2 py-1 rounded flex-shrink-0">
        {command}
      </code>
      <span className="text-sm text-muted-foreground">{description}</span>
    </div>
  )
}
