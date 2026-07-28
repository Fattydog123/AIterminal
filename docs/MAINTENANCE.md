# AI-terminal Maintenance Guide

Use this file to avoid rediscovering the project on every task.

## Start Here

1. The only product directory is `C:\Users\zz182\Desktop\AI-terminal-main`.
2. Read `docs/PROJECT_CONTEXT.md` for product contracts and boundaries.
3. Read only the task row below, then the named files. Do not scan the whole
   repository unless the focused path cannot explain the failure.
4. The directory has no `.git`; do not use another checkout or an old Studio as
   the source of truth.

## Focused Read Paths

| Problem | First files | Focused tests |
| --- | --- | --- |
| Account, groups, tokens | `src/main/services/relay-service.ts`, `src/main/services/relay-dto-adapter.ts` | `tests/relay/relay-service.test.ts` |
| Chat/Agent group and model selection | `src/main/services/model-catalog.ts`, `src/main/services/relay-model-catalog.ts`, `src/renderer/src/model-selection/model-selection.ts` | `tests/services/model-catalog.test.ts`, `tests/services/relay-mode-groups.test.ts` |
| Chat/Agent history, streaming, cancellation, approvals | `src/renderer/src/conversation/conversation-session.ts`, `conversation-session-adapter.ts`, `use-conversation-session.ts` | `tests/runtime/conversation-session.test.ts` |
| Composer draft, attachments, capabilities, submission | `src/renderer/src/composer/composer-capabilities.ts`, `composer-capabilities-adapter.ts`, `use-composer-capabilities.ts` | `tests/runtime/composer-capabilities.test.ts` |
| Chat/Agent launch and Main admission | `src/renderer/src/App.tsx` (`prepareComposerLaunch`, `startTurn`), `src/renderer/src/conversation/conversation-session.ts`, `src/main/services/turn-admission-service.ts` | `tests/runtime/conversation-session.test.ts`, `tests/services/turn-admission-service.test.ts` |
| Protocol or stream errors | `src/main/services/turn-admission-service.ts`, `src/main/ipc/register-ipc.ts`, the selected protocol client, `src/main/services/agent-turn-service.ts` | `tests/services/turn-admission-service.test.ts`, `tests/services/agent-turn-service.test.ts`, the matching client test |
| Agent protocol continuation | `src/main/services/agent-protocol-session.ts`, the selected protocol client, `src/main/services/agent-turn-service.ts` | `tests/services/agent-turn-service.test.ts`, matching protocol client tests |
| Agent local tools and workspace/system scope | `src/renderer/src/App.tsx` (`WorkspaceOpenControl`, `selectWorkspace`, permission selector), `src/main/ipc/register-ipc.ts` (workspace selection), `src/main/services/agent-approval-service.ts`, `src/main/services/workspace-tool-broker.ts`, `src/main/services/workspace-tool-service.ts`, `src/main/services/workspace-pattern-matching.ts` (bounded regex/glob engines, default ignored directories) | `tests/services/agent-turn-service.test.ts`, `tests/security/agent-approval-service.test.ts`, `tests/services/workspace-tool-service.test.ts`, `tests/services/workspace-tool-broker.test.ts`, `tests/services/workspace-pattern-matching.test.ts` |
| Agent automatic workspace and task binding | `src/main/services/agent-workspace-session-service.ts`, `src/main/ipc/register-ipc.ts`, `src/renderer/src/App.tsx` (`provisionWorkspace`, restore/remember effects) | `tests/services/agent-workspace-session-service.test.ts`, `tests/runtime/conversation-session.test.ts` |
| Codex history and workspace history bridge | `src/main/services/codex-app-server-history-service.ts`, `conversation-workspace-export-service.ts`, `src/main/ipc/register-ipc.ts` | `tests/services/codex-app-server-history-service.test.ts`, `conversation-workspace-export-service.test.ts` |
| Claude, Gemini, and Grok history | `src/main/services/external-provider-history-service.ts`, `src/main/services/backend-services.ts`, `src/main/ipc/register-ipc.ts`, `src/renderer/src/conversation/conversation-session.ts` | `tests/services/external-provider-history-service.test.ts`, `tests/runtime/conversation-session.test.ts` |
| Local subagent routing and UI lifecycle | `src/main/services/agent-turn-service.ts`, `agent-protocol-session.ts`, `src/renderer/src/conversation/conversation-session.ts`, `src/renderer/src/App.tsx` | `tests/services/agent-turn-service.test.ts`, `tests/security/agent-event-validator.test.ts`, `tests/runtime/conversation-session.test.ts` |
| Agent checkpoints and delegated worktrees | `src/main/services/workspace-change-session.ts`, `src/main/ipc/register-ipc.ts`, `src/renderer/src/conversation/` | `tests/services/workspace-change-session.test.ts`, `tests/services/agent-task-graph.test.ts` |
| Detached Agent work | `src/main/services/background-task-manager.ts`, `src/main/ipc/register-ipc.ts`, `src/renderer/src/background-tasks/` | `tests/services/background-task-manager.test.ts`, `tests/runtime/conversation-session.test.ts` |
| Agent skills, plugins, and MCP | `src/main/services/extension-host.ts`, `mcp-client.ts`, `agent-turn-service.ts` | `tests/services/extension-host.test.ts`, `tests/services/mcp-client.test.ts`, `tests/services/agent-turn-service.test.ts` |
| Shared layout, focus mode, command center, task center | `src/renderer/src/ui/use-workspace-layout.ts`, `GlobalCommandCenter.tsx`, `ActivityCenter.tsx`, `ui-shell.css`, `src/renderer/src/App.tsx` | `tests/runtime/workspace-layout.test.ts`, `npm run typecheck` |
| Workspace files and Git review | `src/renderer/src/change-review/`, `src/main/services/workspace-environment-service.ts`, `src/preload/index.ts`, `src/shared/contracts.ts` | `tests/runtime/change-review.test.ts`, `tests/runtime/workspace-review-contract.test.ts` |
| Studio Copilot plans | `src/main/studio/studio-copilot-service.ts`, `src/main/studio/ipc.ts`, `src/renderer/src/studio/renderer/workflow/WorkflowPage.tsx`, `session/studio-copilot-operations.ts` | `tests/services/studio-copilot-service.test.ts`, `tests/runtime/studio-copilot-operations.test.ts`, `npm run test:studio-ipc` |
| Studio groups and Images | `src/main/studio/account-providers.ts`, `src/main/studio/network.ts` | `tests/services/studio-account-provider.test.ts`, `tests/services/images-client.test.ts` |
| Studio layout and selectors | `src/renderer/src/studio/StudioWorkspace.tsx`, `src/renderer/src/studio/renderer/workflow/WorkflowPage.tsx`, `src/renderer/src/studio/renderer/components/StudioSelect.tsx`, `src/renderer/src/studio/renderer/ai-terminal-theme.css`, `src/renderer/src/styles.css`, `src/main/window.ts` | `tests/e2e/workspace.spec.ts`, `tests/e2e/auth-gate.spec.ts` |
| Renderer CSS ownership | `src/renderer/src/styles/tokens.css`, `reset.css`, `shell.css`, `src/renderer/src/styles.css`, `codex-monitor-theme.css`, Studio `renderer/visual-tokens.css`, `renderer/styles.css`, `renderer/ai-terminal-theme.css` | `npm run typecheck`; focused layout check against the existing instance when available |
| Studio Workflow edit, history, projection, readiness | `src/renderer/src/studio/renderer/session/workflow-editor-session.ts`, `src/studio/core/editor.ts`, `studioReadiness.ts`, `store/studioStore.ts` | `tests/runtime/workflow-editor-session.test.ts`, `npm run test:studio-workflow` |
| Studio Workflow save, draft, and rebase | `src/renderer/src/studio/renderer/session/workflow-document-session.ts`, `workflow-document-projection.ts`, `workflow-store-coordinator.ts` | `tests/runtime/workflow-document-session.test.ts`, `workflow-document-projection.test.ts`, `workflow-store-coordinator.test.ts` |
| Studio run lifecycle and Matrix confirmation | `src/renderer/src/studio/renderer/session/StudioSession.ts`, `store/studioStore.ts` | `tests/runtime/studio-run-session.test.ts`, `prompt-matrix-session.test.ts` |
| Studio IPC operation contract | `src/studio/shared/ipc-channels.ts`, `src/preload/studio-bridge.ts`, `src/main/studio/ipc.ts`, `src/studio/shared/contracts.ts` | `npm run test:studio-ipc` |
| Studio project persistence | `src/main/studio/projects.ts`, `project-persistence.ts`, `workflow-repository.ts`, `asset-catalog-repository.ts`, `run-journal-repository.ts`, `project-configuration-repository.ts` | `npm run test:project-store` |
| Reasoning strengths | `src/main/services/model-catalog.ts`, `src/main/services/reasoning-protocol.ts`, protocol clients | `tests/services/model-catalog.test.ts`, protocol client tests |

