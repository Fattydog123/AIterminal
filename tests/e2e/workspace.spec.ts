import { expect, test } from '@playwright/test'

async function expectNoHorizontalOverflow(page: import('@playwright/test').Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
}

test('explicit quit actions stay separate from the titlebar close action', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => {
    const audit = { close: 0, quit: 0 }
    Object.defineProperty(window, '__windowActionAudit', {
      configurable: true,
      value: audit,
    })
    Object.defineProperty(window, 'onekey', {
      configurable: true,
      value: {
        window: {
          close: async () => {
            audit.close += 1
            return { ok: true, value: null }
          },
          quit: async () => {
            audit.quit += 1
            return { ok: true, value: null }
          },
        },
      },
    })
  })

  await page.getByRole('menuitem', { name: '文件', exact: true }).click()
  await page.getByRole('menuitem', { name: '退出 AI终点站' }).click()
  await page.keyboard.press('Control+Q')
  await page.getByRole('button', { name: '关闭', exact: true }).click()

  await expect.poll(() => page.evaluate(() => {
    const audit = (window as typeof window & {
      __windowActionAudit: { close: number; quit: number }
    }).__windowActionAudit
    return audit
  })).toEqual({ close: 1, quit: 2 })
})

test('1440 workspace supports the primary Chat and Agent workflow', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')

  await expect(page.locator('.titlebar-brand').getByText('AI终点站', { exact: true })).toBeVisible()
  await expect(page.getByRole('menubar', { name: '应用菜单' })).toBeVisible()
  await expect(page.locator('.task-sidebar')).toBeVisible()
  await expect(page.locator('.context-inspector')).toBeVisible()
  await expect(page.getByText('本轮快照', { exact: true })).toHaveCount(0)
  await expect(page.locator('.context-inspector').getByText('本地工作区', { exact: true })).toBeVisible()
  await expect(page.locator('.context-inspector').getByText('提交或推送', { exact: true })).toBeVisible()
  await expect(page.locator('.execution-track')).toBeVisible()
  await expect(page.locator('.composer')).toBeVisible()
  await page.getByRole('button', { name: '接入分组：auto' }).click()
  await page.getByRole('menuitemradio', { name: /default/ }).click()
  await expect(page.getByRole('button', { name: '接入分组：default' })).toBeVisible()

  const workspaceGeometry = await page.evaluate(() => {
    const conversation = document.querySelector<HTMLElement>('.conversation-pane')!
    const inspector = document.querySelector<HTMLElement>('.context-inspector')!
    const panel = document.querySelector<HTMLElement>('.inspector-panel')!
    const conversationStyle = getComputedStyle(conversation)
    const inspectorRect = inspector.getBoundingClientRect()
    const panelRect = panel.getBoundingClientRect()
    return {
      radius: Number.parseFloat(conversationStyle.borderTopLeftRadius),
      backdrop: conversationStyle.backdropFilter,
      inspectorX: inspectorRect.x,
      inspectorWidth: inspectorRect.width,
      panelX: panelRect.x,
      panelWidth: panelRect.width,
    }
  })
  expect(workspaceGeometry.radius).toBeGreaterThanOrEqual(16)
  expect(workspaceGeometry.backdrop).not.toBe('none')
  expect(workspaceGeometry.panelX).toBeGreaterThan(workspaceGeometry.inspectorX)
  expect(workspaceGeometry.panelWidth).toBeLessThan(workspaceGeometry.inspectorWidth)
  await expectNoHorizontalOverflow(page)

  const nativeMaterial = await page.evaluate(() => {
    document.documentElement.dataset.runtime = 'electron'
    const conversation = getComputedStyle(document.querySelector<HTMLElement>('.conversation-pane')!)
    const sidebar = getComputedStyle(document.querySelector<HTMLElement>('.task-sidebar')!)
    const surface = getComputedStyle(document.querySelector<HTMLElement>('.composer-input-surface')!)
    const result = {
      conversationBackdrop: conversation.backdropFilter,
      conversationBackground: conversation.backgroundColor,
      sidebarBackdrop: sidebar.backdropFilter,
      surfaceBackdrop: surface.backdropFilter,
    }
    document.documentElement.dataset.runtime = 'web'
    return result
  })
  expect(nativeMaterial.conversationBackdrop).not.toBe('none')
  expect(nativeMaterial.sidebarBackdrop).not.toBe('none')
  expect(nativeMaterial.surfaceBackdrop).not.toBe('none')
  expect(nativeMaterial.conversationBackground).toContain('0.42')

  await page.locator('.mode-segment').getByRole('button', { name: 'Chat' }).click()
  await expect(page.locator('.markdown-message').getByText('Chat 模式已支持', { exact: false })).toBeVisible()
  await expect(page.locator('.permission-anchor')).toHaveCount(0)

  await page.locator('.mode-segment').getByRole('button', { name: 'Agent' }).click()
  await expect(page.getByRole('button', { name: /并行子任务/ })).toHaveCount(0)
  await page.locator('.model-button').click()
  await expect(page.getByRole('dialog', { name: '选择模型' })).toBeVisible()
  await expect(page.getByPlaceholder('搜索 API 模型')).toBeVisible()
  await page.getByPlaceholder('搜索 API 模型').fill('Sol Ultra')
  await page.getByRole('button', { name: /GPT-5.6 Sol Ultra/ }).click()

  await page.locator('.reasoning-button').click()
  await page.getByRole('menuitemradio', { name: 'Extra High' }).click()
  await expect(page.locator('.reasoning-button')).toContainText('Extra High')

  await page.locator('.permission-button').click()
  await page.getByRole('menuitemradio', { name: /完全访问/ }).click()
  await expect(page.getByRole('alertdialog')).toBeVisible()
  await page.getByRole('button', { name: '开启完全访问' }).click()
  await expect(page.locator('.permission-button')).toContainText('完全访问')

  const composer = page.locator('.composer')
  await composer.getByRole('textbox', { name: '消息' }).fill('验证 React 工作区交互')
  const composerFocus = await page.evaluate(() => {
    const textarea = getComputedStyle(document.querySelector<HTMLTextAreaElement>('.composer textarea')!)
    const composerElement = getComputedStyle(document.querySelector<HTMLElement>('.composer')!)
    const surface = getComputedStyle(document.querySelector<HTMLElement>('.composer-input-surface')!)
    return {
      outlineStyle: textarea.outlineStyle,
      composerShadow: composerElement.boxShadow,
      surfaceBorder: surface.borderColor,
      surfaceShadow: surface.boxShadow,
    }
  })
  expect(composerFocus.outlineStyle).toBe('none')
  expect(composerFocus.composerShadow).toBe('none')
  expect(composerFocus.surfaceBorder).not.toContain('127, 199, 255')
  expect(composerFocus.surfaceShadow).not.toContain('127, 199, 255')
  expect(composerFocus.surfaceShadow).not.toContain('31, 111, 235')
  await composer.getByRole('button', { name: '发送' }).click()
  await expect(page.getByText('验证 React 工作区交互', { exact: true })).toBeVisible()
  const userMessageAlignment = await page.evaluate(() => {
    const readingColumn = document.querySelector<HTMLElement>('.reading-column')!.getBoundingClientRect()
    const bubbles = document.querySelectorAll<HTMLElement>('.user-message-body')
    const bubble = bubbles[bubbles.length - 1]!.getBoundingClientRect()
    return {
      rightGap: Math.abs(readingColumn.right - bubble.right),
      bubbleWidth: bubble.width,
      readingWidth: readingColumn.width,
    }
  })
  expect(userMessageAlignment.rightGap).toBeLessThanOrEqual(1)
  expect(userMessageAlignment.bubbleWidth).toBeLessThan(userMessageAlignment.readingWidth)
  const turnActivity = page.locator('.turn-activity')
  await expect(turnActivity).toContainText('正在运行测试预览')
  await expect(turnActivity).toContainText(/已处理 \d+ 秒/u)
  await expect(turnActivity.locator('.turn-activity-breath > span')).toHaveCount(3)
  await expect(turnActivity.locator('.turn-activity-breath > span').first()).toHaveCSS('animation-name', 'turn-activity-breathe')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(turnActivity.locator('.turn-activity-breath > span').first()).toHaveCSS('animation-name', 'none')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await expect(composer.getByRole('button', { name: '停止生成' })).toBeVisible()
  await composer.getByRole('button', { name: '停止生成' }).click()
  await expect(page.getByText('本轮已停止，已接收内容已加密保存。')).toBeVisible()

  await page.getByRole('button', { name: '打开终端' }).click()
  await expect(page.getByRole('region', { name: '工作台' })).toBeVisible()
  await expect(page.getByText('可信终端尚未接通')).toBeVisible()
  await expect(page.getByRole('textbox', { name: '终端不可用' })).toBeDisabled()
})

