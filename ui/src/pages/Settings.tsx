import { useEffect, useState } from 'react'
import { Settings as SettingsIcon, ExternalLink, Image as ImageIcon, Check, Server, Code2, ChevronDown, ChevronUp } from 'lucide-react'
import { cn } from '@/lib/utils'
import { EndpointUsageGuide } from '@/components/EndpointUsageGuide'
import {
  getAdminMeta,
  listProviders,
  type Provider,
} from '@/api/client'
import {
  loadSettings,
  updateSetting,
  IMAGE_SIZE_OPTIONS,
  type ImageSize,
  type UserSettings
} from '@/stores/settings'

export function Settings() {
  const [settings, setSettings] = useState<UserSettings>(loadSettings)
  const [providers, setProviders] = useState<Provider[]>([])
  const [version, setVersion] = useState<string>('0.0.0')
  const [providersExpanded, setProvidersExpanded] = useState(false)
  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set())

  const handleImageSizeChange = (size: ImageSize) => {
    const updated = updateSetting('defaultImageSize', size)
    setSettings(updated)
  }

  useEffect(() => {
    async function loadData() {
      try {
        const [providerData, meta] = await Promise.all([
          listProviders(),
          getAdminMeta(),
        ])
        setProviders(providerData)
        setVersion(meta.version)
      } catch (error) {
        console.error('Failed to load settings metadata:', error)
      }
    }
    void loadData()
  }, [])

  const toggleProvider = (providerId: string) => {
    setExpandedProviders((previous) => {
      const next = new Set(previous)
      if (next.has(providerId)) {
        next.delete(providerId)
      } else {
        next.add(providerId)
      }
      return next
    })
  }

  return (
    <div className="flex-1 flex flex-col h-full min-h-0">
      <header className="sticky top-0 z-20 h-14 border-b border-border bg-background/95 backdrop-blur flex items-center px-6 gap-4 shrink-0">
        <div className="flex items-center gap-2">
          <SettingsIcon className="w-4 h-4 text-primary" />
          <h2 className="font-mono font-semibold text-sm uppercase tracking-wider">Settings</h2>
        </div>
      </header>

      <div className="flex-1 min-h-0 p-6 overflow-auto">
        <div className="max-w-4xl space-y-6">
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

          <div className="panel">
            <div className="panel-header">
              <Server className="w-4 h-4 text-muted-foreground" />
              <span className="panel-title">Providers & Models</span>
              <span className="text-2xs text-muted-foreground ml-auto">{providers.length} providers</span>
            </div>
            <button
              onClick={() => setProvidersExpanded((value) => !value)}
              className="w-full px-4 py-3 border-t border-border flex items-center gap-2 text-sm hover:bg-secondary/40 transition-colors"
            >
              <span>Show model breakdown and usage examples</span>
              <span className="ml-auto text-2xs text-muted-foreground">
                {providers.reduce((count, provider) => count + provider.models.filter((model) => model.enabled !== false).length, 0)} enabled models
              </span>
              {providersExpanded ? (
                <ChevronUp className="w-4 h-4 text-muted-foreground" />
              ) : (
                <ChevronDown className="w-4 h-4 text-muted-foreground" />
              )}
            </button>
            {providersExpanded && (
              <div className="divide-y divide-border">
                {providers.length === 0 && (
                  <div className="p-6 text-center text-muted-foreground text-sm">
                    No providers configured.
                  </div>
                )}
                {providers.map((provider) => {
                  const enabledModels = provider.models.filter((model) => model.enabled !== false)
                  const isOpen = expandedProviders.has(provider.id)
                  return (
                    <div key={provider.id} className="p-4 space-y-3">
                      <button
                        onClick={() => toggleProvider(provider.id)}
                        className="w-full flex items-center gap-3 text-left rounded-md p-1 hover:bg-secondary/40 transition-colors"
                      >
                        <div className={cn('status-dot', provider.enabled ? 'status-dot-live' : 'status-dot-down')} />
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm">{provider.id}</p>
                          <p className="text-2xs text-muted-foreground truncate font-mono">{provider.baseUrl}</p>
                        </div>
                        <span className="text-2xs text-muted-foreground font-mono">
                          {enabledModels.length}/{provider.models.length}
                        </span>
                        {isOpen ? (
                          <ChevronUp className="w-4 h-4 text-muted-foreground" />
                        ) : (
                          <ChevronDown className="w-4 h-4 text-muted-foreground" />
                        )}
                      </button>

                      {isOpen && (
                        <div className="space-y-2">
                          {enabledModels.length === 0 && (
                            <p className="text-xs text-muted-foreground">No enabled models in this provider.</p>
                          )}
                          {enabledModels.map((model) => {
                            const canonical = `${provider.id}/${model.modelId}`
                            return (
                              <div key={model.providerModelId} className="border border-border/70 rounded-md">
                                <div className="px-3 py-2 flex items-center gap-2">
                                  <Code2 className="w-3.5 h-3.5 text-muted-foreground" />
                                  <p className="text-xs font-mono">{canonical}</p>
                                  <span className="ml-auto text-2xs uppercase text-muted-foreground">{model.endpointType}</span>
                                </div>
                                <EndpointUsageGuide
                                  target={{
                                    id: model.providerModelId,
                                    type: model.endpointType,
                                    models: [
                                      { publicName: canonical },
                                      ...(model.aliases ?? []).map((alias) => ({ publicName: alias })),
                                    ],
                                  }}
                                />
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          <div className="panel">
            <div className="panel-header">
              <span className="panel-title">About Waypoint</span>
            </div>
            <div className="p-4 space-y-4">
              <p className="text-sm text-muted-foreground">
                Waypoint is a provider-first local AI gateway. It provides an OpenAI-compatible
                API over multiple providers/models, with routing, failover, and observability.
              </p>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-2xs font-mono uppercase text-muted-foreground">Version</p>
                  <p className="font-mono">{version}</p>
                </div>
                <div>
                  <p className="text-2xs font-mono uppercase text-muted-foreground">Config Path</p>
                  <p className="font-mono text-sm truncate">~/.config/waypoint/providers.json</p>
                </div>
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="panel-header">
              <span className="panel-title">CLI Commands</span>
            </div>
            <div className="p-4 space-y-3">
              <CommandRow command="waypoint provider import -f .env" description="Import providers and credentials" />
              <CommandRow command="waypoint provider ls" description="List providers" />
              <CommandRow command="waypoint provider model ls <providerId>" description="List models in one provider" />
              <CommandRow command="waypoint provider model add <providerId> ..." description="Add a provider-owned model" />
              <CommandRow command="waypoint provider model update <providerId> <modelRef>" description="Update model routing/capabilities/auth" />
              <CommandRow command="waypoint bench" description="Run lightweight benchmark suite" />
            </div>
          </div>

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