## Shared Renderer UI Ownership

- Keep `styles/tokens.css` as the only Chat/Agent semantic token owner.
  `ui/ui-shell.css` may compose materials and geometry but must consume those
  roles. Studio's `visual-tokens.css` maps inherited host values to
  `--studio-*`; do not copy Chat/Agent hex values into a parallel Studio theme.
- Layout persistence belongs to `use-workspace-layout.ts`. New resizable panes
  must use its clamped actions and expose both pointer and keyboard separator
  controls. Do not add pane widths to `App.tsx`, Studio Store, or feature-local
  storage.
- The root shell owns global keyboard shortcuts, command composition, and the
  aggregate activity surface. Feature modules contribute typed command items
  or bounded activity snapshots; they do not register a competing global
  overlay.
- Workspace browsing stays behind `RendererApi.workspace` and opaque workspace
  tokens. Add a shared contract, preload method, Main handler, and focused
  contract test together. Never pass an absolute workspace path to the
  Renderer to simplify a file tree.
- Canvas alignment and layout remain Workflow Editor commands. Store actions
  may project selection into command IDs, but must not write node positions
  directly or create a second undo history.

## Previously Accepted Live Baseline

The 2026-07-21 baseline was checked against the signed-in remote account in
the existing development instance before the current reasoning-registry and
Studio-style changes. It is the reference point for focused retests, not
current acceptance evidence; it does not turn fixture or smoke output into
live evidence.