test('Studio surface opens from the shared mode switch and returns to conversations', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')

  const conversationModes = page.locator('.task-sidebar .sidebar-mode-row .mode-segment')
  await expect(conversationModes.getByRole('button', { name: 'Studio' })).toBeVisible()
  const conversationModeBox = await conversationModes.boundingBox()
  await conversationModes.getByRole('button', { name: 'Studio' }).click()

  const studio = page.getByRole('region', { name: 'Studio 图像工作流' })
  await expect(studio).toBeVisible()
  await expect(studio.getByText('图像工作流 · 等待 Electron 联机', { exact: true })).toHaveCount(0)
  await expect(studio.getByText(/线上|NewAPI|线上分组/u)).toHaveCount(0)
  const studioModes = studio.locator('.studio-host-mode-segment')
  await expect(studioModes.getByRole('button', { name: 'Studio' })).toHaveClass(/active/u)
  await expect(studioModes.getByRole('button', { name: 'Studio' })).toBeFocused()
  const studioModeBox = await studioModes.boundingBox()
  expect(conversationModeBox).not.toBeNull()
  expect(studioModeBox).not.toBeNull()
  expect(Math.abs(studioModeBox!.x - conversationModeBox!.x)).toBeLessThanOrEqual(1)
  expect(Math.abs(studioModeBox!.y - conversationModeBox!.y)).toBeLessThanOrEqual(1)
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible()
  await expect(studio.getByRole('button', { name: /wzh-server.*测试预览/u })).toBeVisible()
  await expect(studio.locator('.electron-titlebar')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /工作流/ }).first()).toHaveAttribute('aria-current', 'page')
  await expect(page.locator('.react-flow')).toBeVisible()
  const workflowSwitcher = page.getByRole('button', { name: '当前工作流', exact: true })
  await expect(workflowSwitcher).toBeVisible()
  await expect(workflowSwitcher).toContainText('霓虹茶室 · 主工作流')
  const runPanelTabs = studio.getByRole('tablist', { name: '运行面板分区' })
  await expect(runPanelTabs.getByRole('tab', { name: '运行', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(runPanelTabs.getByRole('tab')).toHaveCount(1)
  await expect(runPanelTabs.getByText('任务队列', { exact: true })).toHaveCount(0)
  await expect(runPanelTabs.getByText('历史', { exact: true })).toHaveCount(0)
  await expect(runPanelTabs.getByText('诊断', { exact: true })).toHaveCount(0)
  const studioWorkspaceSizing = await studio.locator('.studio-shadow-host').evaluate((host) => {
    const root = host.shadowRoot!
    const dock = root.querySelector<HTMLElement>('.bottom-dock')!
    const canvas = root.querySelector<HTMLElement>('.canvas-surface')!
    return {
      dockHeight: dock.getBoundingClientRect().height,
      canvasHeight: canvas.getBoundingClientRect().height,
    }
  })
  expect(studioWorkspaceSizing.dockHeight).toBeGreaterThanOrEqual(100)
  expect(studioWorkspaceSizing.dockHeight).toBeLessThanOrEqual(140)
  expect(studioWorkspaceSizing.canvasHeight).toBeGreaterThan(studioWorkspaceSizing.dockHeight * 4)
  await studio.getByRole('button', { name: '打开运行记录' }).click()
  await expect(page.getByRole('heading', { name: '运行记录', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '工作流', exact: true }).click()
  await expect(page.locator('.react-flow')).toBeVisible()
  const studioMaterial = await studio.locator('.studio-shadow-host').evaluate((host) => {
    const viewport = getComputedStyle(host.shadowRoot!.querySelector<HTMLElement>('.page-viewport')!)
    const rail = getComputedStyle(host.shadowRoot!.querySelector<HTMLElement>('.activity-rail')!)
    const canvas = getComputedStyle(host.shadowRoot!.querySelector<HTMLElement>('.canvas-surface')!)
    return {
      viewportBackdrop: viewport.backdropFilter,
      viewportRadius: Number.parseFloat(viewport.borderTopLeftRadius),
      railBackdrop: rail.backdropFilter,
      canvasRadius: Number.parseFloat(canvas.borderTopLeftRadius),
    }
  })
  expect(studioMaterial.viewportBackdrop).not.toBe('none')
  expect(studioMaterial.railBackdrop).not.toBe('none')
  expect(studioMaterial.viewportRadius).toBe(0)
  expect(studioMaterial.canvasRadius).toBe(0)
  await expectNoHorizontalOverflow(page)

  const primaryNavigation = page.getByRole('navigation', { name: '主导航' })
  await expect(primaryNavigation.locator('.activity-main > button')).toHaveCount(4)
  await expect(primaryNavigation.getByRole('button', { name: '接口', exact: true })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: '接口与插件' })).toHaveCount(0)

  await studioModes.getByRole('button', { name: 'Chat' }).click()
  await expect(page.locator('.composer')).toBeVisible()
  const activeChatMode = page.locator('.task-sidebar .sidebar-mode-row .mode-segment').getByRole('button', { name: 'Chat' })
  await expect(activeChatMode).toHaveClass(/active/u)
  await expect(activeChatMode).toBeFocused()
})

