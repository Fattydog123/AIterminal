import React from 'react'
import ReactDOM from 'react-dom/client'

import '@xterm/xterm/css/xterm.css'
import App from './App'
import DesktopAuthBoundary from './AuthGate'
import './styles.css'
import './codex-monitor-theme.css'
import './codex-monitor-pages.css'
import './capability-palette.css'
import './task-history-actions.css'
import './background-tasks/background-tasks.css'
import './ui/ui-shell.css'

document.documentElement.dataset.runtime = 'onekey' in window ? 'electron' : 'web'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <DesktopAuthBoundary>
      <App />
    </DesktopAuthBoundary>
  </React.StrictMode>,
)
