# AI-terminal Project Context

This file is the first read for future work on this project. It records stable
product and security decisions, the previously accepted live baseline, and the
current acceptance state, not transient debugging notes.

## Product Authority

- `C:\Users\zz182\Desktop\AI-terminal-main` is the only product repository.
- Studio is part of AI-terminal. Its architecture, UI, IPC, and security rules
  must conform to AI-terminal rather than preserving a separate application.
- Chat, Agent, and Studio use only the authenticated account's remote NewAPI
  service. Do not add local models, local image generation, preview data in the
  real Electron runtime, or fallback fake responses.
- Chat / Agent / Studio switching stays in the upper-left navigation.
- Studio group selection stays beside the Run button.

## Extension, Multi-Agent, And Copilot Acceptance (2026-07-26)

- Agent file-state ownership now lives in `workspace-change-session.ts`: a
  task can checkpoint and rewind its bound workspace, while write-capable
  delegated tasks receive a separate managed worktree that the root task can
  apply or discard. A child never writes into its parent's workspace.
- Detached Agent work is persisted by `background-task-manager.ts` and exposes
  a compact execution journal, cancellation, queued follow-ups, and restart
  recovery. The visible Chat/Agent conversation remains the owner of messages
  and the background entry is only a supervisor record.
- `extension-host.ts` owns slash commands, skills, plugins, workspace MCP
  configuration, hook lifecycles, and MCP tool dispatch. The Agent receives
  only the tools allowed by its confirmed model, access mode, plugin grant,
  and workspace identity. Native OpenAI, Responses, Anthropic, and Gemini
  adapters remain the sole protocol owners.
- `agent-task-graph.ts` implements one-to-five-node DAG delegation, roles,
  shared concurrency/model/tool budgets, depth-two nesting, cancellation, and
  lifecycle events. Model delegation is determined by the confirmed remote
  model contract; it is not a Renderer toggle. `gpt-5.6-sol / ultra` can call
  `delegate_tasks` itself when its declared endpoint permits it.
- Studio Copilot uses a real account-backed conversation model to create a
  validated, previewed Workflow Editor command plan. It cannot alter the
  top-level provider/model route or mutate the Zustand graph directly.
- Focused source verification passed: Agent/MCP/worktree/background `110/110`,
  Studio Copilot/IPC/Workflow Editor `29/29`, and `npm run typecheck`.
- Real signed-in checks against the existing Electron instance completed a
  Gemini Chat turn, Grok Responses Agent file write/read, Gemini native Agent
  file write/read, domestic OpenAI Agent file write/read, and two automatic
  `gpt-5.6-sol / ultra` read-only child tasks. All acceptance conversations
  were removed after completion.
- The long-running development Electron window retains the preload bridge
  loaded when it was launched. After edits to `src/preload/` or Studio IPC
  catalog files, restart that same development process before declaring a UI
  feature accepted; do not start a second instance or infer bridge methods
  from a stale window.

## Shared Workspace UI And Studio Editor V2 (2026-07-26)

- Chat/Agent remain the visual authority. `src/renderer/src/styles/tokens.css`
  owns light-DOM semantic colors and materials; `ui/ui-shell.css` composes the
  workspace shell from those roles. Studio maps the same inherited roles
  through `renderer/visual-tokens.css`; its Shadow DOM must not introduce a
  second product palette.
- `use-workspace-layout.ts` is the sole owner of persisted task-rail,
  environment-rail, and bottom-workbench dimensions plus focus mode. Pointer
  and keyboard resizing share the same clamped setters. Focus mode applies to
  Chat, Agent, and Studio, including Studio's in-shadow activity rail.
- `GlobalCommandCenter.tsx` owns the global command/search presentation and
  keyboard navigation. The root shell owns `Ctrl+K`, command composition, and
  execution; Studio contributes commands through the existing custom-event
  boundary instead of creating another command palette.
- `ActivityCenter.tsx` is the visible aggregate for foreground Chat/Agent,
  detached Agent work, and Studio queue state. Studio publishes a bounded
  status snapshot and remains the owner of its actual run records.
- `ChangeReviewCenter.tsx` owns file browsing and line-level Git review in the
  bottom workbench. Renderer calls only typed preload methods with the opaque
  workspace token. Main `WorkspaceEnvironmentService` owns real directory,
  file, summary, and diff reads; Renderer never receives the workspace's
  absolute path from this feature.
- Studio Workflow Editor V2 keeps canonical mutations in
  `workflow-editor-session.ts`. Multi-selection exposes left/top alignment,
  horizontal/vertical distribution, and selected-only dependency layout from
  a compact canvas toolbar; every operation is one undoable typed command.
  Studio Copilot continues to preview and apply only validated Workflow Editor
  operations.
- Acceptance for this pass: the five focused Diff/directory/layout tests
  passed, Studio Workflow/Copilot/Project Store passed 103/103, and the
  production `npm run build` completed. No Electron instance or installer was
  launched for this source/build acceptance.

## Previously Accepted Live Baseline (2026-07-21)

These results were obtained from the signed-in remote account in the existing
development instance before the current reasoning-registry and Studio-style
changes. They are a starting point for focused retests, not current acceptance
evidence and not a reason to substitute simulated data for a later live check.

- Chat completed through `高速Codex Pro / gpt-5.5` and returned
  `CHAT_CURRENT_OK`.
- Agent completed a native `write_file` followed by `read_file` turn and
  returned `AGENT_CURRENT_OK` with `LIVE_AGENT_CURRENT_OK` read back. The same
  flow created and browser-verified
  `C:\Users\zz182\Desktop\2\agent-calculator.html`.
- Studio completed the selected `生图` / `gpt-image-2-2k` route through
  `/v1/images/generations`; the formal workflow produced one 1,254 x 1,254
  PNG asset under `C:\Users\zz182\Desktop\2\Studio-Live-131437\outputs`.
- Studio layout checks at 1,440, 1,280, and 940 pixel widths measured a shared
  left rail of 260px, 260px, and 52px respectively. Each rail starts at y=42
  and reaches the bottom; the compact run controls stay group -> model -> Run
  and preserve the full model name.
- The broad security, E2E, and Electron suites were not rerun for this live
  baseline. Use the focused path that changed or failed instead.

## Current Change Acceptance (Completed 2026-07-22)

- The reasoning registry, Codex-compatible `Ultra` to OpenAI-compatible `max`
  projection, IPC effort validation, and flatter Chat-like Studio styling are
  implemented. `npm run typecheck` and the 96/96 reasoning-focused tests passed;
  the Studio account-provider regression test passed 17/17.
- Chat completed a fresh request through the signed-in remote account. The
  exact group, model, and effort were not retained in this record and must not
  be reconstructed from the older baseline.
- Agent used `C:\Users\zz182\Desktop\2` for the calculator task, and the user
  confirmed in this maintenance session that it succeeded.