- Chat completed through `高速Codex Pro / gpt-5.5` and returned
  `CHAT_CURRENT_OK`.
- Agent completed a native `write_file` -> `read_file` turn and returned
  `AGENT_CURRENT_OK` with `LIVE_AGENT_CURRENT_OK` read back. The same path
  created and browser-verified
  `C:\Users\zz182\Desktop\2\agent-calculator.html` (multiplication,
  backspace, percent, sign toggle, and divide-by-zero behavior).
- Studio completed the selected `生图` / `gpt-image-2-2k` Images route through
  `/v1/images/generations`. The formal workflow sent one remote task, produced
  one 1,254 x 1,254 asset, and wrote the PNG under
  `C:\Users\zz182\Desktop\2\Studio-Live-131437\outputs`.
- Studio responsive checks used 1,440, 1,280, and 940 pixel widths. The shared
  rail measured 260px at the two wide sizes and 52px at 940px, starting at
  y=42; the compact run bar order is group -> model -> Run.
- The Images fallback is confirmed-only: a stale or opaque model is probed
  only for the exact selected group/model, and the minimum confirmation request
  is `{ model, prompt, count }`. A complete parsed image is required before
  caching the capability; edit operations remain disabled without an explicit
  input-image capability.

Do not rerun the broad security, E2E, or Electron suites as part of ordinary
online diagnosis. The live baseline above was obtained with focused checks;
repeat only the path that changed or failed.

## Current Retest Status