test('Studio keyboard handling remains inside the shadow workspace', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await page.locator('.task-sidebar .sidebar-mode-row .mode-segment').getByRole('button', { name: 'Studio' }).click()
  await expect(page.locator('.react-flow')).toBeVisible()

  const nodeSearch = page.getByRole('textbox', { name: '搜索节点' })
  await page.locator('.canvas-surface').click({ position: { x: 260, y: 120 } })
  await page.keyboard.press('f')
  await expect(nodeSearch).toBeFocused()

  await nodeSearch.fill('abc')
  await page.keyboard.press('g')
  await expect(nodeSearch).toHaveValue('abcg')
  await page.keyboard.press('Backspace')
  await expect(nodeSearch).toHaveValue('abc')

  await page.keyboard.press('Control+k')
  const commandSearch = page.getByPlaceholder('搜索命令、页面或节点…')
  await expect(commandSearch).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(commandSearch).not.toBeFocused()
  await expect(page.locator('.command-results button[role="option"]').first()).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(nodeSearch).toBeFocused()
})

test('Studio stays aligned and free of horizontal clipping at compact widths', async ({ page }) => {
  test.setTimeout(60_000)

  for (const width of [1280, 1120, 940]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/')
    const conversationModes = width >= 1040
      ? page.locator('.task-sidebar .sidebar-mode-row .mode-segment')
      : page.locator('.task-sidebar .rail-mode-segment')
    await expect(conversationModes).toBeVisible()
    if (width === 940) await expect(page.getByRole('group', { name: '工作模式' })).toHaveCount(1)
    const conversationModeBox = await conversationModes.boundingBox()
    await conversationModes.getByRole('button', { name: 'Studio' }).click()

    const studio = page.getByRole('region', { name: 'Studio 图像工作流' })
    await expect(studio).toBeVisible()
    await expect(page.locator('.react-flow')).toBeVisible()
    const studioModeBox = await studio.locator('.studio-host-mode-segment').boundingBox()
    expect(conversationModeBox).not.toBeNull()
    expect(studioModeBox).not.toBeNull()
    expect(Math.abs(studioModeBox!.x - conversationModeBox!.x)).toBeLessThanOrEqual(1)
    expect(Math.abs(studioModeBox!.y - conversationModeBox!.y)).toBeLessThanOrEqual(1)

    const workflowOverflow = await studio.evaluate((surface) => {
      const root = surface.querySelector<HTMLElement>('.studio-shadow-host')!.shadowRoot!
      const toolbar = root.querySelector<HTMLElement>('.workflow-toolbar')!
      const toolbarActions = root.querySelector<HTMLElement>('.toolbar-actions')!
      const viewport = root.querySelector<HTMLElement>('.page-viewport')!
      return {
        toolbar: toolbar.scrollWidth - toolbar.clientWidth,
        toolbarActions: toolbarActions.scrollWidth - toolbarActions.clientWidth,
        viewport: viewport.scrollWidth - viewport.clientWidth,
      }
    })
    expect(workflowOverflow.toolbar).toBeLessThanOrEqual(0)
    expect(workflowOverflow.toolbarActions).toBeLessThanOrEqual(0)
    expect(workflowOverflow.viewport).toBeLessThanOrEqual(0)

    if (width !== 940) continue
    const pages = [
      ['作品', '.assets-page', '.asset-filterbar'],
      ['任务', '.queue-layout', '.queue-table-panel'],
      ['记录', '.runs-layout', '.run-detail'],
      ['设置', '.settings-layout', '.settings-content'],
    ] as const
    for (const [label, layoutSelector, detailSelector] of pages) {
      await page.locator(`.activity-rail button[title^="${label}"]`).click()
      await expect(page.locator(layoutSelector)).toBeVisible()
      const overflow = await studio.evaluate((surface, selectors) => {
        const root = surface.querySelector<HTMLElement>('.studio-shadow-host')!.shadowRoot!
        const viewport = root.querySelector<HTMLElement>('.page-viewport')!
        const layout = root.querySelector<HTMLElement>(selectors.layout)!
        const detail = root.querySelector<HTMLElement>(selectors.detail)!
        return {
          viewport: viewport.scrollWidth - viewport.clientWidth,
          layout: layout.scrollWidth - layout.clientWidth,
          detail: detail.scrollWidth - detail.clientWidth,
        }
      }, { layout: layoutSelector, detail: detailSelector })
      expect(overflow.viewport).toBeLessThanOrEqual(0)
      expect(overflow.layout).toBeLessThanOrEqual(0)
      expect(overflow.detail).toBeLessThanOrEqual(0)
    }
  }
})

