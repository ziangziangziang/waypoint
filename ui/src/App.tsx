import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { Layout } from '@/components/Layout'
import { AgentPlayground } from '@/pages/AgentPlayground'
import { Benchmark } from '@/pages/Benchmark'
import { Dashboard } from '@/pages/Dashboard'
import { Settings } from '@/pages/Settings'
import { Peek } from '@/pages/Peek'
import './styles/globals.css'

function App() {
  return (
    <BrowserRouter basename="/ui">
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<Navigate to="/playground" replace />} />
          <Route path="playground" element={<AgentPlayground />} />
          <Route path="benchmark" element={<Benchmark />} />
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="peek" element={<Peek />} />
          <Route path="settings" element={<Settings />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}

export default App