- A fresh signed-in Agent matrix then completed one real `list_directory`
  tool round for `grok / grok-4.5`, `国产模型 / deepseek-v4-flash`, and
  `国产模型 / glm-5.2`. Every run produced two completed tool events, a
  visible execution track, the expected workspace sentinel, and a final
  assistant response. At that dated baseline the catalog declared `openai`
  then `openai-response` for Grok and only `openai` for DeepSeek and GLM. The
  later explicit xAI Agent contract below supersedes only Grok's Agent primary
  route; it still does not guess from model names.
- Studio restored the expired authenticated session before provider discovery,
  selected `生图 / gpt-image-2-2k`, and completed workflow
  `studio-live-616755a0-b402-43e9-a70c-da1c1ff1698a` with run
  `b666a6f0-422d-45a9-aa34-d170918105a6`. The three-task run sent its one
  remote task and finished `succeeded`; the 1,254 x 1,254 PNG is
  `C:\Users\zz182\Desktop\2\Studio-Live-185612\outputs\1784632885267-Generate PNG-1-e4eff424.png`.
- Final Studio layout checks at 1,442 x 816, 1,040 x 700, 823 x 514, and
  538 x 400 confirmed a 965px, 816px, 771px, and 486px canvas in the checked
  states; opening the node library at 1,442 x 816 still left 817px for the
  canvas. The page, shared rail, and compact toolbar did not overflow. Linear
  View had zero horizontal overflow at 1,040 x 700, and the command palette
  stayed inside the 538 x 400 viewport.
- The architecture closeout rendered the current preview again at 1,440 x 900
  and 538 x 400. The canvas measured 946 x 718 and 486 x 236 respectively;
  document, Studio Shadow host, and Studio shell overflow stayed at zero. A
  1,040 x 700 window at the 125% layout-equivalent viewport (832 x 560) left a
  780 x 396 canvas with zero page, shell, toolbar, or canvas overflow. The
  browser console reported zero errors. Evidence is under `output/playwright/`
  as `architecture-studio-wide.png`, `architecture-studio-compact.png`, and
  `architecture-studio-zoom.png`.
- The Studio group and model menus are Renderer-owned dark listboxes. The
  checked confirmed and candidate group/model popovers remained dark, removing
  the native Windows white-popup regression without another billable request.
  The compact group menu was rechecked with an rgba(16, 20, 30, 0.97) surface,
  no white descendants, and `architecture-studio-group-menu.png` evidence.
- Studio now has one visible model route owner: the group and model selectors
  beside Run. Image generation, editing, inpainting, and outpainting node
  inspectors no longer duplicate those controls, and newly added remote image
  nodes inherit the current top-level route in the same undoable edit.
- The final ownership audit removed the three remaining migration tails.
  Renderer turn launch now projects Composer and Model Selection intent without
  reimplementing Main admission. Studio runtime/provider updates cross explicit
  Workflow Editor commands and there is no Store -> Editor subscription. The
  Agent turn loop no longer retains the Workspace Tool Broker's old formatters,
  path checks, or output limiter. Conversation and Turn Admission passed 15/15
  each, Agent passed 66/66, Workflow passed 77/77, Project Store passed 12/12,
  and the final typecheck passed.
- These live results used the existing application instance and the real
  account. The final focused checks passed 134/134 Agent protocol/admission
  tests, 16/16 Workflow Editor tests, and `npm run typecheck`. The broad
  security, E2E, and Electron suites were not rerun.

## Codex Workspace And Subagent Acceptance (Completed 2026-07-23)

- A new Agent task no longer requires a folder picker. Main creates
  `Documents\Codex\<date>\<prompt-slug>` with `work` and `outputs`, binds the
  resulting canonical workspace to the task in encrypted storage, and restores
  a fresh opaque workspace token when that historical task is reopened. Manual
  workspace selection remains an explicit override.
- Windows command output now pins Python stdio to UTF-8. The original
  Chinese-output failure is covered by a regression test and a signed-in live
  Agent run completed `python -c print('中文命令输出正常')` without an approval
  prompt in `full` mode.
- Depth-one local subagents use the selected model's declared Responses, Chat
  Completions, Anthropic, or Gemini protocol instead of forcing Responses. The
  current signed-in UI retest used `高速Codex Pro / gpt-5.5`, whose catalog
  declares OpenAI Chat Completions, and the visible execution track and
  Environment panel reported both parallel read-only subagents. A separate
  retest of `99%缓存kiro Claude Code` preserved its declared Anthropic-first,
  OpenAI-second order, but both `claude-fable-5` and `claude-opus-4-6` were
  rejected by the remote service before model output with an endpoint
  authorization error. This is a channel/token configuration failure at the
  service, not a client-side protocol substitution.
- Codex history is read through the official `codex app-server --stdio`
  `thread/list` and `thread/read` methods only. Windows resolves the official
  npm package's native Codex executable before falling back to `codex.exe`.
  The official source row remains read-only, but sending from it automatically
  imports the bounded transcript into a local encrypted task before the turn
  starts. The imported task is writable and keeps a `source` reference for
  idempotent retries; Main still rejects destructive mutations against the
  official Codex row and never edits Codex's own storage.
- The app-server incoming JSONL response-line bound is 16 MiB so a real large
  Codex thread can be parsed, while public output remains capped at 2,000
  messages, 256 KiB per message, and 2 MiB total. A 481-message real thread
  loaded in 2.2 seconds; the page stayed responsive with no console errors.
- The workspace history bridge writes each task's bounded, redacted visible
  user/assistant transcript to `AI-TERMINAL-HISTORY-<task-uuid>.md` and maintains
  `AI-TERMINAL-HISTORY.md` as an atomic root index. It syncs immediately after
  user persistence and again after assistant persistence, so an upstream model
  failure does not omit the user's request and concurrent tasks in one
  workspace cannot overwrite each other. Export errors never fail the Agent
  turn. The accepted bridge check found no credential pattern, absolute path,
  or temporary-file residue.
- Final verification included the real signed-in Agent flow, the real local
  Codex app-server, `npm run typecheck`, the 16/16 Codex adapter tests, 91/91
  combined Agent/workspace/export tests, 20/20 Conversation Session tests, and
  the complete `npm test` suite. No installer was built.

## Current Live UI Retest (2026-07-23)

- The existing Electron window completed a real UI-launched Agent task without
  a folder picker. It automatically created a dated projectless Codex
  workspace, selected `高速Codex Pro / gpt-5.5 / High`, and displayed the
  `系统完全访问` permission state.
- The execution track showed request submission, analysis, parallel dispatch,
  two distinct read-only child tracks, a workspace Python command, response
  generation, and one terminal completion. The Environment panel reported
  both child tasks complete; no approval modal appeared and document/body
  horizontal overflow remained zero.
- The task-scoped history transcript and root index were present in the bound
  workspace, included the fixed UTF-8 command marker, and contained no detected
  credential, absolute Windows path, or temporary history file.
