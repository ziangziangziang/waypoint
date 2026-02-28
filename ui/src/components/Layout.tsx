import { Outlet, NavLink } from 'react-router-dom'
import { 
  MessageSquare, 
  LayoutDashboard, 
  Settings as SettingsIcon,
  Radio,
  Gauge
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useEffect, useState } from 'react'
import { getAdminMeta, listProviders } from '@/api/client'

const navItems = [
  { to: '/playground', icon: MessageSquare, label: 'Playground' },
  { to: '/benchmark', icon: Gauge, label: 'Benchmark' },
  { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/settings', icon: SettingsIcon, label: 'Settings' },
]

export function Layout() {
  const [healthStatus, setHealthStatus] = useState<'live' | 'degraded' | 'down'>('down')
  const [version, setVersion] = useState<string>('0.0.0')

  useEffect(() => {
    async function checkHealth() {
      try {
        const [providers, meta] = await Promise.all([
          listProviders(),
          getAdminMeta(),
        ])
        setVersion(meta.version)

        if (providers.length === 0) {
          setHealthStatus('down')
          return
        }

        const enabledProviders = providers.filter((provider) => provider.enabled)
        const enabledModels = providers.reduce(
          (sum, provider) => sum + provider.models.filter((model) => model.enabled !== false).length,
          0
        )

        if (enabledProviders.length === providers.length && enabledModels > 0) {
          setHealthStatus('live')
        } else if (enabledModels > 0) {
          setHealthStatus('degraded')
        } else {
          setHealthStatus('down')
        }
      } catch {
        setHealthStatus('down')
      }
    }

    checkHealth()
    const interval = setInterval(checkHealth, 30000)
    return () => clearInterval(interval)
  }, [])

  return (
    <div className="min-h-screen bg-background flex">
      {/* Sidebar */}
      <aside className="w-56 border-r border-border flex flex-col noise-overlay">
        {/* Logo */}
        <div className="h-14 border-b border-border flex items-center px-4 gap-3">
          <div className="w-8 h-8 rounded overflow-hidden flex items-center justify-center">
            <img src="/ui/assets/favicon-32.png" alt="Waypoint" className="w-8 h-8" />
          </div>
          <div>
            <h1 className="font-mono font-semibold text-sm tracking-tight">WAYPOINT</h1>
            <p className="text-2xs text-muted-foreground font-mono">v{version}</p>
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 py-4 px-2 space-y-1">
          {navItems.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-all duration-150',
                  isActive
                    ? 'nav-active'
                    : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
                )
              }
            >
              <Icon className="w-4 h-4" />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>

        {/* Status Footer */}
        <div className="p-4 border-t border-border">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Radio className="w-3 h-3" />
            <span className="font-mono uppercase tracking-wider">Status</span>
            <div className="flex-1" />
            <div className="flex items-center gap-1.5">
              <div className={cn(
                'status-dot',
                healthStatus === 'live' && 'status-dot-live',
                healthStatus === 'degraded' && 'status-dot-degraded',
                healthStatus === 'down' && 'status-dot-down',
              )} />
              <span className="font-mono capitalize">{healthStatus}</span>
            </div>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col overflow-hidden">
        <Outlet />
      </main>
    </div>
  )
}
