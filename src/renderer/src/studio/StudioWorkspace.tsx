import { useCallback, useState } from 'react'
import { createPortal } from 'react-dom'

import reactFlowStyles from '@xyflow/react/dist/style.css?raw'

import ModeSegment from '../ModeSegment'
import StudioApp from './renderer/App'
import studioThemeStyles from './renderer/ai-terminal-theme.css?raw'
import studioHierarchyLayer from './renderer/hierarchy-layer.css?raw'
import studioStyles from './renderer/styles.css?raw'
import studioVisualTokens from './renderer/visual-tokens.css?raw'
import './studio-host.css'

type ConversationMode = 'chat' | 'agent'

const embeddedStyles = `
${reactFlowStyles}

${studioVisualTokens.replace(':root {', ':host {')}

${studioStyles}

${studioThemeStyles}

${studioHierarchyLayer}

:host {
  display: block;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.studio-shadow-root {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.studio-app {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  grid-template-rows: minmax(0, 1fr);
}

.studio-shell,
.page-viewport,
.workflow-page,
.canvas-workbench,
.canvas-surface,
.canvas-surface .react-flow {
  min-width: 0;
  min-height: 0;
}

.studio-shell,
.page-viewport,
.workflow-page {
  height: 100%;
}

/* The embedded Studio shares the host application's rail boundary. */
.studio-shell {
  gap: 0;
  padding: 0;
}

.electron-titlebar {
  display: none;
}

.studio-shadow-root.is-focus-mode .studio-shell {
  grid-template-columns: minmax(0, 1fr) !important;
}

.studio-shadow-root.is-focus-mode .activity-rail {
  display: none;
}
`

export default function StudioWorkspace({
  onSelectConversationMode,
  accountName,
  connectionLabel,
  modelConnected,
  onOpenUserCenter,
  onOpenGlobalCommand,
  focusMode,
}: {
  onSelectConversationMode: (mode: ConversationMode) => void
  accountName: string
  connectionLabel: string
  modelConnected: boolean
  onOpenUserCenter: () => void
  onOpenGlobalCommand: () => void
  focusMode: boolean
}) {
  const [shadowRoot, setShadowRoot] = useState<ShadowRoot | null>(null)
  const attachShadowHost = useCallback((node: HTMLDivElement | null) => {
    if (!node) return
    setShadowRoot(node.shadowRoot ?? node.attachShadow({ mode: 'open' }))
  }, [])

  return (
    <section className={`studio-host-surface${focusMode ? ' is-focus-mode' : ''}`} aria-label="Studio 图像工作流">
      <header className="studio-host-header">
        <ModeSegment
          active="studio"
          className="studio-host-mode-segment"
          onSelect={(nextMode) => {
            if (nextMode !== 'studio') onSelectConversationMode(nextMode)
          }}
        />
      </header>

      <div className="studio-shadow-host" ref={attachShadowHost}>
        {shadowRoot && createPortal(
          <>
            <style>{embeddedStyles}</style>
            <div className={`studio-shadow-root${focusMode ? ' is-focus-mode' : ''}`}>
              <StudioApp
                accountName={accountName}
                connectionLabel={connectionLabel}
                modelConnected={modelConnected}
                onOpenUserCenter={onOpenUserCenter}
                onOpenGlobalCommand={onOpenGlobalCommand}
              />
            </div>
          </>,
          shadowRoot,
        )}
      </div>
    </section>
  )
}