- The 2026-07-23 live UI retest completed an Agent task through
  `高速Codex Pro / gpt-5.5 / High`. The UI automatically provisioned a
  projectless Codex workspace, displayed System Full Access, and rendered
  the complete execution track: request, analysis, parallel dispatch, two
  read-only child tracks, a UTF-8 Python command, response generation, and one
  terminal completion. No approval modal or horizontal overflow appeared.
- The same task produced the bound task transcript and root history index with
  `work` and `outputs` directories. The fixed command marker was present, with
  no detected credential, absolute path, or temporary history file.
- `99%缓存kiro Claude Code` was retested with `claude-fable-5` and
  `claude-opus-4-6`. Its server catalog declares Anthropic first and OpenAI
  second; both declared routes were attempted and the service returned endpoint
  authorization before model output. Keep this classified as a remote
  token/channel configuration issue, not a Chat-protocol fallback bug.
- A later real `高速Codex Pro / gpt-5.6-sol / Ultra` Agent turn exposed
  delegation automatically, ran two independent read-only child tasks to one
  terminal state each, returned `SUBAGENT_ULTRA_OK`, and emitted no ordinary
  approval prompt in full-access mode. The current catalog declares `openai`,
  tool use, and strengths through `ultra` for this model.
- Grok history completed a real Chat continuation, automatically became a
  local writable copy, and passed rename plus archive/restore. Gemini history
  imported as an Agent copy into a restorable automatic workspace and passed
  the same writable operations. Provider-owned rows remained read-only.
- A newly created real token added the ninth token-backed group. The desktop
  now detects token metadata changes on foreground return and through a
  ten-second lightweight poll, then runs one serialized full catalog refresh.
  Two live poll cycles retained all eight conversation-capable groups and the
  selected `Gemini cil / gemini-3.6-flash-high` route.
- The current Gemini catalog declares native `gemini` before `openai` and tool
  use. Real Chat returned `GEMINI_CHAT_LIVE_OK`; real full-access Agent
  completed `write_file` plus `read_file`, returned `GEMINI_AGENT_LIVE_OK`, and
  the workspace file independently matched `GEMINI_AGENT_FILE_OK`. Typecheck
  passed; fixture output is not the acceptance result.
- The current signed-in `grok / grok-4.5` catalog uniquely identifies xAI and
  declares both OpenAI transports. A real Agent function call plus Responses
  continuation completed through `/v1/responses`, while a separate real Chat
  request completed through `/v1/chat/completions`; every request returned
  HTTP 200.
- A live System Full Access repro showed that persistence redaction, not the
  Broker sandbox, had removed the current absolute target before sampling.
  Agent now sends the credential-redacted current prompt from Main memory in
  `full` while retaining path-redacted history. The post-fix Grok turn created
  and read the exact file outside its automatic workspace with two completed
  tools, no failed tool, and no approval event.

- The 2026-07-23 Codex compatibility pass is accepted. New Agent tasks can
  provision and restore a dated Documents/Codex workspace; Python Chinese
  stdout completes as UTF-8; and an online turn completed two parallel
  read-only subagents plus a real command with no prompt in `full` mode.
- The official Codex app-server exposed 13 active and 3 archived tasks. A real
  481-message thread loaded read-only in 2.2 seconds. The incoming JSONL
  response-line bound is 16 MiB, but the public projection remains capped at
  2,000 messages, 256 KiB per message, and 2 MiB total.
- `AI-TERMINAL-HISTORY-<task-uuid>.md` is the supported per-task reverse bridge,
  and the root `AI-TERMINAL-HISTORY.md` is its bounded index. Both are written
  atomically inside the bound Agent workspace; user persistence triggers an
  immediate sync and assistant persistence refreshes it. They contain only
  redacted visible user/assistant messages. Do not directly mutate Codex
  SQLite, rollout JSONL, or session indexes.
- The final `npm test` and `npm run typecheck` passed. Evidence includes
  `output/playwright/codex-auto-workspace-agent.png` and
  `output/playwright/codex-history-large-loaded.png`. No installer was built.