test('desktop application menus switch, close and keep keyboard focus', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')

  const menubar = page.getByRole('menubar', { name: '应用菜单' })
  const fileTrigger = menubar.getByRole('menuitem', { name: '文件', exact: true })
  const editTrigger = menubar.getByRole('menuitem', { name: '编辑', exact: true })

  await fileTrigger.click()
  const fileMenu = page.getByRole('menu', { name: '文件菜单' })
  await expect(fileMenu).toBeVisible()
  const fileMenuBox = await fileMenu.boundingBox()
  expect(fileMenuBox).not.toBeNull()
  expect(fileMenuBox!.x).toBeGreaterThanOrEqual(0)
  expect(fileMenuBox!.x + fileMenuBox!.width).toBeLessThanOrEqual(1440)

  await editTrigger.click()
  await expect(fileMenu).toHaveCount(0)
  await expect(page.getByRole('menu', { name: '编辑菜单' })).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu', { name: '编辑菜单' })).toHaveCount(0)
  await expect(editTrigger).toBeFocused()
  await page.keyboard.press('Control+Shift+/')
  await expect(page.getByRole('heading', { name: '键盘快捷键', exact: true })).toBeVisible()
  await expectNoHorizontalOverflow(page)
})

test('Chat and Agent history can be archived, restored and deleted from the task tree', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')

  const sidebar = page.locator('.sidebar-full')
  const agentRow = sidebar.locator('.task-row').filter({ hasText: '完善 React 工作区' })
  await agentRow.hover()
  await sidebar.getByRole('button', { name: '管理会话：完善 React 工作区' }).click()
  const archiveMenu = page.getByRole('menu', { name: '会话操作：完善 React 工作区' })
  await expect(archiveMenu).toBeVisible()
  const archiveMenuBox = await archiveMenu.boundingBox()
  expect(archiveMenuBox).not.toBeNull()
  expect(archiveMenuBox!.x).toBeGreaterThanOrEqual(0)
  expect(archiveMenuBox!.y).toBeGreaterThanOrEqual(0)
  expect(archiveMenuBox!.x + archiveMenuBox!.width).toBeLessThanOrEqual(1440)
  expect(archiveMenuBox!.y + archiveMenuBox!.height).toBeLessThanOrEqual(900)
  await archiveMenu.getByRole('menuitem', { name: '归档会话' }).click()

  await expect(agentRow).toHaveCount(0)
  const archivedGroup = sidebar.getByRole('button', { name: /已归档/ })
  await expect(archivedGroup).toBeVisible()
  await archivedGroup.click()
  const archivedAgentRow = sidebar.locator('.task-row').filter({ hasText: '完善 React 工作区' })
  await archivedAgentRow.click()
  await expect(page.getByText('该会话已归档；移出归档后才能继续发送。', { exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: '消息' })).toBeDisabled()

  await archivedAgentRow.hover()
  await sidebar.getByRole('button', { name: '管理会话：完善 React 工作区' }).click()
  await page.getByRole('menuitem', { name: '移出归档' }).click()
  await expect(sidebar.getByRole('button', { name: /已归档/ })).toHaveCount(0)
  await expect(sidebar.locator('.task-row').filter({ hasText: '完善 React 工作区' })).toBeVisible()

  const chatRow = sidebar.locator('.task-row').filter({ hasText: '接入动态模型目录' })
  await chatRow.hover()
  await sidebar.getByRole('button', { name: '管理会话：接入动态模型目录' }).click()
  await page.getByRole('menuitem', { name: '删除会话' }).click()
  const deleteDialog = page.getByRole('alertdialog', { name: '删除 Chat 对话？' })
  await expect(deleteDialog).toBeVisible()
  await expect(deleteDialog.getByText('接入动态模型目录', { exact: true })).toBeVisible()
  await deleteDialog.getByRole('button', { name: '取消' }).click()
  await expect(chatRow).toBeVisible()

  await chatRow.hover()
  await sidebar.getByRole('button', { name: '管理会话：接入动态模型目录' }).click()
  await page.getByRole('menuitem', { name: '删除会话' }).click()
  await page.getByRole('alertdialog', { name: '删除 Chat 对话？' }).getByRole('button', { name: '删除会话' }).click()
  await expect(chatRow).toHaveCount(0)
  await expectNoHorizontalOverflow(page)
})