- The Anthropic client sends both the standard Bearer header and `x-api-key`
  for `/v1/messages`; focused native-adapter assertions and the complete
  service suite pass. The currently selected Claude group still fails remotely
  with endpoint authorization, so it remains an explicit unavailable route
  until its server token/channel is corrected.
- A later signed-in run selected `高速Codex Pro / gpt-5.6-sol / Ultra`. The
  live catalog declared the `openai` route, tool use, and
  `auto/light/medium/high/xhigh/max/ultra`. Without a Renderer subagent switch,
  the model launched two independent read-only children; both completed once,
  the final response contained `SUBAGENT_ULTRA_OK`, and no approval control
  appeared while System Full Access was active.
- A bounded Grok source row remained selected when switching to Chat. Sending
  from it completed a real response, automatically created one local writable
  Chat copy, and left the provider source read-only. The copy then completed a
  rename and archive/restore round trip. A Gemini source row was separately
  imported as Agent into an automatically provisioned workspace; the binding
  restored successfully and its local copy also completed rename and
  archive/restore operations.
- After a new real account token was created, the account returned nine
  token-backed groups and `Gemini cil` became an eligible Chat/Agent group. Model
  Selection now checks real token metadata when the app returns to the
  foreground and every ten seconds, reloads catalogs only when the token
  fingerprint changes, and serializes refreshes so a long catalog pass cannot
  be invalidated by the next poll. Two complete poll cycles retained all eight
  conversation-capable groups and the selected Gemini model.
- The live Gemini catalog exposed `gemini-3.6-flash-high`, declared native
  `gemini` before `openai`, selected native Gemini for Chat, and reported tool
  use. A real Chat request returned `GEMINI_CHAT_LIVE_OK`. A real full-access
  Agent request completed native `write_file` and `read_file` calls, returned
  `GEMINI_AGENT_LIVE_OK`, and the resulting workspace file independently read
  back as `GEMINI_AGENT_FILE_OK`. No ordinary approval prompt appeared. The
  final code passed `npm run typecheck`; live account and filesystem results,
  not fixtures, are the acceptance evidence.
- The current signed-in `grok / grok-4.5` catalog uniquely maps the model to
  xAI and declares both OpenAI-compatible transports. Agent now selects native
  Responses first while Chat keeps Chat Completions. A real function call,
  Responses continuation, and separate Chat request all completed with HTTP
  200.
- System Full Access now preserves the current turn's absolute paths only in
  its Main-memory, credential-redacted model input. Encrypted history, exports,
  Renderer events, and diagnostics remain path-redacted. A real Grok Agent
  turn used that contract to write and read the exact target outside its
  automatic `Documents\Codex` workspace with two completed tools, no failed
  tool, and no approval event.
- System Full Access now advertises a first-class `delete_path` tool with a
  neutral `path` argument instead of requiring a model to invent a shell
  command from a workspace-relative schema. It can delete files and recursive
  directories outside the selected workspace, including paths under roots
  that remain protected in workspace-scoped modes, without an approval event.
  The developer instruction explicitly forbids claiming that a path is
  sandboxed or protected unless the exact advertised operation actually
  fails. Focused tests perform real sibling-directory and protected-history
  deletion; the complete `npm test` suite and typecheck pass.

## Current Studio Repair Build (2026-07-24)

- Every Studio selection control now uses the Renderer-owned `StudioSelect`
  listbox. Studio source and the production Renderer bundle contain no native
  `select` or `option` tags, so Windows cannot open an unthemed white system
  menu. The focused selector contract passed 2/2.
- GPT Image generation first negotiates SSE and accepts either completed SSE
  events or a successful JSON response. A legacy compatible endpoint receives
  one JSON fallback only when an HTTP 400/422 body explicitly identifies
  `stream` or `partial_images` as unsupported. Network interruptions,
  incomplete streams, and generic validation errors are never retried after
  dispatch. The focused network contract passed 7/7 and the production build
  completed.
- The signed-in live Studio run remains pending until the older portable
  process releases the rotating account credential. Do not refresh a copied
  credential while that process is active; doing so can invalidate its current
  session. This pending live check does not weaken the source/build evidence
  above.

## Studio Responsive UI Repair (Completed 2026-07-25)

- The workflow selector no longer inherits the 23px new-workflow button rule.
  Its Renderer-owned trigger now fills the available column, so workflow names
  remain readable instead of being clipped to their final characters.
- The canvas hides its minimap below a 1,050px Studio container and reduces the
  run dock to 88px in short windows. At the 538 x 400 check the canvas remained
  486 x 192 with zero document or Shadow-host overflow; the node library and
  inspector opened as mutually exclusive overlays.
- The Assets page switches from a three-column layout to explicit collection
  and detail drawers below a 900px Studio container. Runs stack their bounded
  list above a full-width detail view, and Settings uses a single-column body
  below 760px. The 1,040 x 700 and 538 x 400 checks kept the core page at full
  available width without clipped central content.
- The live signed-in Studio group popover remained Renderer-owned and dark
  (`rgba(20, 25, 34, 0.92)`) with no white descendants. Final verification
  passed `npm run typecheck` and the 2/2 Studio select UI contract; screenshots
  are under `output/playwright/studio-final-*.png`.

## Gemini Group Refresh Repair (Completed 2026-07-25)

- The missing Gemini group was caused by a burst of repeated account metadata
  and per-group catalog requests that triggered the real service's HTTP 429
  limit. It was not an aliasing problem. The canonical group id is exactly
  `Gemini cil` and must remain opaque throughout IPC, catalog selection, and
  turn admission.
- Relay account metadata reads now share in-flight work and an eight-second
  cache. Pricing has its own cache, and a metadata 429 starts a thirty-second
  cooldown. Conversation catalog discovery reuses server model declarations
  and requests an exact token-backed catalog only when that group is missing
  from the account declaration.
- Model Selection no longer discards other token-backed groups when the
  preferred group has a temporary catalog failure. An unchanged token
  fingerprint retries failed catalogs, and late or failed requests cannot
  overwrite a newer mode/group selection.
- A post-stop check attached to the sole development Electron instance. The
  signed-in account returned seven groups and nine tokens; both contained the
  exact `Gemini cil` route. The visible Chat group menu showed all seven groups
  with `Gemini cil` exactly once, and selecting it displayed three models,
  including `gemini-3.6-flash-high`.
- The same real catalog exposed those three models to both Chat and Agent.
  `gemini-3.6-flash-high` selected the native Gemini transport and declared
  tool use. Existing real Chat and Agent turns remained complete, and the
  Agent workspace file independently matched `GEMINI_AGENT_FILE_OK` before
  all four temporary acceptance tasks were deleted.
- Focused verification passed 43/43 Relay tests, 11/11 conversation catalog
  and mode-group tests, and `npm run typecheck`. No second development instance
  or installer was created, and no credential or response body was retained.