- The reasoning registry, Codex-compatible `ultra` to OpenAI-compatible `max`
  projection, IPC effort validation, and flatter Chat-like Studio CSS are
  implemented. Typecheck, 96/96 reasoning-focused tests, and 17/17 Studio
  account-provider tests passed.
- Chat completed a fresh signed-in remote request. Agent used
  `C:\Users\zz182\Desktop\2` for the calculator task, which the user confirmed
  succeeded.
- Studio directly restored provider discovery and completed `生图 / gpt-image-2-2k`
  workflow `studio-live-616755a0-b402-43e9-a70c-da1c1ff1698a`, run
  `b666a6f0-422d-45a9-aa34-d170918105a6`, with dispatch `sent` and final status
  `succeeded`. Its 1,254 x 1,254 PNG is under
  `C:\Users\zz182\Desktop\2\Studio-Live-185612\outputs`.
- The final Studio canvas-first and selector pass is accepted: wide, compact,
  and short-height checks covered 1,442 x 816 through 538 x 400, including
  overlay drawers, Linear View, the command palette, and dark Renderer-owned
  group/model listboxes. Exact measurements are recorded in
  `docs/PROJECT_CONTEXT.md`; `npm run typecheck` passed on the final code.
- Renderer CSS now has one token owner per DOM boundary. The light DOM imports
  `tokens -> reset -> shell -> feature` before its native adapter; Studio
  injects `visual-tokens -> reset/feature -> native adapter` into the Shadow
  root. The focused CSS parser, Vite transform, and typecheck pass.
  The existing 5173 preview was rendered at 1,440 x 900, 538 x 400, and the
  832 x 560 layout equivalent of 125% zoom in a 1,040 x 700 window. Document,
  Shadow host, shell, toolbar, and canvas overflow stayed at zero; the compact
  Renderer-owned group listbox stayed dark with no white descendants. Current
  evidence is stored as `output/playwright/architecture-studio-*.png`.
- The architecture ownership closeout passed after the final live UI check.
  Renderer turn launch now delegates every admission rule to Main; Studio has
  no Store -> Workflow Editor subscription; and the Agent loop contains no
  duplicate Workspace Tool Broker implementation. Focused results were
  Conversation 15/15, Turn Admission 15/15, Agent 66/66, Workflow 77/77, and
  Project Store 12/12, followed by a clean typecheck. A cold Studio preview at
  832 x 560 retained a 780 x 396 canvas with zero overflow and zero console
  warnings/errors (`architecture-studio-final.png`).

## Product Invariants

### Gemini Group Refresh (Completed 2026-07-25)

- `Gemini cil` is the real server's exact group id. Treat every group id as an
  opaque value; do not lowercase, translate, or replace it with a provider
  alias.
- A burst of duplicate account and catalog calls can produce HTTP 429 and make
  a valid group look absent. Keep Relay metadata single-flight/cache/cooldown
  behavior and the Renderer failed-catalog retry path when changing account
  refresh logic.
- Live acceptance attached to the one existing Electron instance and observed
  seven visible groups, `Gemini cil` exactly once, and three models after its
  asynchronous catalog completed. Both Chat and Agent exposed native Gemini,
  and the prior real Chat/Agent/file markers remained valid before cleanup.
- Focused checks passed Relay 43/43, catalog/mode-group 11/11, and typecheck.
  The four temporary acceptance tasks were deleted; no installer was built.

- Chat and Agent list only groups with a declared conversation endpoint.
- A transient selected-group catalog failure keeps that group selected and does
  not probe a fallback. Only a successful empty mode catalog can trigger an
  automatic move to another eligible group.
- Studio lists only token-backed groups with a declared `image-generation`
  model or an exact model whose explicit billable Images confirmation returned
  a complete image. Image model names never select the Images protocol, and a
  failed confirmation is never cached.
- Renderer never receives a real token.
- A usable remote reasoning declaration always wins. Native Anthropic/Gemini
  declarations require their matching protocol. When remote projection is
  absent, only an exact trusted vendor/model profile compatible with the
  already selected endpoint may add strengths; otherwise the model exposes
  only `auto`.
