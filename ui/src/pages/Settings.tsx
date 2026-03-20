import { useEffect, useState } from 'react'
import {
  Settings as SettingsIcon,
  ExternalLink,
  Image as ImageIcon,
  Check,
  Server,
  Code2,
  ChevronDown,
  ChevronUp,
  Plus,
  Pencil,
  Trash2,
  Power,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { EndpointUsageGuide } from '@/components/EndpointUsageGuide'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  addProvider,
  addProviderModel,
  deleteProvider,
  deleteProviderModel,
  discoverProviderModels,
  type DiscoveredProviderModel,
  disableProvider,
  disableProviderModel,
  enableProvider,
  enableProviderModel,
  getAdminMeta,
  listProviders,
  updateProvider,
  updateProviderModel,
  type Provider,
  type ProviderModel,
  type EndpointType,
  type ModelModality,
} from '@/api/client'
import {
  loadSettings,
  updateSetting,
  IMAGE_SIZE_OPTIONS,
  type ImageSize,
  type UserSettings,
} from '@/stores/settings'

const ENDPOINT_OPTIONS: EndpointType[] = ['llm', 'diffusion', 'audio', 'embedding']
const MODALITY_OPTIONS: ModelModality[] = ['text', 'image', 'audio', 'embedding']

type ProviderFormValues = {
  id: string
  name: string
  baseUrl: string
  protocol: string
  enabled: boolean
  supportsRouting: boolean
  apiKey: string
  description: string
  docs: string
  insecureTls: boolean
  autoInsecureTlsDomains: string
  envVar: string
  authType: 'bearer' | 'query' | 'header' | 'none'
  keyParam: string
  headerName: string
  keyPrefix: string
  protocolConfigText: string
  limitsText: string
}

type ModelFormValues = {
  providerId: string
  modelId: string
  upstreamModel: string
  endpointType: EndpointType
  enabled: boolean
  free: boolean
  baseUrl: string
  apiKey: string
  insecureTls: boolean
  aliases: string
  modalities: string
  inputCapabilities: string
  outputCapabilities: string
  supportsTools: boolean
  supportsStreaming: boolean
  limitsText: string
}