## Architecture Ownership

Production callers and tests cross the same module interfaces below. A caller
must not reimplement the owned rules or retain a second mutable source behind
another seam.

| Module | Sole owner of | Interface and focused test surface |
| --- | --- | --- |
| Model Selection | Chat/Agent mode, eligible groups, confirmed catalog, capability/reasoning projection, stale catalog requests | snapshot/actions in `src/renderer/src/model-selection/`; model-catalog and relay-mode tests |
| Conversation Session | Chat/Agent history, stream events, cancellation, approvals, execution trace, image URL lifetime | snapshot/actions in `src/renderer/src/conversation/`; `conversation-session.test.ts` |
| Composer | draft, attachments, capability palette/discovery, launch preparation and one-shot submission | snapshot/actions in `src/renderer/src/composer/`; `composer-capabilities.test.ts` |
| Workflow Editor | canonical Workflow edits, Canvas/Linear projection, typed graph commands, runtime projection allowlist, history, readiness, save/draft coordination | `workflow-editor-session.ts`; Studio workflow runtime tests |
| Studio Run Session | prepared plan, start/cancel lifecycle, event reduction and first-terminal authority | `StudioSessionController`; `studio-run-session.test.ts` |
| Turn Admission | confirmed-model admission, review/capability rules, credentials/workspace/attachment ordering and pending-start cancellation | Renderer launch projection -> `TurnAdmissionService`; `turn-admission-service.test.ts` |
| Agent Protocol Session | provider continuation state for Responses, Chat Completions, Anthropic and Gemini | `AgentProtocolSession`; protocol and Agent turn tests |
| Workspace Tool Broker | main/subagent tool proposal, policy, exact approval, execution result and status lifecycle | `WorkspaceToolBroker`; Agent/workspace tool tests |
| Agent Workspace Session | Codex-style projectless workspace creation plus encrypted project binding and token restoration | `AgentWorkspaceSessionService`; `agent-workspace-session-service.test.ts` |
| Codex History Adapter | read-only app-server lifecycle, pagination, bounded visible-message projection and Windows CLI resolution | `CodexAppServerHistoryService`; `codex-app-server-history-service.test.ts` |
| External Provider History Adapter | bounded visible-message scanning for Claude, Gemini, and Grok local history; opaque source IDs; provider-specific read projection | `ExternalProviderHistoryService`; `external-provider-history-service.test.ts` |
| Workspace History Bridge | bounded redacted visible user/assistant Markdown per task plus one atomic root index, synced after user and assistant persistence | `ConversationWorkspaceExportService`; `conversation-workspace-export-service.test.ts` |
| Project Persistence | project layout plus Workflow, asset, run journal and project configuration persistence behind `ProjectStore` | stable `ProjectStore` facade; `project-store-characterization.test.ts` |
| Studio IPC Catalog | operation name, channel, invocation kind, generated Preload bridge and Main registration completeness | `studioOperationCatalog`; `studio-ipc-contract.test.ts` |
| Renderer Styles | one token/reset/shell owner per DOM root, then feature and native adapters | ordered CSS entrypoints plus focused rendered layout checks |

## Account And Group Flow

- On renderer startup, call the existing `relay.connect()` path for the one
  fixed endpoint so an encrypted refresh credential is restored without an
  extra Login click. A missing or rejected credential still leaves the login
  gate locked; startup never fabricates an authenticated session.
- Account: authenticated `GET /api/user/self`.
- Billing display: public `GET /api/status`; never attach `Authorization`.
- Usage: `GET /api/data/self` when `enable_data_export=true`; otherwise page
  through `GET /api/log/self?type=2` and aggregate in Main.
- Tokens: `GET /api/token/`; real keys stay in Main and Renderer receives only
  the fixed `sk-********` mask.
- A group is selectable only when at least one usable token was created for it.
  This rule applies equally to Chat, Agent, and Studio.
- Chat/Agent poll only bounded token metadata while the desktop is open and
  also check when it returns to the foreground. A changed token fingerprint
  triggers one serialized account/catalog refresh; an unchanged fingerprint
  leaves the selected group and model intact. This covers tokens created in
  the external console without repeatedly fetching every model catalog.
- Chat/Agent probe the selected group's mode catalog first. A request failure
  keeps that selection and error state without silently trying another group;
  an explicit empty catalog may fall through to the next eligible group. A
  successful selected catalog becomes usable while the remaining group menu is
  filtered in the background.
- Model membership comes from the exact selected group's server response and is
  narrowed by token model limits. Pricing metadata may describe endpoints but
  must never widen group membership.
- Unlimited tokens may contain a historical negative `remain_quota`; normalize
  that value to zero. Reject a negative quota for ordinary limited tokens.

## Endpoint And Model Routing

- Model names are opaque for transport selection. Never infer an endpoint from
  an ID or prefix; reasoning may use only usable remote metadata or the exact
  vendor/model fallback documented below.
- Select transports only from server-declared endpoint types and preserve the
  server's declared order when choosing among supported conversation routes.
- Agent may advance to the next server-declared endpoint only when the current
  response explicitly classifies that endpoint (or its tool contract) as
  unsupported. Authorization, rate limits, server failures, timeouts, network
  errors, and malformed streams terminate the current request instead of
  replaying a potentially billable prompt against another route.
- Supported transports are OpenAI Responses, OpenAI Chat Completions,
  Anthropic Messages, Gemini GenerateContent, and OpenAI-compatible Images.
- A server-declared Responses route may be backed by NewAPI's
  Chat-to-Responses converter. Its generic output DTO adds empty
  `role`/`content`/`quality`/`size` fields and may finish function arguments
  with an empty `response.function_call_arguments.done` marker before the
  complete `response.output_item.done`. Accept only those exact empty adapter
  artifacts; keep the transport as Responses and never fall back by model name.
- NewAPI Chat Completions streams may use an empty interim `finish_reason` and
  may send empty `id`/function `name` fields on later chunks of an already
  validated tool call. Treat only those continuation placeholders as absent.
  The first tool chunk still requires a valid identity, and every non-empty
  terminal reason remains validated normally.
- `image-2`, `gpt-image-2`, future Grok image models, and future Gemini image
  models all use the same server-declared `image-generation` decision. Family
  names may affect an Images request contract only after endpoint selection;
  they must not select the endpoint.
- Opaque image models do not receive non-standard fields such as `seed` unless
  bounded server capability metadata explicitly declares support.
- Reasoning choices shown in Renderer first come from bounded remote model
  declarations. When the remote row has no reasoning declaration, an exact
  vendor/model/endpoint entry in the trusted fallback registry may supply the
  documented strengths. Unknown or ambiguous rows remain `auto`. Main maps a
  selected effort into the field required by the already selected protocol.
- Pure `image-generation` models have no Chat or Agent mode. A group containing
  only those models is visible only in Studio.

### Turn Admission