- OpenAI's current effort vocabulary is `none`, `minimal`, `low`, `medium`,
  `high`, `xhigh`, and `max`. Product preset `ultra` serializes as `max` only
  for OpenAI-compatible Responses/Chat; native Anthropic/Gemini never receive
  the literal string `ultra`. An explicitly declared budget protocol may map
  that preset to its bounded numeric budget.
- Multi-endpoint Agent candidates own their matching native reasoning protocol;
  the preferred Chat projection does not erase a later Anthropic/Gemini
  declaration. Gemini 2.5 exact fallback profiles use `thinkingBudget`, never
  `thinkingLevel`; xAI effort profiles expose only documented effort lists.
- Studio reference-image ports are graph contracts. Generation nodes use
  `/images/generations`; an actual image edit uses `/images/edits`.
- Studio keeps the shared left rail aligned with Chat and Agent: 260px at
  1,440/1,280 widths and 52px at 940px, beginning at y=42 and extending to
  the bottom. The compact run bar is ordered group -> model -> Run; the model
  label remains the full server-provided name.
- Agent `auto` runs bounded workspace reads and asks for workspace writes or
  commands. `full` maps to System Full Access: local tools may use absolute or
  parent paths and system commands without ordinary prompts; the selected
  workspace remains the default cwd and task binding rather than a boundary.
- System-scope Broker and subagent results retain absolute paths only inside
  Main so the model can chain later operations. Renderer events, conversation
  persistence, history exports, and public diagnostics still use full local-
  path and credential redaction.
- In `full`, the current prompt is also a Main-memory input: redact credentials
  but preserve its absolute paths for the admitted model. Never rebuild that
  current prompt from the path-redacted persisted copy; prior history remains
  redacted.
- A new Agent task with no selected workspace provisions
  `Documents\Codex\<date>\<prompt-slug>` with `work` and `outputs`. Main owns
  the canonical path, stores the task binding in encrypted storage, and issues
  a fresh opaque workspace token when that task is reopened. Manual selection
  is an explicit override; a projectless task never inherits an unrelated
  task's scope.
- `delegate_tasks` is depth-one and protocol-neutral. Agent Main admission
  automatically exposes it for a confirmed compatible model; the model
  chooses whether to call it, so users do not need a parallel-subagent switch.
  One to three read-only subagents inherit the already confirmed Responses,
  Chat Completions, Anthropic, or Gemini route and reasoning settings, expose
  only bounded list/search/read tools, and cannot delegate again. Chat and
  `/review` remain isolated. Each subagent publishes one queued -> running ->
  terminal lifecycle to the execution track; do not mirror it as a second
  synthetic tool row.
 - Codex rows are read through the official `codex app-server` `thread/list`
  and `thread/read` APIs and remain read-only at the source boundary. Sending
  from a Codex row automatically imports its bounded transcript into a local
  encrypted task, then continues the turn against that writable task. Keep the
  source reference and idempotent import behavior; Main still rejects
  destructive mutations against the official row. Never edit Codex SQLite,
  rollout JSONL, or session indexes.
 - External Claude, Gemini, and Grok rows follow the same source boundary:
  sending imports the bounded visible transcript according to the current
  Chat or Agent mode. Chat imports skip workspace resolution; Agent imports
  retain the selected workspace binding. The local copy is writable, while
  provider-owned JSONL remains untouched.
 - The AI-terminal-to-Codex bridge owns one atomic
  `AI-TERMINAL-HISTORY-<task-uuid>.md` transcript per Agent task and one atomic
  `AI-TERMINAL-HISTORY.md` root index per workspace. Sync after the persisted
  user message and again after the assistant message; task failures still leave
  the user request visible, and two tasks in one workspace must never overwrite
  each other. Keep the existing message/count/byte bounds, redaction, ordinary-
  file and canonical-root checks, and best-effort turn semantics.
- Turn admission is a single Main module. It accepts only a fixed confirmed
  catalog snapshot, rechecks that snapshot after credentials, endpoint consent,
  and attachment preparation, and consumes a review grant only after those
  earlier stages succeed. IPC must delegate pending-start cancellation and
  shutdown cleanup to the same module. Renderer may prepare mode/workspace and
  project a request, but must not duplicate any admission rejection.