test('workspace opener menu detects local targets without exposing paths or blue focus rings', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')

  const composerBefore = await page.locator('.composer').boundingBox()
  await page.getByRole('button', { name: '选择工作区' }).click()
  await expect(page.locator('.workspace-name')).toHaveText('OneKeyElectron')

  const trigger = page.getByRole('button', { name: '选择打开位置' })
  await trigger.click()
  const menu = page.getByRole('menu', { name: '打开位置' })
  await expect(menu).toBeVisible()
  await expect(menu.getByText('VS Code', { exact: true })).toBeVisible()
  await expect(menu.getByText('Visual Studio', { exact: true })).toBeVisible()
  await expect(menu.getByText('Cursor', { exact: true })).toBeVisible()
  await expect(menu.getByText('GitHub Desktop', { exact: true })).toBeVisible()
  await expect(menu.getByText('文件资源管理器', { exact: true })).toBeVisible()
  await expect(menu.getByText('Windows Terminal', { exact: true })).toBeVisible()
  await expect(menu.getByText('WSL', { exact: true })).toBeVisible()
  await expect(menu.getByText('PyCharm', { exact: true })).toBeVisible()

  const menuText = await menu.innerText()
  expect(menuText).not.toContain('preview-workspace')
  expect(menuText).not.toMatch(/[A-Z]:\\/u)
  expect(menuText).not.toContain('ws_')

  const geometry = await menu.boundingBox()
  expect(geometry).not.toBeNull()
  expect(geometry!.x).toBeGreaterThanOrEqual(0)
  expect(geometry!.x + geometry!.width).toBeLessThanOrEqual(1440)
  const composerAfter = await page.locator('.composer').boundingBox()
  expect(composerAfter).toEqual(composerBefore)

  const focusStyle = await trigger.evaluate((element) => {
    element.focus()
    const style = getComputedStyle(element)
    const control = getComputedStyle(element.parentElement!)
    return `${style.outlineColor} ${style.boxShadow} ${control.borderColor} ${control.boxShadow}`
  })
  expect(focusStyle).not.toContain('31, 111, 235')
  expect(focusStyle).not.toContain('127, 199, 255')

  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(trigger).toBeFocused()

  await trigger.press('ArrowDown')
  await expect(page.getByRole('menu', { name: '打开位置' })).toBeVisible()
  const focusedOpener = page.locator('.workspace-opener-item').filter({ hasText: 'VS Code' })
  await expect(focusedOpener).toBeFocused()
  const openerFocusStyle = await focusedOpener.evaluate((element) => {
    const style = getComputedStyle(element)
    return `${style.outlineColor} ${style.borderColor} ${style.boxShadow}`
  })
  expect(openerFocusStyle).toContain('rgba(255, 255, 255, 0.4)')
  expect(openerFocusStyle).not.toContain('31, 111, 235')
  expect(openerFocusStyle).not.toContain('127, 199, 255')
  await focusedOpener.click()
  await expect(page.getByText('浏览器预览不会启动 VS Code。', { exact: true })).toBeVisible()
})