- `TurnAdmissionService` is the sole Main-process module that parses and admits
  Chat and Agent turn starts. IPC retains renderer trust, login state, window
  prompts, and the shared error projection, then delegates the turn lifecycle.
- Renderer launch preparation may switch Chat/Agent mode and request an Agent
  workspace. Its launch path only projects the current Composer and Model
  Selection snapshot; it does not reject account, catalog, group, model,
  reasoning, capability, review, or workspace admission on Main's behalf.
- Admission validates only the confirmed catalog and exact selected model; it
  never refreshes a catalog or infers an endpoint from a model name. It owns the
  pending-start cancellation registry and checks catalog freshness after model
  credential resolution, endpoint consent, and attachment preparation.
- For Agent turns, workspace identity is resolved before credentials. A review
  grant is consumed only after endpoint consent and attachment preparation have
  succeeded. Credentials, absolute workspace paths, attachment bodies, and
  abort signals remain inside Main and never enter the admission result or IPC.
- Studio does not infer models from names or pricing. It publishes the exact
  model IDs returned by each token-backed account group after the relay's
  eligibility check. Those models are selectable immediately; there is no
  separate candidate, confirmation, or billable probe catalog.

### Reasoning Metadata

The catalog accepts declarations shaped like the following. Model IDs are
opaque examples; `supported_endpoint_types` selects the transport and
`reasoning` only narrows the choices shown to the user.

```json
[
  {
    "id": "opaque-responses-model",
    "supported_endpoint_types": ["openai-response"],
    "reasoning": ["none", "minimal", "low", "medium", "high", "xhigh"]
  },
  {
    "id": "opaque-chat-model",
    "supported_endpoint_types": ["openai"],
    "reasoning": ["none", "minimal", "low", "medium", "high", "xhigh"]
  },
  {
    "id": "opaque-anthropic-model",
    "supported_endpoint_types": ["anthropic"],
    "reasoning": ["low", "medium", "high", "xhigh", "max"],
    "reasoning_protocol": { "type": "anthropic-adaptive" }
  },
  {
    "id": "opaque-gemini-model",
    "supported_endpoint_types": ["gemini"],
    "reasoning": ["minimal", "low", "medium", "high"],
    "reasoning_protocol": {
      "type": "gemini-level",
      "include_thoughts": false
    }
  },
  {
    "id": "opaque-gemini-budget-model",
    "supported_endpoint_types": ["gemini"],
    "reasoning": ["none", "low", "high"],
    "reasoning_protocol": {
      "type": "gemini-budget",
      "budgets": { "none": 0, "light": 512, "high": 4096 },
      "include_thoughts": true
    }
  }
]
```

- Responses sends a declared choice as `reasoning.effort`; Chat Completions
  sends it as `reasoning_effort`.
- `none` and `minimal` are distinct levels. They are never synthesized outside
  compatible remote metadata or an exact fallback profile. Gemini 2.5 Flash
  profiles add the documented `none: 0` budget; Gemini 3 profiles may add
  `minimal`. UI `light` maps to wire `low` for named protocols.