- The Workflow Document Session owns the canonical Studio document and formal
  baseline. ID-keyed independent rebase changes merge; only merged structural
  conflicts retain the local edge/interface collection. Dirty status also
  compares the current document with the formal baseline so overlapping A -> B
  -> A saves cannot silently drop rebased content.
- The Workflow Editor owns every canonical Canvas/Linear mutation and the
  bounded undo/redo history through typed commands. Store state is a projection
  and must not regain an arbitrary whole-graph commit path, a second history,
  or a Store -> Editor subscription. Runtime fields cross only the editor's
  explicit projection allowlist.
- `StudioSessionController` owns run-event reduction and first-terminal
  authority. A late `startRun` return, rejection, or cancellation response must
  not overwrite an earlier terminal event.
- Prompt Matrix preflight/confirmation is a frozen session, not a Store replay:
  it retains the prepared workflows, plans, target IDs, overrides, source
  fingerprint, and edit generation. A project or Workflow scope replacement
  must clear both run-session controllers before opening its document. The
  confirmation path must never rebuild overrides from live canvas state.
- `ProjectStore` is the stable persistence facade. `ProjectLayout` owns legacy
  project metadata, managed-directory checks, and layout initialization;
  `MutationCoordinator` owns per-resource serialization; `WorkflowRepository`
  owns Workflow migration, legacy paths, CAS, immutable versions, drafts, and
  archive/restore; `AssetCatalogRepository` owns assets, collections, imports,
  exports, masks, and managed asset paths; `RunJournalRepository` owns tasks,
  the persistent queue, historic runs, and restart recovery;
  `ProjectConfigurationRepository` owns plugin manifests/permissions/version
  locks and parameter preset normalization/import. Keep callers and disk
  formats on the facade interface, and do not reintroduce a second persistence
  implementation there.
- `studioOperationCatalog` is the only handwritten Studio operation/channel/kind
  list. Preload bridge generation and Main registration completeness both
  derive from it; do not add a second channel catalog.

## Verification Tiers

For a reported connection failure, the first verification tier is the real
signed-in account in the already-running Electron application. Once the
requested live path works, run the smallest automated check that reaches the
changed behavior. Fixture, preview, smoke, and simulated results do not replace
the live result.

```powershell
# Fast compile check
npm run typecheck

# Focused example
node --experimental-strip-types --test tests/services/model-catalog.test.ts

# Main-process and service regression suite
npm test

# Renderer behavior and responsive layout (only when explicitly requested)
npm run test:e2e

# Electron wiring and production build (only when explicitly requested)
npm run test:electron
```

Do not rerun the broad security suite, full E2E suite, or complete Electron
matrix during ordinary live diagnosis unless the user explicitly asks for it.
Do not delay restoring a broken real connection to repeat already-passing
broad suites.

Before starting a dev instance, check port `5173` and existing Electron/Node
processes. Do not start a second `npm run dev` instance.

After changing a preload bridge or the Studio IPC operation catalog, restart
the existing Electron development process before manual UI acceptance. Vite can
refresh Renderer modules, but it cannot replace the already-loaded preload
object. Do not mistake a missing method in that stale bridge for a product
regression, and do not launch a parallel instance to work around it.

## Real Account Validation

Read `docs/REAL_ACCOUNT_FIRST.md` before an online check. Real validation is a
separate acceptance tier: fixture tests, E2E, and Electron smoke do not prove
that the signed-in account is connected. Do not rerun the broad security suite
while diagnosing a live connection failure.

Use the already-running Electron instance after checking port `5173`; never
start a duplicate development process. Prefer CDP attachment and narrowly
scoped scripts over controlling the user's mouse or keyboard. Never print
request bodies, tokens, or private account data. Validate in this order:

1. Chat with a conversation-only group.
2. Agent with a conversation endpoint and a harmless workspace command.
3. Studio with an image group and an Images generation node.
4. Confirm an image-only group is absent from Chat and Agent.