test('workspace opener settings expose only verified options and the no-default button has menu semantics', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')

  await page.locator('.sidebar-full').getByRole('button', { name: '设置', exact: true }).click()
  const openerSelect = page.getByRole('combobox', { name: '默认文件打开目标' })
  await expect(openerSelect.locator('option')).toHaveText([
    '每次显示菜单',
    'VS Code（尚未检测）',
  ])
  await expect(openerSelect.locator('option[value="vscode"]')).toHaveAttribute('disabled', '')
  await openerSelect.selectOption('none')

  await page.getByRole('button', { name: '返回应用' }).click()
  await page.getByRole('button', { name: '选择工作区' }).click()
  const primary = page.locator('.workspace-launcher-main')
  await expect(primary).toHaveAttribute('aria-label', '打开位置菜单')
  await expect(primary).toHaveAttribute('aria-haspopup', 'menu')
  await expect(primary).toHaveAttribute('aria-expanded', 'false')

  await primary.click()
  await expect(page.getByRole('menu', { name: '打开位置' })).toBeVisible()
  await expect(primary).toHaveAttribute('aria-expanded', 'true')
})

test('workspace opener primary action is single-flight and refreshes one-time launch authorization', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await page.getByRole('button', { name: '选择工作区' }).click()

  await page.evaluate(() => {
    const state = {
      listCalls: 0,
      openCalls: 0,
      listWorkspaceMatched: false,
      openWorkspaceMatched: false,
      launchAuthorizationMatched: false,
    }
    ;(window as any).__openerTest = state
    Object.defineProperty(window, 'onekey', {
      configurable: true,
      value: {
        workspace: {
          listOpeners: (input: { workspaceToken: string }) => {
            state.listCalls += 1
            state.listWorkspaceMatched = input.workspaceToken === 'preview-workspace'
            return new Promise((resolve) => window.setTimeout(() => resolve({
              ok: true,
              value: {
                openers: [{ id: 'vscode', label: 'VS Code', kind: 'editor' }],
                launchToken: 'fixture',
              },
            }), 250))
          },
          open: (input: { workspaceToken: string; launchToken: string }) => {
            state.openCalls += 1
            state.openWorkspaceMatched = input.workspaceToken === 'preview-workspace'
            state.launchAuthorizationMatched = input.launchToken === 'fixture'
            return new Promise((resolve) => window.setTimeout(() => resolve({
              ok: true,
              value: { openerId: 'vscode' },
            }), 250))
          },
        },
      },
    })
  })

  const primary = page.locator('.workspace-launcher-main')
  await primary.evaluate((element) => {
    element.click()
    element.click()
  })
  await expect(primary).toBeDisabled()
  await expect(primary).toHaveAttribute('aria-label', '正在检测本机打开方式')
  await expect(primary).toContainText('正在检测')
  await expect(primary).toHaveAttribute('aria-label', '正在使用 VS Code 打开当前工作区')
  await expect(primary).toContainText('正在打开')
  await expect(primary).toBeEnabled()

  await expect.poll(() => page.evaluate(() => ({ ...(window as any).__openerTest }))).toEqual({
    listCalls: 1,
    openCalls: 1,
    listWorkspaceMatched: true,
    openWorkspaceMatched: true,
    launchAuthorizationMatched: true,
  })

  await primary.click()
  await expect(primary).toBeEnabled()
  await expect.poll(() => page.evaluate(() => ({ ...(window as any).__openerTest }))).toEqual({
    listCalls: 2,
    openCalls: 2,
    listWorkspaceMatched: true,
    openWorkspaceMatched: true,
    launchAuthorizationMatched: true,
  })
})