export function Settings() {
  const [settings, setSettings] = useState<UserSettings>(loadSettings)
  const [providers, setProviders] = useState<Provider[]>([])
  const [version, setVersion] = useState<string>('0.0.0')
  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set())
  const [isLoadingProviders, setIsLoadingProviders] = useState(true)
  const [providerError, setProviderError] = useState<string | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [providerForm, setProviderForm] = useState<{ mode: 'create' | 'edit'; initial?: Provider } | null>(null)
  const [modelForm, setModelForm] = useState<{ provider: Provider; initial?: ProviderModel } | null>(null)

  const handleImageSizeChange = (size: ImageSize) => {
    const updated = updateSetting('defaultImageSize', size)
    setSettings(updated)
  }

  const loadData = async () => {
    setIsLoadingProviders(true)
    setProviderError(null)
    try {
      const [providerData, meta] = await Promise.all([listProviders(), getAdminMeta()])
      setProviders(providerData)
      setVersion(meta.version)
      setExpandedProviders((previous) => {
        const next = new Set<string>()
        for (const provider of providerData) {
          if (previous.has(provider.id)) next.add(provider.id)
        }
        return next
      })
    } catch (error) {
      setProviderError(getErrorMessage(error, 'Failed to load providers'))
    } finally {
      setIsLoadingProviders(false)
    }
  }

  useEffect(() => {
    void loadData()
  }, [])

  const toggleProvider = (providerId: string) => {
    setExpandedProviders((previous) => {
      const next = new Set(previous)
      if (next.has(providerId)) next.delete(providerId)
      else next.add(providerId)
      return next
    })
  }

  const runProviderAction = async (key: string, action: () => Promise<void>) => {
    setBusyKey(key)
    setProviderError(null)
    try {
      await action()
      await loadData()
    } catch (error) {
      setProviderError(getErrorMessage(error, 'Provider update failed'))
    } finally {
      setBusyKey(null)
    }
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
        <div className="max-w-5xl space-y-6">
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
              <Button size="sm" variant="outline" onClick={() => setProviderForm({ mode: 'create' })}>
                <Plus className="w-3.5 h-3.5 mr-1" />
                Add Provider
              </Button>
            </div>
            <div className="p-4 space-y-4">
              {providerError && (
                <div className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {providerError}
                </div>
              )}
              {isLoadingProviders && <div className="text-sm text-muted-foreground">Loading providers…</div>}
              {!isLoadingProviders && providers.length === 0 && (
                <div className="rounded border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
                  No providers configured.
                </div>
              )}
              {providers.map((provider) => {
                const enabledModels = provider.models.filter((model) => model.enabled !== false)
                const isOpen = expandedProviders.has(provider.id)
                return (
                  <div key={provider.id} className="rounded-lg border border-border overflow-hidden">
                    <div className="px-4 py-3 flex items-start gap-3">
                      <button
                        onClick={() => toggleProvider(provider.id)}
                        className="flex-1 min-w-0 text-left"
                      >
                        <div className="flex items-center gap-2">
                          <div className={cn('status-dot', provider.enabled ? 'status-dot-live' : 'status-dot-down')} />
                          <p className="font-medium text-sm">{provider.id}</p>
                          <span className="text-2xs uppercase text-muted-foreground">{provider.protocol}</span>
                        </div>
                        <p className="text-2xs text-muted-foreground truncate font-mono mt-1">{provider.baseUrl}</p>
                        <p className="text-2xs text-muted-foreground mt-1">
                          {enabledModels.length}/{provider.models.length} models enabled
                        </p>
                      </button>
                      <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busyKey === `provider-toggle:${provider.id}`}
                          onClick={() =>
                            void runProviderAction(`provider-toggle:${provider.id}`, async () => {
                              if (provider.enabled) await disableProvider(provider.id)
                              else await enableProvider(provider.id)
                            })
                          }
                        >
                          <Power className="w-3.5 h-3.5 mr-1" />
                          {provider.enabled ? 'Disable' : 'Enable'}
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setProviderForm({ mode: 'edit', initial: provider })}>
                          <Pencil className="w-3.5 h-3.5 mr-1" />
                          Edit
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setModelForm({ provider })}>
                          <Plus className="w-3.5 h-3.5 mr-1" />
                          Add Model
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-destructive hover:text-destructive"
                          disabled={busyKey === `provider-delete:${provider.id}`}
                          onClick={() => {
                            if (!window.confirm(`Delete provider ${provider.id} and all of its models?`)) return
                            void runProviderAction(`provider-delete:${provider.id}`, async () => {
                              await deleteProvider(provider.id)
                            })
                          }}
                        >
                          <Trash2 className="w-3.5 h-3.5 mr-1" />
                          Delete
                        </Button>
                        <button onClick={() => toggleProvider(provider.id)} className="p-1 text-muted-foreground">
                          {isOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                        </button>
                      </div>
                    </div>

                    {isOpen && (
                      <div className="border-t border-border bg-secondary/10">
                        <div className="px-4 py-3 grid grid-cols-2 gap-4 text-xs">
                          <ProviderMeta label="Supports Routing" value={provider.supportsRouting ? 'Yes' : 'No'} />
                          <ProviderMeta label="Imported" value={provider.importedAt ?? 'n/a'} mono />
                          <ProviderMeta label="Auth" value={provider.auth?.type ?? 'none'} />
                          <ProviderMeta label="Env Var" value={provider.envVar || 'n/a'} mono />
                        </div>
                        {provider.warnings && provider.warnings.length > 0 && (
                          <div className="px-4 pb-3 text-xs text-amber-300 space-y-1">
                            {provider.warnings.map((warning, index) => (
                              <div key={index}>{warning}</div>
                            ))}
                          </div>
                        )}
                        <div className="px-4 pb-4 space-y-3">
                          {provider.models.length === 0 && (
                            <p className="text-xs text-muted-foreground">No models configured for this provider.</p>
                          )}
                          {provider.models.map((model) => {
                            const canonical = `${provider.id}/${model.modelId}`
                            return (
                              <div key={model.providerModelId} className="border border-border/70 rounded-md bg-background">
                                <div className="px-3 py-2 flex items-start gap-3">
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 flex-wrap">
                                      <Code2 className="w-3.5 h-3.5 text-muted-foreground" />
                                      <p className="text-xs font-mono">{canonical}</p>
                                      <span className="text-2xs uppercase text-muted-foreground">{model.endpointType}</span>
                                      <span className="text-2xs text-muted-foreground">upstream {model.upstreamModel}</span>
                                    </div>
                                    <div className="text-2xs text-muted-foreground mt-1">
                                      {(model.modalities ?? []).join(', ') || 'no modalities'}
                                    </div>
                                  </div>
                                  <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      disabled={busyKey === `model-toggle:${model.providerModelId}`}
                                      onClick={() =>
                                        void runProviderAction(`model-toggle:${model.providerModelId}`, async () => {
                                          if (model.enabled === false) await enableProviderModel(provider.id, model.providerModelId)
                                          else await disableProviderModel(provider.id, model.providerModelId)
                                        })
                                      }
                                    >
                                      <Power className="w-3.5 h-3.5 mr-1" />
                                      {model.enabled === false ? 'Enable' : 'Disable'}
                                    </Button>
                                    <Button size="sm" variant="outline" onClick={() => setModelForm({ provider, initial: model })}>
                                      <Pencil className="w-3.5 h-3.5 mr-1" />
                                      Edit
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="text-destructive hover:text-destructive"
                                      disabled={busyKey === `model-delete:${model.providerModelId}`}
                                      onClick={() => {
                                        if (!window.confirm(`Delete model ${canonical}?`)) return
                                        void runProviderAction(`model-delete:${model.providerModelId}`, async () => {
                                          await deleteProviderModel(provider.id, model.providerModelId)
                                        })
                                      }}
                                    >
                                      <Trash2 className="w-3.5 h-3.5 mr-1" />
                                      Delete
                                    </Button>
                                  </div>
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
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
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
              <CommandRow command="waypoint providers import -f .env" description="Import providers and credentials" />
              <CommandRow command="waypoint providers" description="List providers" />
              <CommandRow command="waypoint models <providerId>" description="List models in one provider" />
              <CommandRow command="waypoint models add <providerId> ..." description="Add a provider-owned model" />
              <CommandRow command="waypoint models update <providerId> <modelRef>" description="Update model routing/capabilities/auth" />
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

      {providerForm && (
        <ProviderFormDialog
          title={providerForm.mode === 'create' ? 'Add Provider' : `Edit Provider ${providerForm.initial?.id}`}
          initialValues={providerForm.mode === 'create' ? emptyProviderForm() : providerToForm(providerForm.initial!)}
          isEdit={providerForm.mode === 'edit'}
          onClose={() => setProviderForm(null)}
          onSubmit={async (values) => {
            const payload = parseProviderForm(values)
            await runProviderAction(`provider-form:${values.id}`, async () => {
              if (providerForm.mode === 'create') await addProvider(payload)
              else await updateProvider(providerForm.initial!.id, payload)
            })
            setProviderForm(null)
          }}
        />
      )}

      {modelForm && (
        <ModelFormDialog
          title={modelForm.initial ? `Edit Model ${modelForm.initial.providerModelId}` : `Add Model to ${modelForm.provider.id}`}
          provider={modelForm.provider}
          allowDiscovery={!modelForm.initial}
          initialValues={modelForm.initial ? modelToForm(modelForm.provider, modelForm.initial) : emptyModelForm(modelForm.provider.id)}
          onClose={() => setModelForm(null)}
          onSubmit={async (values) => {
            const payload = parseModelForm(values)
            await runProviderAction(`model-form:${values.providerId}:${values.modelId}`, async () => {
              if (modelForm.initial) {
                await updateProviderModel(modelForm.provider.id, modelForm.initial.providerModelId, payload)
              } else {
                await addProviderModel(modelForm.provider.id, payload)
              }
            })
            setModelForm(null)
          }}
        />
      )}
    </div>
  )
}

function ProviderMeta(props: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p className="text-2xs font-mono uppercase text-muted-foreground">{props.label}</p>
      <p className={cn('text-sm truncate', props.mono && 'font-mono')}>{props.value}</p>
    </div>
  )
}

function ProviderFormDialog(props: {
  title: string
  initialValues: ProviderFormValues
  isEdit: boolean
  onClose: () => void
  onSubmit: (values: ProviderFormValues) => Promise<void>
}) {
  const [values, setValues] = useState<ProviderFormValues>(props.initialValues)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const setField = <K extends keyof ProviderFormValues>(key: K, value: ProviderFormValues[K]) => {
    setValues((current) => ({ ...current, [key]: value }))
  }

  return (
    <Overlay title={props.title} onClose={props.onClose}>
      <div className="space-y-4">
        {error && <div className="text-sm text-destructive">{error}</div>}
        <div className="grid grid-cols-2 gap-3">
          <LabeledField label="Provider ID">
            <Input value={values.id} onChange={(event) => setField('id', event.target.value)} disabled={props.isEdit} />
          </LabeledField>
          <LabeledField label="Name">
            <Input value={values.name} onChange={(event) => setField('name', event.target.value)} />
          </LabeledField>
          <LabeledField
            label="Base URL"
            description={
              <>
                <span className="block font-mono">Examples: https://api.openai.com/v1, http://localhost:11434</span>
                <span className="block">Discovery uses <code>/v1/models</code>, so root URLs and URLs already ending in <code>/v1</code> both work.</span>
              </>
            }
          >
            <Input value={values.baseUrl} onChange={(event) => setField('baseUrl', event.target.value)} />
          </LabeledField>
          <LabeledField label="Protocol">
            <select className="w-full h-9 rounded-md border border-input bg-transparent px-3 text-sm" value={values.protocol} onChange={(event) => setField('protocol', event.target.value)}>
              <option value="openai">openai</option>
              <option value="inference_v2">inference_v2</option>
              <option value="unknown">unknown</option>
            </select>
          </LabeledField>
          <ToggleField label="Enabled" checked={values.enabled} onChange={(checked) => setField('enabled', checked)} />
          <ToggleField label="Supports Routing" checked={values.supportsRouting} onChange={(checked) => setField('supportsRouting', checked)} />
        </div>
        <LabeledField label="API Key Override">
          <Input value={values.apiKey} onChange={(event) => setField('apiKey', event.target.value)} />
        </LabeledField>
        <details className="rounded border border-border p-3">
          <summary className="cursor-pointer text-sm font-medium">Advanced Provider Fields</summary>
          <div className="space-y-3 mt-3">
            <div className="grid grid-cols-2 gap-3">
              <ToggleField label="Insecure TLS" checked={values.insecureTls} onChange={(checked) => setField('insecureTls', checked)} />
              <LabeledField label="Env Var">
                <Input value={values.envVar} onChange={(event) => setField('envVar', event.target.value)} />
              </LabeledField>
              <LabeledField label="Docs URL">
                <Input value={values.docs} onChange={(event) => setField('docs', event.target.value)} />
              </LabeledField>
              <LabeledField label="Auth Type">
                <select className="w-full h-9 rounded-md border border-input bg-transparent px-3 text-sm" value={values.authType} onChange={(event) => setField('authType', event.target.value as ProviderFormValues['authType'])}>
                  <option value="bearer">bearer</option>
                  <option value="header">header</option>
                  <option value="query">query</option>
                  <option value="none">none</option>
                </select>
              </LabeledField>
              <LabeledField label="Header Name">
                <Input value={values.headerName} onChange={(event) => setField('headerName', event.target.value)} />
              </LabeledField>
              <LabeledField label="Query Param">
                <Input value={values.keyParam} onChange={(event) => setField('keyParam', event.target.value)} />
              </LabeledField>
              <LabeledField label="Key Prefix">
                <Input value={values.keyPrefix} onChange={(event) => setField('keyPrefix', event.target.value)} />
              </LabeledField>
              <LabeledField label="Auto Insecure TLS Domains (comma-separated)">
                <Input value={values.autoInsecureTlsDomains} onChange={(event) => setField('autoInsecureTlsDomains', event.target.value)} />
              </LabeledField>
            </div>
            <LabeledField label="Description">
              <Textarea value={values.description} onChange={(event) => setField('description', event.target.value)} rows={3} />
            </LabeledField>
            <LabeledField label="Protocol Config (JSON)">
              <Textarea value={values.protocolConfigText} onChange={(event) => setField('protocolConfigText', event.target.value)} rows={4} />
            </LabeledField>
            <LabeledField label="Limits (JSON)">
              <Textarea value={values.limitsText} onChange={(event) => setField('limitsText', event.target.value)} rows={4} />
            </LabeledField>
          </div>
        </details>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={props.onClose} disabled={saving}>Cancel</Button>
          <Button
            onClick={async () => {
              setSaving(true)
              setError(null)
              try {
                await props.onSubmit(values)
              } catch (err) {
                setError(getErrorMessage(err, 'Failed to save provider'))
              } finally {
                setSaving(false)
              }
            }}
            disabled={saving}
          >
            Save Provider
          </Button>
        </div>
      </div>
    </Overlay>
  )
}

function ModelFormDialog(props: {
  title: string
  provider: Provider
  allowDiscovery: boolean
  initialValues: ModelFormValues
  onClose: () => void
  onSubmit: (values: ModelFormValues) => Promise<void>
}) {
  const [values, setValues] = useState<ModelFormValues>(props.initialValues)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [discovering, setDiscovering] = useState(false)
  const [discoveryError, setDiscoveryError] = useState<string | null>(null)
  const [discoveryBaseUrl, setDiscoveryBaseUrl] = useState<string | null>(null)
  const [discoveredModels, setDiscoveredModels] = useState<DiscoveredProviderModel[]>([])

  const setField = <K extends keyof ModelFormValues>(key: K, value: ModelFormValues[K]) => {
    setValues((current) => ({ ...current, [key]: value }))
  }

  const handleDiscovery = async () => {
    setDiscovering(true)
    setDiscoveryError(null)
    try {
      const response = await discoverProviderModels(props.provider.id, {
        baseUrl: values.baseUrl.trim() || undefined,
        apiKey: values.apiKey.trim() || undefined,
        insecureTls: values.insecureTls || undefined,
      })
      setDiscoveryBaseUrl(response.baseUrl)
      setDiscoveredModels(response.models)
    } catch (err) {
      setDiscoveryError(getErrorMessage(err, 'Failed to discover models'))
    } finally {
      setDiscovering(false)
    }
  }

  const applyDiscoveredModel = (model: DiscoveredProviderModel) => {
    setValues((current) => {
      const next: ModelFormValues = {
        ...current,
        modelId: model.id,
        upstreamModel: model.id,
      }
      if (!model.capabilities) {
        return next
      }
      if (model.capabilities.input.length > 0) {
        next.inputCapabilities = model.capabilities.input.join(', ')
      }
      if (model.capabilities.output.length > 0) {
        next.outputCapabilities = model.capabilities.output.join(', ')
        next.endpointType = inferEndpointType(model.capabilities.output)
      }
      const modalities = mergeModalities(model.capabilities)
      if (modalities.length > 0) {
        next.modalities = modalities.join(', ')
      }
      if (typeof model.capabilities.supportsTools === 'boolean') {
        next.supportsTools = model.capabilities.supportsTools
      }
      if (typeof model.capabilities.supportsStreaming === 'boolean') {
        next.supportsStreaming = model.capabilities.supportsStreaming
      }
      return next
    })
  }

  return (
    <Overlay title={props.title} onClose={props.onClose}>
      <div className="space-y-4">
        {error && <div className="text-sm text-destructive">{error}</div>}
        <div className="grid grid-cols-2 gap-3">
          <LabeledField label="Model ID">
            <Input value={values.modelId} onChange={(event) => setField('modelId', event.target.value)} />
          </LabeledField>
          <LabeledField label="Upstream Model">
            <Input value={values.upstreamModel} onChange={(event) => setField('upstreamModel', event.target.value)} />
          </LabeledField>
          <LabeledField label="Endpoint Type">
            <select className="w-full h-9 rounded-md border border-input bg-transparent px-3 text-sm" value={values.endpointType} onChange={(event) => setField('endpointType', event.target.value as EndpointType)}>
              {ENDPOINT_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </LabeledField>
          <LabeledField label="Base URL Override">
            <Input value={values.baseUrl} onChange={(event) => setField('baseUrl', event.target.value)} />
          </LabeledField>
          <ToggleField label="Enabled" checked={values.enabled} onChange={(checked) => setField('enabled', checked)} />
          <ToggleField label="Free" checked={values.free} onChange={(checked) => setField('free', checked)} />
          <ToggleField label="Supports Tools" checked={values.supportsTools} onChange={(checked) => setField('supportsTools', checked)} />
          <ToggleField label="Supports Streaming" checked={values.supportsStreaming} onChange={(checked) => setField('supportsStreaming', checked)} />
        </div>
        <LabeledField label="API Key Override">
          <Input value={values.apiKey} onChange={(event) => setField('apiKey', event.target.value)} />
        </LabeledField>
        {props.allowDiscovery && (
          <div className="rounded border border-border p-3 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">Model Discovery</p>
                <p className="text-xs text-muted-foreground">
                  Fetches upstream models from <code>/v1/models</code> using this provider plus any URL, API key, or TLS overrides above.
                </p>
              </div>
              <Button variant="outline" onClick={() => void handleDiscovery()} disabled={discovering || saving}>
                {discovering ? 'Discovering…' : 'Model Discovery'}
              </Button>
            </div>
            {discoveryError && <div className="text-sm text-destructive">{discoveryError}</div>}
            {discoveryBaseUrl && (
              <div className="text-xs text-muted-foreground">
                Discovery source: <code>{discoveryBaseUrl}</code>
              </div>
            )}
            {discoveryBaseUrl && discoveredModels.length === 0 && !discoveryError && (
              <div className="text-sm text-muted-foreground">No models were returned by the upstream <code>/v1/models</code> endpoint.</div>
            )}
            {discoveredModels.length > 0 && (
              <div className="space-y-2 max-h-64 overflow-auto pr-1">
                {discoveredModels.map((model) => (
                  <button
                    key={model.id}
                    type="button"
                    onClick={() => applyDiscoveredModel(model)}
                    className="w-full rounded border border-border px-3 py-2 text-left hover:border-primary/50 hover:bg-secondary/40 transition-colors"
                  >
                    <div className="font-mono text-sm">{model.id}</div>
                    <div className="text-xs text-muted-foreground mt-1">
                      {formatDiscoveryCapabilities(model)}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <details className="rounded border border-border p-3">
          <summary className="cursor-pointer text-sm font-medium">Advanced Model Fields</summary>
          <div className="space-y-3 mt-3">
            <div className="grid grid-cols-2 gap-3">
              <ToggleField label="Insecure TLS" checked={values.insecureTls} onChange={(checked) => setField('insecureTls', checked)} />
              <LabeledField label="Aliases (comma-separated)">
                <Input value={values.aliases} onChange={(event) => setField('aliases', event.target.value)} />
              </LabeledField>
              <LabeledField label="Modalities (comma-separated)">
                <Input value={values.modalities} onChange={(event) => setField('modalities', event.target.value)} placeholder={MODALITY_OPTIONS.join(', ')} />
              </LabeledField>
              <LabeledField label="Capabilities Input (comma-separated)">
                <Input value={values.inputCapabilities} onChange={(event) => setField('inputCapabilities', event.target.value)} placeholder={MODALITY_OPTIONS.join(', ')} />
              </LabeledField>
              <LabeledField label="Capabilities Output (comma-separated)">
                <Input value={values.outputCapabilities} onChange={(event) => setField('outputCapabilities', event.target.value)} placeholder={MODALITY_OPTIONS.join(', ')} />
              </LabeledField>
            </div>
            <LabeledField label="Limits (JSON)">
              <Textarea value={values.limitsText} onChange={(event) => setField('limitsText', event.target.value)} rows={4} />
            </LabeledField>
          </div>
        </details>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={props.onClose} disabled={saving}>Cancel</Button>
          <Button
            onClick={async () => {
              setSaving(true)
              setError(null)
              try {
                await props.onSubmit(values)
              } catch (err) {
                setError(getErrorMessage(err, 'Failed to save model'))
              } finally {
                setSaving(false)
              }
            }}
            disabled={saving}
          >
            Save Model
          </Button>
        </div>
      </div>
    </Overlay>
  )
}

function Overlay(props: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-start justify-center p-6 overflow-auto">
      <div className="w-full max-w-3xl rounded-lg border border-border bg-background shadow-lg">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h3 className="font-mono font-semibold text-sm uppercase tracking-wider">{props.title}</h3>
          <button onClick={props.onClose} className="text-muted-foreground hover:text-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-4">{props.children}</div>
      </div>
    </div>
  )
}

function LabeledField(props: { label: string; description?: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-mono uppercase text-muted-foreground">{props.label}</span>
      {props.description && <span className="block text-xs text-muted-foreground">{props.description}</span>}
      {props.children}
    </label>
  )
}

function ToggleField(props: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 rounded border border-border px-3 py-2 text-sm">
      <input type="checkbox" checked={props.checked} onChange={(event) => props.onChange(event.target.checked)} />
      <span>{props.label}</span>
    </label>
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

function emptyProviderForm(): ProviderFormValues {
  return {
    id: '',
    name: '',
    baseUrl: '',
    protocol: 'openai',
    enabled: true,
    supportsRouting: true,
    apiKey: '',
    description: '',
    docs: '',
    insecureTls: false,
    autoInsecureTlsDomains: '',
    envVar: '',
    authType: 'bearer',
    keyParam: '',
    headerName: '',
    keyPrefix: '',
    protocolConfigText: '',
    limitsText: '',
  }
}

function providerToForm(provider: Provider): ProviderFormValues {
  return {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    protocol: provider.protocol,
    enabled: provider.enabled,
    supportsRouting: provider.supportsRouting,
    apiKey: provider.apiKey ?? '',
    description: provider.description ?? '',
    docs: provider.docs ?? '',
    insecureTls: provider.insecureTls === true,
    autoInsecureTlsDomains: (provider.autoInsecureTlsDomains ?? []).join(', '),
    envVar: provider.envVar ?? '',
    authType: provider.auth?.type ?? 'none',
    keyParam: provider.auth?.keyParam ?? '',
    headerName: provider.auth?.headerName ?? '',
    keyPrefix: provider.auth?.keyPrefix ?? '',
    protocolConfigText: provider.protocolConfig ? JSON.stringify(provider.protocolConfig, null, 2) : '',
    limitsText: provider.limits ? JSON.stringify(provider.limits, null, 2) : '',
  }
}

function emptyModelForm(providerId: string): ModelFormValues {
  return {
    providerId,
    modelId: '',
    upstreamModel: '',
    endpointType: 'llm',
    enabled: true,
    free: true,
    baseUrl: '',
    apiKey: '',
    insecureTls: false,
    aliases: '',
    modalities: 'text',
    inputCapabilities: 'text',
    outputCapabilities: 'text',
    supportsTools: false,
    supportsStreaming: false,
    limitsText: '',
  }
}

function modelToForm(provider: Provider, model: ProviderModel): ModelFormValues {
  return {
    providerId: provider.id,
    modelId: model.modelId,
    upstreamModel: model.upstreamModel,
    endpointType: model.endpointType,
    enabled: model.enabled !== false,
    free: model.free,
    baseUrl: model.baseUrl ?? '',
    apiKey: model.apiKey ?? '',
    insecureTls: model.insecureTls === true,
    aliases: (model.aliases ?? []).join(', '),
    modalities: (model.modalities ?? []).join(', '),
    inputCapabilities: (model.capabilities.input ?? []).join(', '),
    outputCapabilities: (model.capabilities.output ?? []).join(', '),
    supportsTools: model.capabilities.supportsTools === true,
    supportsStreaming: model.capabilities.supportsStreaming === true,
    limitsText: model.limits ? JSON.stringify(model.limits, null, 2) : '',
  }
}

function parseProviderForm(values: ProviderFormValues) {
  if (!values.id.trim() || !values.baseUrl.trim() || !values.protocol.trim()) {
    throw new Error('Provider ID, base URL, and protocol are required')
  }
  const protocolConfig = values.protocolConfigText.trim() ? parseJson(values.protocolConfigText, 'provider protocol config') : undefined
  const limits = values.limitsText.trim() ? parseJson(values.limitsText, 'provider limits') : undefined
  return {
    id: values.id.trim(),
    name: values.name.trim() || values.id.trim(),
    baseUrl: values.baseUrl.trim(),
    protocol: values.protocol.trim(),
    enabled: values.enabled,
    supportsRouting: values.supportsRouting,
    apiKey: values.apiKey.trim() || undefined,
    description: values.description.trim() || undefined,
    docs: values.docs.trim() || undefined,
    insecureTls: values.insecureTls || undefined,
    autoInsecureTlsDomains: parseCommaList(values.autoInsecureTlsDomains),
    envVar: values.envVar.trim() || undefined,
    auth: values.authType === 'none'
      ? undefined
      : {
          type: values.authType,
          keyParam: values.keyParam.trim() || undefined,
          headerName: values.headerName.trim() || undefined,
          keyPrefix: values.keyPrefix.trim() || undefined,
        },
    protocolConfig,
    limits,
  }
}

function parseModelForm(values: ModelFormValues) {
  if (!values.modelId.trim() || !values.upstreamModel.trim()) {
    throw new Error('Model ID and upstream model are required')
  }
  const input = parseModalities(values.inputCapabilities, 'input capabilities')
  const output = parseModalities(values.outputCapabilities, 'output capabilities')
  const modalities = parseModalities(values.modalities, 'modalities')
  const limits = values.limitsText.trim() ? parseJson(values.limitsText, 'model limits') : undefined
  return {
    modelId: values.modelId.trim(),
    upstreamModel: values.upstreamModel.trim(),
    endpointType: values.endpointType,
    enabled: values.enabled,
    free: values.free,
    baseUrl: values.baseUrl.trim(),
    apiKey: values.apiKey.trim() || undefined,
    insecureTls: values.insecureTls || undefined,
    aliases: parseCommaList(values.aliases),
    modalities,
    capabilities: {
      input,
      output,
      supportsTools: values.supportsTools || undefined,
      supportsStreaming: values.supportsStreaming || undefined,
    },
    limits,
  }
}

function parseCommaList(value: string): string[] {
  return value.split(',').map((part) => part.trim()).filter(Boolean)
}

function parseModalities(value: string, label: string): ModelModality[] {
  const parsed = parseCommaList(value)
  const invalid = parsed.filter((part) => !MODALITY_OPTIONS.includes(part as ModelModality))
  if (invalid.length > 0) {
    throw new Error(`Invalid ${label}: ${invalid.join(', ')}`)
  }
  return parsed as ModelModality[]
}

function parseJson(value: string, label: string) {
  try {
    return JSON.parse(value)
  } catch {
    throw new Error(`Invalid ${label} JSON`)
  }
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'body' in error) {
    const body = (error as { body?: { error?: { message?: string } } }).body
    if (body?.error?.message) return body.error.message
  }
  if (error instanceof Error && error.message) return error.message
  return fallback
}

function mergeModalities(capabilities: { input: ModelModality[]; output: ModelModality[] }): ModelModality[] {
  return Array.from(new Set([...capabilities.input, ...capabilities.output]))
}

function inferEndpointType(output: ModelModality[]): EndpointType {
  if (output.includes('text')) return 'llm'
  if (output.includes('embedding')) return 'embedding'
  if (output.includes('image')) return 'diffusion'
  if (output.includes('audio')) return 'audio'
  return 'llm'
}

function formatDiscoveryCapabilities(model: DiscoveredProviderModel): string {
  if (!model.capabilities) {
    return 'No capability metadata returned'
  }
  const parts = [
    model.capabilities.input.length > 0 ? `input ${model.capabilities.input.join(', ')}` : null,
    model.capabilities.output.length > 0 ? `output ${model.capabilities.output.join(', ')}` : null,
    model.capabilities.supportsTools === true ? 'tools' : null,
    model.capabilities.supportsStreaming === true ? 'streaming' : null,
  ].filter(Boolean)
  return parts.join(' • ') || 'No capability metadata returned'
}