Do not test image generation from Agent.

For Codex compatibility or Agent-runtime changes, extend the Agent check with
the following focused live steps without replacing the validation order above:

1. Start a new Agent task without selecting a folder. Confirm one dated
   `Documents\Codex` workspace is created with `work` and `outputs`, then reopen
   the task and confirm the same binding is restored with a fresh opaque token.
2. Use the selected model's real declared protocol to run two harmless parallel
   read-only subagents and one workspace-local UTF-8 command. Confirm each
   subagent advances queued -> running -> one terminal state exactly once and,
   in confirmed `full` mode, no ordinary approval event appears.
3. After the persisted user message and final assistant message, verify the
   task-scoped history file and root index exist, contain only redacted visible
   roles, and leave no temporary file. Reuse one workspace for a second task and
   confirm both indexed transcripts remain independent.
4. Through the official app-server, list active/archived Codex task counts and
   load one large task without printing its text. Confirm sending, compacting,
   renaming, archiving, and deleting remain disabled or rejected and that the
   page stays responsive.

For the current change, the first three steps completed against the real
account: Chat completed a fresh remote request; the user confirmed the Agent
calculator task in `C:\Users\zz182\Desktop\2`; and Studio completed the
`生图 / gpt-image-2-2k` workflow with a parsed 1,254 x 1,254 PNG. The Chat
group/model/effort were not retained and must not be inferred from the older
baseline. Future retests should record the exact selected group/model,
displayed reasoning strengths, selected effort, and endpoint without printing
credentials, request bodies, or image bytes.

The supported startup forms are `npm run dev` for the single development
instance and `electron.exe .` when launching the compiled app. Do not hand a
Windows absolute project path directly to an ESM loader; resolve the command
through the project's scripts or Electron entrypoint.

## Temporary Live-Acceptance Instrumentation

The following entries are temporary diagnostics, not product behavior. The
2026-07-21 focused live retest is complete, so none should remain in a clean
working directory. If any are reintroduced for a later diagnosis, remove them
immediately after the affected path is accepted:

| Location | Temporary item to remove |
| --- | --- |
| `src/main/index.ts` | Development-only CDP port `9222` enablement |
| `src/main/ipc/register-ipc.ts` | Development workspace hard-coded to `C:\Users\zz182\Desktop\2` |
| `src/main/ipc/register-ipc.ts` | Development-only automatic `full` confirmation and `[DEBUG-relay-phase]` logging |
| `src/main/studio/ipc.ts` | Development-only automatic selection of `C:\Users\zz182\Desktop\2` |
| `src/main/services/relay-service.ts` | `[DEBUG-relay-credential]`, `[DEBUG-relay-key-http]`, and `[DEBUG-relay-key-envelope]` logging |
| `src/main/services/agent-turn-service.ts` | `[DEBUG-agent-live]` logging |
| `src/main/services/chat-completions-client.ts` | `[DEBUG-chat-live]` logging |
| `output/playwright/live-electron.mjs` | One-off live Electron driver |
| `output/playwright/bootstrap-debug/csp-repro.js` | One-off CSP reproduction script |
| Project root | One-off `dev-live.stdout.log` and `dev-live.stderr.log` files |

Before declaring the cleanup complete, search `src` and `output` for
`DEBUG-relay`, `DEBUG-agent-live`, `DEBUG-chat-live`,
`remote-debugging-port`, and each temporary hard-coded value. Remove only the
diagnostic code and files; do not undo the product fix that the diagnostics
verified.

Temporary `workspace stage`, `main-link`, and `project-link` directories are
never product sources. Resolve and inspect their absolute paths before deleting
them, and verify that no target is
`C:\Users\zz182\Desktop\AI-terminal-main` or one of its parents. A quarantined
Chromium cache may be removed only after startup is stable. Never delete the
whole `ai-terminal` user-data directory, its `secure` directory, Local Storage,
or account data. Privacy screenshots under the user's Temp directory are not
test artifacts to upload; leave manual deletion to the user.