- Native protocol values are not collapsed across vendors: the current
  official OpenAI set is
  `none`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`,
  Anthropic adaptive supports `low`/`medium`/`high`/`xhigh`/`max`, and Gemini
  level supports `minimal`/`low`/`medium`/`high`. The Codex-level `ultra`
  preset maps to OpenAI-compatible wire `max`, exactly as Codex CLI does, and
  the literal string `ultra` is never sent to native Anthropic/Gemini.
- Anthropic adaptive thinking uses `thinking.type=adaptive` together with
  `output_config.effort`. Budget thinking and Gemini budgets use only the exact
  bounded map declared by the server; Gemini may explicitly declare `none: 0`.
  A declared `ultra` budget entry may therefore map to a numeric budget, but
  adaptive/level protocols reject that incompatible named value before fetch.
- Gemini level thinking maps to `MINIMAL`, `LOW`, `MEDIUM`, or `HIGH`.
- Native Anthropic and Gemini receive thinking fields only from a matching
  remote `reasoning_protocol` or an exact trusted fallback profile. Unknown
  fields, ambiguous vendors, unknown model IDs, and mismatched preferred
  endpoints remain `auto` rather than selecting a protocol by name.
- Supported-strength metadata may use bounded arrays or nested enum/value
  schemas. A scalar default is not treated as a capability list. Provider
  spelling is normalized only after declaration (`LOW`/`low` becomes UI
  `light`). A usable remote declaration is authoritative even if all of its
  values are unknown and it therefore projects to only `auto`; native
  Anthropic/Gemini metadata is usable only with a matching protocol.
- For a multi-endpoint model, Chat projects reasoning only for its preferred
  endpoint. Agent keeps the bounded native declaration and projects it onto
  each matching endpoint candidate, so an OpenAI-first model can retain
  Anthropic/Gemini thinking after a valid protocol fallback.

The fallback registry is deliberately exact. OpenAI profiles extend only as
far as each listed model supports, with `gpt-5.6-sol` and `gpt-5.6-terra`
exposing the product's `ultra` preset (serialized as OpenAI wire `max`);
Anthropic reaches at most `max`; xAI reaches at most `xhigh`; Gemini level
profiles reach at most `high`, while Gemini 2.5 uses bounded token budgets
rather than `thinkingLevel`. The complete model-ID table is in
`docs/MODEL_ROUTING.md`.

## Agent Local Tools

- `WorkspaceToolBroker` is the sole owner of local tool path classification,
  exact approval labels, dispatch result formatting, redaction, and bounded
  output. `AgentTurnService` orchestrates the protocol loop and delegation but
  does not retain another copy of those rules.
- In `request` and `auto`, model tools accept workspace-relative paths only. In
  confirmed `full`, tools may use absolute paths or parent traversal; the
  selected workspace remains the base for relative paths and Git operations.
- Every local operation is bound to the current turn, tool call, workspace,
  operation category, and exact argument snapshot.
- `request` asks for a one-time Renderer approval. `auto` permits only bounded
  low-risk workspace reads without prompting and asks once for workspace
  writes or commands. `full` skips ordinary prompts and selects the shared
  Broker's system filesystem/process scope.
- In `request` and `auto`, cross-workspace absolute paths and parent traversal
  fail before approval. In `full`, absolute paths, parent traversal, absolute
  command arguments, and explicit shell executables are valid local requests.
- Agent users can replace the active scope from the header's `打开位置` menu via
  `选择其他工作区`, from `文件 > 打开工作区`, or with `Ctrl+O`. A switch
  issues a new workspace selection, clears the old task/capability context,
  and requires a new `full` confirmation before the next Agent turn.
- Without an active workspace, sending a new Agent task provisions a
  Codex-style dated workspace automatically. Reopening that task restores its
  bound workspace; projectless tasks never inherit an unrelated prior scope.
- Attachments are untrusted model inputs, not local filesystem grants. Adding
  a file never expands the Agent workspace or authorizes its parent directory.
- Command execution uses an argv array with `shell:false`, a verified
  workspace-relative cwd, a sanitized environment, bounded output and timeout,
  and process-tree cancellation. It is unavailable in plan/review mode and is
  never auto-approved. Python child stdio is explicitly UTF-8 so valid Chinese
  output is not misclassified as an invalid command response on Windows.
- `delegate_tasks` may launch one to three depth-one read-only subagents. Main
  automatically exposes it in Agent mode when the confirmed model has a usable
  Agent endpoint and has not explicitly disabled tool/delegation capability;
  the model decides whether to call it, with no renderer switch required. They
  inherit the already confirmed provider route and reasoning settings, expose
  only bounded list/search/read tools, cannot delegate again, and publish
  stable queued/running/terminal events for the shared execution track. Chat
  and `/review` remain isolated from delegation.
- Codex interoperability is intentionally asymmetric and supported: Codex
  history is read via official app-server APIs, while AI-terminal history is
  exposed to Codex through task-scoped redacted
  `AI-TERMINAL-HISTORY-<task-uuid>.md` files listed by the bound workspace's root
  `AI-TERMINAL-HISTORY.md` index. Never write Codex SQLite, rollout JSONL, or
  session indexes directly.
- Claude Code, Gemini CLI, and Grok local history follows the same adapter
  contract. Their provider-owned JSONL files are scanned read-only into
  `claude:<opaque-source-id>`, `gemini:<opaque-source-id>`, and
  `grok:<opaque-source-id>` tasks. Sending from one of these rows imports its
  bounded visible transcript into the encrypted local history using the
  current Chat or Agent mode. Chat imports do not require a workspace token;
  Agent imports retain the selected workspace binding. Later turns, rename,
  archive, and deletion are writable without mutating the provider's own files
  or indexes. Idempotency is scoped by source, mode, and local project so one
  provider transcript may have independent Chat and Agent copies.
- The accepted live Agent smoke path uses a harmless workspace file operation:
  `write_file` followed by `read_file`, with the exact operation result bound
  to the current turn. A browser-level calculator check was completed in the
  selected workspace; do not treat this as permission to access another
  workspace or to run image generation from Agent.

### Approval Modes And Codex CLI

Codex CLI treats filesystem/process sandboxing and approval policy as separate
controls. AI-terminal exposes one selector and projects it onto both controls:

- `request`: ask once for the exact local operation and argument snapshot.
- `auto`: automatically allow bounded low-risk read, enumerate, and search
  operations. Writes and commands request one exact approval instead of being
  denied by policy.
- `full`: skip ordinary approval prompts and use System Full Access. Absolute
  paths, parent traversal, absolute executables and arguments, and explicit
  `cmd`, PowerShell, or POSIX shells are valid. The workspace token is still
  required for task ownership, the default cwd, and workspace Git operations.
- Plan and Review remain read-only by tool exposure. Delegated subagents remain
  depth-one and read-only, but inherit system read scope when the parent turn
  uses `full`.
- In `full`, Broker results and delegated-subagent summaries retain accurate
  absolute paths inside Main so the parent model can continue operating on
  them. Renderer deltas, persisted conversation history, exported history, and
  public diagnostics continue to redact absolute local paths and credentials.
- The current `full` user prompt follows the same rule: Main supplies its exact
  absolute paths to the admitted model from the in-memory turn after credential
  redaction. It must not reconstruct that current prompt from path-redacted
  persistence. Prior history remains redacted.
- Cancellation, timeouts, bounded output, process-tree termination, and output
  redaction remain active in every mode; they are execution lifecycle controls,
  not a hidden workspace sandbox.

Unlike Codex CLI Auto, AI-terminal `auto` does not execute ordinary workspace
commands or writes without one exact approval. AI-terminal `full` is equivalent
to Codex's `approval=never` plus `danger-full-access`, while changing the
selected workspace only changes the default task directory.

The upstream separation was rechecked against fixed sources on 2026-07-23:

- Codex projects its bypass flag onto both `AskForApproval::Never` and
  `SandboxMode::DangerFullAccess` in
  <https://github.com/openai/codex/blob/87db9bc18ba5bc82c1cb4e4381b44f693ee35623/codex-rs/cli/src/main.rs#L1929-L1938>.
- Gemini CLI's YOLO policy allows tools, while `WorkspaceContext` separately
  owns the initial and additional directory set:
  <https://github.com/google-gemini/gemini-cli/blob/87f785192c34067e4e8f26bda16cf9ce24014d83/packages/core/src/policy/policies/yolo.toml>
  and
  <https://github.com/google-gemini/gemini-cli/blob/87f785192c34067e4e8f26bda16cf9ce24014d83/packages/core/src/utils/workspaceContext.ts>.
- Grok Build documents sandbox `off` as unrestricted and keeps its permission
  rule types separate:
  <https://github.com/xai-org/grok-build/blob/a5727c5960452e7527a154b25cb5bf00cda0545e/crates/codegen/xai-grok-pager/docs/user-guide/18-sandbox.md>
  and
  <https://github.com/xai-org/grok-build/blob/a5727c5960452e7527a154b25cb5bf00cda0545e/crates/codegen/xai-grok-config-types/src/permission.rs>.

### Anthropic Tool Continuations

When an Anthropic Agent response calls a tool, Main retains the complete
assistant content sequence by source block index, including `thinking` with its
signature and any `redacted_thinking` block. The next native Messages request
must replay that sequence unchanged before the matching `tool_result` blocks.
Missing signatures, malformed blocks, reordering, and size overruns fail closed.

These thinking blocks exist only in Main's in-memory message chain for the
current tool loop. They do not emit Renderer deltas, cross IPC, or enter the
persisted conversation history; only visible text follows those paths.

## Studio Runtime

- Studio providers are generated in Main from token-backed groups. Each
  descriptor exposes the exact eligible group catalog through
  `availableModels`; Renderer presents the complete catalog directly without a
  candidate or confirmation layer. If endpoint metadata is absent, the account
  adapter uses the standard Images routes while the remote service remains the
  authority on whether a selected model accepts the request.
- Provider credentials are resolved for the exact group and model immediately
  before dispatch. Renderer receives descriptors and masked status only.
- Group membership and usable-token eligibility are rechecked immediately
  before every dispatch. Credentials and request bodies remain in Main.
- Every exact eligible group model uses the normal Images request fields. The
  selected remote service validates its final model/operation support and any
  provider error is projected as user-facing run feedback.
- The normal Electron bootstrap starts with empty project/provider/task state,
  then loads the real account. Demo seeds are allowed only when
  `VITE_UI_PREVIEW_HARNESS=1`.
- A generation node without reference input uses the normal image-generation
  route. When one or more safe project images are connected, the runner uses
  the matching multipart image-edit route; models with array input support
  receive every connected reference (up to 16), while single-image contracts
  receive the first. The port is disabled only for a model whose known
  capability explicitly rejects image input.
- Studio uses the same shell boundaries as Chat and Agent. The shared rail is
  260px at 1,440/1,280 pixel widths and 52px at 940px, begins at y=42, and
  extends to the bottom. Run controls remain group -> model -> Run, and the
  full selected model name must remain visible without a multi-column menu.
- The Studio workflow is one continuous Chat-like work surface and gives
  unused width to the canvas. The node library starts closed; selecting a node
  opens the inspector. At compact container widths, utility panes become
  overlay drawers instead of reducing canvas width.
- Studio responsiveness follows the actual `.page-viewport` container width,
  including under page zoom. Renderer `body` keeps `min-width: 0` and
  `min-height: 0`; physical minimum window dimensions remain owned by
  `src/main/window.ts`. Linear View becomes one column when compact, and
  route/command popovers scroll within short viewports.
- `CanvasSurface` observes rendered size. It refits after resize until the user
  manually pans or zooms; afterward it preserves the user's visual center. Do
  not replace this behavior with unconditional `fitView`.
- Studio group/model pickers use the shared Renderer-owned `StudioSelect`
  listbox. Do not reintroduce native `select` for these controls: native
  Windows popup theming is outside the Studio Shadow DOM and may render a white
  menu.

### Renderer Style Ownership

- Light-DOM styles load in the fixed order `tokens -> reset -> shell ->
  feature -> native`. `src/renderer/src/styles.css` is the feature entry and
  imports `styles/tokens.css`, `styles/reset.css`, and `styles/shell.css` in
  that order. `codex-monitor-theme.css` follows as the runtime/native visual
  adapter; it must not redefine the global token registry or browser reset.
- `styles/tokens.css` solely owns the global palette, typography, dimensions,
  radii, motion values, and responsive root dimensions. `styles/reset.css`
  solely owns light-DOM box sizing, root/body primitives, focus, selection,
  and scrollbars. Stable application frame and settings-sidebar geometry stay
  in `styles/shell.css`; Chat and Agent component rules stay in `styles.css`.
- Studio remains a Shadow DOM module. Its raw
  `renderer/visual-tokens.css` is the sole Studio token owner and is rewritten
  from `:root` to `:host` by `StudioWorkspace`; `renderer/styles.css`
  owns the scoped reset and feature geometry, and
  `renderer/ai-terminal-theme.css` loads last for feature/native adaptation.
  Top-layer listboxes, popovers, controls, and native fallbacks consume the
  semantic surface roles from that registry. Do not move the Studio reset to
  the outer Renderer or add another `:root` registry.

### Studio IPC Catalog

- `src/studio/shared/ipc-channels.ts` is the only handwritten Studio operation,
  channel, and invocation-kind catalog. `channels` is a compatibility
  projection from that catalog, never a second source.
- `src/preload/studio-bridge.ts` generates the Renderer bridge from the same
  catalog. Main registers operations through the catalog tracker, which rejects
  kind mismatches, duplicate registration, and incomplete registration.
- `StudioBridge` and the catalog have bidirectional type completeness checks.
  Add or remove an operation at the catalog seam first, then implement its
  contract and Main handler; never handwrite a channel in Preload or Renderer.

### Project Persistence

- Studio owns one project root at `Documents\Codex\Studio`. Main creates it at
  startup, creates every new project beneath it, discovers projects there for
  the in-app picker, and rejects open requests outside that root. Project
  creation/opening never exposes a directory-selection operation.
- `ProjectStore` remains the stable caller-facing facade and preserves every
  existing public method and on-disk format. Its internal persistence modules
  share one `ProjectLayout` and one `MutationCoordinator` instance.
- `ProjectLayout` is the sole owner of `project.json` / `studio.project.json`
  compatibility, managed-directory symlink checks, layout initialization and
  repair, and advisory project timestamp updates. `MutationCoordinator` is the
  sole owner of per-project/resource mutation serialization.
- `WorkflowRepository` is the sole Main-process owner of Workflow discovery,
  legacy `.json` paths, migration, unknown-field preservation, CAS saves,
  immutable version snapshots, drafts, and archive/restore. Do not duplicate
  those rules in `ProjectStore`; tests continue to cross the `ProjectStore`
  interface using real temporary directories.
- `AssetCatalogRepository` is the sole owner of asset catalog validation,
  derivation relationships, candidate decisions, boards/smart collections,
  image import/export/masks, and managed asset/output path resolution.
- `RunJournalRepository` is the sole owner of task history, the persistent run
  queue, historic run validation, interruption recovery, and billing-unknown
  classification. Queue and task mutations share the facade's
  `MutationCoordinator`, so concurrent accepted updates remain serialized.
- `ProjectConfigurationRepository` is the sole owner of project plugin and
  parameter preset persistence. It validates declared/granted plugin
  permissions and exact version locks, normalizes directly saved presets, and
  merges imported preset envelopes by ID without changing the disk format.

### Workflow Editor And Document Session

- `workflow-editor-session.ts` is the sole Renderer owner of canonical Workflow
  mutations. It translates typed Canvas and Linear commands through the core
  `WorkflowEditor`, owns drag grouping and the bounded undo/redo history, and
  publishes graph, Linear View, readiness, dirty, and save/draft projections.
- `studioStore.ts` is a UI projection and effect adapter. Its named Workflow
  projection/actions slice sends runtime graph fields through the editor's
  explicit allowlist command and sends Provider readiness at the write site.
  Only the editor session subscribes into the Store; a Store -> Editor
  subscription is forbidden. The overall Zustand UI interface remains wide,
  but it must not interpret graph mutations, rebuild history, or expose an
  arbitrary whole-graph commit path.

- `workflow-document-session.ts` is the single Renderer module that owns the
  formal baseline, scope epoch, edit generations, formal save, draft lifecycle,
  and accepted-save rebase beneath the Workflow Editor. Runtime-only canvas
  fields never become Workflow edits.
- A formal receipt rebases `base/local/formal` content rather than replacing
  the active document. ID-keyed independent additions are retained. Concurrent
  edge collections fall back to the local collection only when their merged
  graph would create a structural conflict; a shared-subgraph interface falls
  back only for duplicate port names or IDs. Dangling references and recursive
  subgraph instances are repaired before the result is published.
- Dirty state is not inferred from an edit generation alone. It also compares
  the active document with its formal baseline, so an accepted A -> B -> A
  receipt cannot make unpersisted rebased content appear clean.
- Scope changes invalidate direct stale callbacks. An accepted old-scope save
  may still be deliberately rebased through the current matching Workflow
  session, while stale request feedback must not overwrite newer UI feedback.
- Prompt Matrix preflight is owned by `PromptMatrixSessionController`. It
  freezes the bridge, project, source fingerprint and edit generation,
  workflows, targets, overrides, and every returned plan. Store state is only
  a display projection; confirmation may dispatch only that frozen snapshot.
  Project/workflow scope replacement clears both prepared-run sessions before
  opening the next document, so an A -> B -> A transition cannot revive an old
  asynchronous Matrix preflight. Confirmation consumes the session before any
  dispatch; individual dispatch failures are retained without cancelling the
  remaining frozen combinations.

### Studio Run Session

- `StudioSessionController` owns `prepare/start/cancel/onRunEvent`, the active
  run registry, single-flight cancellation, lifecycle reduction, and the first
  terminal result. A late `startRun` result or error cannot replace a terminal
  run event that arrived first.
- `studioStore.ts` consumes `latestFeedback` as a display projection. It does
  not subscribe to raw run events or run a second lifecycle reducer. Only a
  legacy/untracked row may use the direct Bridge cancellation fallback.

## Security Boundaries

- Main owns network, credentials, DPAPI storage, local files, processes, and
  endpoint confirmation. Renderer has no Node or arbitrary network access.
- Never log or persist full keys, refresh tokens, request bodies, absolute local
  paths, filenames, or unredacted tool output.
- Remote endpoints require HTTPS except exact loopback development endpoints.
- Unknown server fields are projected away before IPC. Schema drift fails
  closed with fixed, credential-free errors.
- Do not weaken redaction, one-time grants, endpoint consent, workspace identity
  checks, atomic writes, or cancellation to make an integration pass.

## File Map

- `src/main/services/relay-service.ts`: authenticated NewAPI account requests,
  token-backed groups, model credentials, and usage.
- `src/main/services/relay-dto-adapter.ts`: bounded server-to-Renderer projection.
- `src/main/services/model-catalog.ts`: endpoint and reasoning metadata.
- `src/main/services/turn-admission-service.ts`: confirmed-catalog turn
  admission, pending-start cancellation, workspace/attachment preparation,
  endpoint consent sequencing, and Chat/Agent dispatch.
- `src/main/ipc/register-ipc.ts`: confirmed catalog, group, token, endpoint, and
  turn-start binding.
- `src/main/services/agent-turn-service.ts`: protocol-neutral Agent loop,
  bounded delegation orchestration, persistence, and event emission.
- `src/main/services/agent-protocol-session.ts`: Responses, Chat Completions,
  Anthropic, and Gemini continuation adapters behind one protocol interface.
- `src/main/services/workspace-tool-broker.ts`: shared main/subagent local tool
  proposal, policy, approval, dispatch, redaction, and status lifecycle.
- `src/main/services/workspace-tool-service.ts`: workspace filesystem, Git, and
  bounded command execution.
- `src/main/services/agent-workspace-session-service.ts`: Codex-style automatic
  workspaces, encrypted task bindings, manual overrides, and opaque token
  restoration.
- `src/main/services/codex-app-server-history-service.ts`: official Codex
  app-server lifecycle, read-only task pagination/projection, bounded incoming
  JSONL response lines, and Windows CLI resolution.
- `src/main/services/conversation-workspace-export-service.ts`: atomic,
  task-scoped redacted Agent history files and their bounded workspace-root
  index.
- `src/main/studio/account-providers.ts`: account group to Studio provider map.
- `src/main/studio/network.ts`: Images generation/edit dispatch.
- `src/main/studio/projects.ts`: stable Studio project persistence facade.
- `src/main/studio/project-persistence.ts`: project layout, legacy metadata,
  managed-directory validation, and shared mutation serialization.
- `src/main/studio/workflow-repository.ts`: Workflow persistence, CAS,
  versions, drafts, archives, migrations, and legacy path compatibility.
- `src/main/studio/asset-catalog-repository.ts`: assets, candidate decisions,
  collections, image import/export/masks, and managed asset paths.
- `src/main/studio/run-journal-repository.ts`: tasks, persistent run queue,
  historic run records, trimming, and restart recovery.
- `src/main/studio/project-configuration-repository.ts`: project plugin
  manifests, permission/version-lock rules, and parameter preset CRUD/import.
- `src/studio/shared/ipc-channels.ts`: canonical Studio operation/channel/kind
  catalog and Main registration tracker.
- `src/preload/studio-bridge.ts`: catalog-generated Studio Renderer bridge.
- `src/renderer/src/model-selection/`: Chat/Agent mode, eligible groups,
  confirmed catalogs, model capabilities, reasoning degradation, and stale
  request invalidation behind one snapshot/actions interface.
- `src/renderer/src/conversation/`: Chat/Agent history, stream, cancellation,
  approval, execution trace, and image URL lifecycle.
- `src/renderer/src/composer/`: draft, attachments, capability discovery,
  launch preparation, and submission lifecycle.
- `src/renderer/src/App.tsx`: shared Chat/Agent surface composition, launch
  preparation, and admission-free turn intent projection.
- `src/renderer/src/styles/`: global token, reset, and shell owners; imported
  in that order by `src/renderer/src/styles.css` before feature/native styles.
- `src/renderer/src/studio/`: embedded Studio shell and workflow UI.
- `src/renderer/src/studio/renderer/session/workflow-editor-session.ts`: typed
  Workflow edit commands, projections, readiness, history, and document
  persistence coordination.
- `src/renderer/src/studio/renderer/session/workflow-document-session.ts`:
  formal baseline, rebase, save, and draft implementation behind the editor.
- `src/renderer/src/studio/renderer/session/StudioSession.ts`: Studio run and
  Prompt Matrix preparation, confirmation, event, cancellation, and terminal
  authority.
- `src/studio/core/studioReadiness.ts`: graph readiness and reference rules.

## Verification

Before starting a dev process, check port 5173 and existing Electron processes.
Do not launch a duplicate `npm run dev` instance.

Use `npm run dev` for the single development instance or `electron.exe .` for
the compiled application. Do not pass a Windows absolute project path directly
to an ESM loader; launch through the project script or Electron entrypoint.

Real signed-in account validation comes before automated regression checks for
an online failure. The commands below are available verification tiers, not a
requirement to run all of them after every change. Use the focused tier named in
`docs/MAINTENANCE.md`; do not run the broad security, E2E, or Electron suites
unless the user explicitly requests them. The latest recorded 2026-07-23 pass
reused the existing signed-in application for automatic workspace, protocol-
neutral subagent, UTF-8 command, and read-only Codex history checks, then passed
`npm run typecheck` and the complete `npm test` suite. The earlier Chat, Agent,
and Studio acceptance intentionally did not rerun the broad E2E or Electron
matrices. No installer was built.

```powershell
npm run typecheck
npm test
npm run test:e2e
npm run test:electron
```

The Desktop directory has no product `.git` repository. A wrapper or an
upstream NewAPI checkout elsewhere must not be treated as the product repo.

For task-oriented read paths and minimum verification commands, read
`docs/MAINTENANCE.md`. Protocol and reasoning sources are recorded in
`docs/MODEL_ROUTING.md`.