test('workspace opener menu preserves actionable Main errors over empty-state copy', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await page.getByRole('button', { name: '选择工作区' }).click()
  await page.evaluate(() => {
    Object.defineProperty(window, 'onekey', {
      configurable: true,
      value: {
        workspace: {
          listOpeners: async () => ({
            ok: false,
            error: { code: 'workspace_opener_detection_failed', message: '本机应用检测失败，请重新展开菜单重试。' },
          }),
        },
      },
    })
  })

  await page.getByRole('button', { name: '选择打开位置' }).click()
  const menu = page.getByRole('menu', { name: '打开位置' })
  await expect(menu).toBeVisible()
  await expect(menu.getByText('本机应用检测失败，请重新展开菜单重试。', { exact: true })).toBeVisible()
  await expect(menu.getByText('没有检测到可用的本机打开方式。', { exact: true })).toHaveCount(0)
})

test('unavailable default opener copy fits in the settings select', async ({ page }) => {
  await page.setViewportSize({ width: 940, height: 700 })
  await page.goto('/')
  await page.getByRole('button', { name: '选择工作区' }).click()
  await page.evaluate(() => {
    Object.defineProperty(window, 'onekey', {
      configurable: true,
      value: {
        workspace: {
          listOpeners: async () => ({
            ok: true,
            value: {
              openers: [{ id: 'cursor', label: 'Cursor', kind: 'editor' }],
              launchToken: 'fixture',
            },
          }),
        },
      },
    })
  })

  await page.getByRole('button', { name: '选择打开位置' }).click()
  await expect(page.getByRole('menu', { name: '打开位置' }).getByText('Cursor', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.locator('.sidebar-rail').getByRole('button', { name: '设置', exact: true }).click()

  const openerSelect = page.getByRole('combobox', { name: '默认文件打开目标' })
  await expect(openerSelect).toHaveValue('vscode')
  await expect(openerSelect.locator('option[value="vscode"]')).toHaveText('VS Code（当前不可用）')
  await expect(openerSelect.locator('option[value="vscode"]')).toHaveAttribute('disabled', '')
  const textFit = await openerSelect.evaluate((element) => {
    const context = document.createElement('canvas').getContext('2d')!
    context.font = getComputedStyle(element).font
    return {
      available: element.clientWidth,
      required: context.measureText(element.selectedOptions[0]?.textContent ?? '').width,
    }
  })
  expect(textFit.available).toBeGreaterThan(textFit.required)
  await expectNoHorizontalOverflow(page)
})

test('1120 context drawer opens and closes without moving the composer', async ({ page }) => {
  await page.setViewportSize({ width: 1120, height: 760 })
  await page.goto('/')
  const composerBefore = await page.locator('.composer').boundingBox()
  await expect(page.locator('.context-inspector')).not.toHaveClass(/is-open/)
  await page.getByRole('button', { name: '环境信息', exact: true }).click()
  await expect(page.locator('.context-inspector')).toHaveClass(/is-open/)
  await expect(page.locator('.drawer-scrim')).toHaveClass(/visible/)
  await expect(page.getByText('本轮快照', { exact: true })).toHaveCount(0)
  await expect(page.locator('.composer')).toBeVisible()
  const composerAfter = await page.locator('.composer').boundingBox()
  expect(composerBefore).not.toBeNull()
  expect(composerAfter).not.toBeNull()
  expect(composerAfter!.x).toBeCloseTo(composerBefore!.x, 1)
  expect(composerAfter!.y).toBeCloseTo(composerBefore!.y, 1)
  expect(composerAfter!.width).toBeCloseTo(composerBefore!.width, 1)
  await expect.poll(async () => {
    const box = await page.locator('.context-inspector').boundingBox()
    return box ? box.x + box.width : Number.POSITIVE_INFINITY
  }).toBeLessThanOrEqual(1120)
  const inspectorBox = await page.locator('.context-inspector').boundingBox()
  expect(inspectorBox).not.toBeNull()
  expect(inspectorBox!.x).toBeGreaterThanOrEqual(0)
  expect(inspectorBox!.x + inspectorBox!.width).toBeLessThanOrEqual(1120)
  await page.keyboard.press('Escape')
  await expect(page.locator('.context-inspector')).not.toHaveClass(/is-open/)
  await expectNoHorizontalOverflow(page)
})

test('940 workspace opener stays compact and inside the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 940, height: 760 })
  await page.goto('/')

  const composerBefore = await page.locator('.composer').boundingBox()
  const main = page.getByRole('button', { name: '选择工作区' })
  await main.click()
  await expect(page.locator('.workspace-launcher-main span')).toBeHidden()
  await page.getByRole('button', { name: '选择打开位置' }).click()
  const menu = page.getByRole('menu', { name: '打开位置' })
  await expect(menu).toBeVisible()
  const menuBox = await menu.boundingBox()
  expect(menuBox).not.toBeNull()
  expect(menuBox!.x).toBeGreaterThanOrEqual(0)
  expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(940)
  expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(760)
  expect(await page.locator('.workspace-opener-menu').evaluate((element) => element.scrollHeight <= element.clientHeight)).toBe(true)
  expect(await page.locator('.composer').boundingBox()).toEqual(composerBefore)
})

test('940 workspace uses a rail and mutually exclusive task drawer', async ({ page }) => {
  await page.setViewportSize({ width: 940, height: 760 })
  await page.goto('/')
  await expect(page.locator('.sidebar-rail')).toBeVisible()
  await expect(page.locator('.sidebar-full')).toBeHidden()
  await page.locator('.sidebar-rail').getByRole('button', { name: '打开任务' }).last().click()
  await expect(page.locator('.task-drawer')).toHaveClass(/is-open/)
  await page.getByRole('button', { name: '关闭任务面板' }).click()
  await expect(page.locator('.task-drawer')).not.toHaveClass(/is-open/)
  await expect(page.locator('.composer')).toBeVisible()

  const compactGeometry = await page.evaluate(() => {
    const conversation = document.querySelector<HTMLElement>('.conversation-pane')!
    const menubar = document.querySelector<HTMLElement>('.app-menu-bar')!
    const controls = document.querySelector<HTMLElement>('.window-controls')!
    const conversationStyle = getComputedStyle(conversation)
    const menuRect = menubar.getBoundingClientRect()
    const controlsRect = controls.getBoundingClientRect()
    return {
      radius: Number.parseFloat(conversationStyle.borderTopLeftRadius),
      menuRight: menuRect.right,
      controlsLeft: controlsRect.left,
    }
  })
  expect(compactGeometry.radius).toBeGreaterThanOrEqual(14)
  expect(compactGeometry.menuRight).toBeLessThanOrEqual(compactGeometry.controlsLeft)
  await expectNoHorizontalOverflow(page)
})
