# Real Account First

This project is maintained against the signed-in account and its real remote
NewAPI service. The following rules are part of the product workflow:

- Real account connectivity is the first acceptance target. A local mock,
  preview harness, seeded demo data, fake model, or synthetic response cannot
  substitute for a real-account check.
- `npm run test:e2e`, Electron smoke checks, and fixture-based service tests
  validate code paths only. They must never be reported as proof that the
  user's account or NewAPI is connected.
- Do not repeat the broad security suite during ordinary online debugging. Run
  focused checks only when they directly cover a changed connection path. Run
  the broad security, E2E, or Electron suites only when the user explicitly
  requests them.
- Use the one existing development instance. Check port `5173` and the
  existing Electron process before starting anything. Never start a second
  `npm run dev` process to recover a broken session.
- Prefer CDP attachment and narrowly scoped scripts against that existing
  instance. Do not control the user's mouse or keyboard when the same live
  result can be obtained without computer-use automation.
- Never fabricate a login, token, group, model, balance, or generation result.
  If the real session is behind the login gate, stop at that gate and ask the
  user to complete the login in the already-open window.
- Real validation order is Chat catalog/request, Agent catalog plus one
  harmless workspace operation, then Studio image generation. Image
  generation is never tested from Agent.
- Online diagnostics may report only redacted status such as `ok`, an error
  code, endpoint kind, and counts. Do not print tokens, request bodies,
  refresh credentials, or private account data.

## Acceptance Snapshot

This section is a dated live status, not a durable claim that every mode is
complete. Update it after each real-account retest; do not copy an older success
forward when the current session fails earlier in the request path.

### Previously Recorded Live Baseline (2026-07-21)

The following results predate the current reasoning-registry and Studio-style
changes. They prove that the three real account paths worked at that point; they
must not be reported as acceptance of the current implementation.

- Account restore and the real `/api/status`, `/api/pricing`, and
  `/api/data/self` paths parsed successfully.
- Chat completed a real request through `高速Codex Pro / gpt-5.5` with the
  exact response `CHAT_CURRENT_OK`.
- Agent completed a native live turn through the same account and model. It
  performed `write_file` followed by `read_file` and returned
  `AGENT_CURRENT_OK`; the read-back content was `LIVE_AGENT_CURRENT_OK`.
- The same Agent path created and updated
  `C:\Users\zz182\Desktop\2\agent-calculator.html`. Browser verification
  confirmed `12.5 × 2 = 25`, `123` backspace to `12`, `50% = 0.5`, sign toggle
  to `-0.5`, and the visible divide-by-zero error.
- Studio completed a real Images request for the explicitly selected `生图` /
  `gpt-image-2-2k` route. `/v1/images/generations` returned a valid 2xx Images
  response that decoded to a complete 417,753-byte PNG. The formal workflow
  finished with one remote task, one asset, and a 1,254 x 1,254 output written
  under `C:\Users\zz182\Desktop\2\Studio-Live-131437\outputs`.
- For server-declared `image-generation` models, the normal workflow keeps its
  full declared parameters. An exact, billable Images confirmation is allowed
  to use only the verified minimum `{ model, prompt, count }` request. Editing,
  inpainting, and expansion are rejected before dispatch until the server
  explicitly confirms an input-image capability.
- Studio layout was checked at 1,440, 1,280, and 940 pixel widths. The shared
  left rail is 260px at the two wide sizes and 52px at 940px, begins at y=42,
  and runs to the bottom; the compact run bar keeps the order group -> model ->
  Run and leaves the canvas expanded.
- This acceptance used the existing live instance and focused checks only. The
  broad security, E2E, and Electron suites were not rerun and are not evidence
  of the live account result.

### Current Change Acceptance (Completed 2026-07-22)

The current implementation passed `npm run typecheck`, 96/96
reasoning-focused tests, and 17/17 Studio account-provider tests. The following
are separate live-account results from the existing application instance:

1. Chat completed a fresh request through the signed-in remote account. This
   record intentionally does not invent a group, model, effort, or response
   marker that was not retained from the run.
2. Agent used `C:\Users\zz182\Desktop\2` for the calculator task. The user
   confirmed in this maintenance session that the calculator task succeeded.
   A later signed-in matrix separately completed a real `list_directory` tool
   round for `grok / grok-4.5`, `国产模型 / deepseek-v4-flash`, and
   `国产模型 / glm-5.2`. All three runs completed their tool events, showed an
   execution track, found the expected workspace sentinel, and returned a
   final response. At that dated baseline Grok followed the catalog's
   `openai`, `openai-response` order; this predates the explicit xAI Agent
   contract recorded below. DeepSeek and GLM followed their declared `openai`
   route.
3. Studio was opened directly after application restart, refreshed the expired
   authenticated session, and loaded `生图 / gpt-image-2-2k` without first
   opening Chat. Workflow `studio-live-616755a0-b402-43e9-a70c-da1c1ff1698a`
   ran as plan `b666a6f0-422d-45a9-aa34-d170918105a6`: all three tasks
   finished, its one remote task reached dispatch state `sent`, and the run
   finished `succeeded`. The resulting 1,254 x 1,254 PNG is
   `C:\Users\zz182\Desktop\2\Studio-Live-185612\outputs\1784632885267-Generate PNG-1-e4eff424.png`.
4. Fresh Studio checks at 1,440, 1,280, and 940 pixel widths found no pane
   overlap. The left rail measured 260px, 260px, and 52px respectively; at
   940px the route bar measured 330px, the More menu and full model label
   remained visible, and the initial canvas fit was 0.6.
5. Studio's group and model selectors beside Run are now the sole visible
   route controls. Image generation, editing, inpainting, and outpainting node
   inspectors hide their duplicate route fields, while newly inserted nodes
   inherit the selected top-level route. The focused Agent protocol/admission
   tests passed 134/134, Workflow Editor tests passed 16/16, and typecheck
   passed after the live matrix.

Chat, Agent, and Studio are therefore accepted for this change. These results
do not assert that broad security, E2E, or Electron suites were rerun.

An image-like model row published only as `openai`, `openai-response`,
`anthropic`, or `gemini` remains a conversation row and is never enabled by
matching its name. When the server declaration is stale, one exact group/model
may be offered for an explicit, billable Images confirmation. Only a successful
response containing a complete parsed image is cached; a rejected, malformed,
or interrupted request leaves Studio unchanged.

### Codex Workspace And Subagent Acceptance (Completed 2026-07-23)

This pass reused the one signed-in Electron instance and performed a fresh
billable Agent request. It did not build an installer.

1. Starting a new Agent without selecting a folder created a projectless
   workspace under `Documents\Codex\<date>\<prompt-slug>` with `work` and
   `outputs`, then restored that binding from the created history task.
2. With `系统完全访问` and parallel subagents enabled, one real turn ran two
   independent read-only subagents. Both reached queued, running, and completed
   states. The same turn executed Python and returned the exact Chinese marker
   `中文命令输出正常`; no approval event was emitted.
3. The accepted run verified that the workspace bridge retained the Chinese
   marker while exposing only redacted visible user and assistant text. The
   maintained layout now stores each transcript in
   `AI-TERMINAL-HISTORY-<task-uuid>.md` and keeps `AI-TERMINAL-HISTORY.md` as the
   workspace-root index, so tasks sharing a workspace cannot overwrite one
   another. No detected credential pattern or absolute Windows path crossed
   the bridge.
4. The official local Codex app-server listed 13 active and 3 archived tasks.
   A 481-message task loaded through the Electron IPC and Renderer as read-only;
   sending, compacting, renaming, archiving, deleting, and other task actions
   were all denied or disabled. No conversation text was printed by the
   acceptance scripts.
5. Focused adapter, workspace, export, Agent, and Conversation tests passed,
   followed by `npm run typecheck` and the complete `npm test` suite.

For future checks, record counts, roles, state transitions, and redacted marker
presence only. Do not print Codex thread content, model request bodies, local
absolute paths from model traffic, or credentials.

### Current Live UI Retest (2026-07-23)

- A real UI-launched Agent task on `高速Codex Pro / gpt-5.5` automatically
  provisioned its projectless workspace and displayed the full-access state.
  The page showed the request, analysis, parallel dispatch, both child tracks,
  the Python command, and the terminal response in order. Both child tracks
  completed once, no approval modal appeared, and page/body horizontal overflow
  stayed at zero.
- The corresponding workspace bridge contained both `work` and `outputs`, a
  task transcript and root index, and the fixed UTF-8 output marker. No
  credential pattern, absolute Windows path, or temporary history file was
  detected.
- The signed-in Claude group was retested separately with
  `claude-fable-5` and `claude-opus-4-6`. The catalog declared
  `anthropic` then `openai`; the client tried only those declared routes, but
  the service rejected both before model output with endpoint authorization.
  Treat this as a remote token/channel issue, not evidence that Agent is using
  the Chat protocol for Claude.
- A subsequent real Agent request used
  `高速Codex Pro / gpt-5.6-sol / Ultra`. Its live catalog declared the
  `openai` route, tool use, and every displayed strength through `ultra`. The
  model autonomously dispatched two independent read-only subagents, both
  completed once, the response returned `SUBAGENT_ULTRA_OK`, and full access
  produced no ordinary approval prompt.
- A bounded Grok history source completed a real Chat continuation and became
  one local writable copy without changing the provider row. Rename and
  archive/restore succeeded on that copy. A Gemini source was imported into a
  restorable Agent workspace and its local copy passed the same writable
  operations without transmitting the imported transcript to a model.
- The user then created a real Gemini token. The account returned nine
  token-backed groups, the desktop menu exposed `Gemini cil`, and the catalog
  returned `gemini-3.6-flash-high` with native `gemini` before `openai` and
  tool use enabled. A native Chat request returned `GEMINI_CHAT_LIVE_OK`.
- A native full-access Gemini Agent turn created and read
  `work/gemini-live-check.txt`, returned `GEMINI_AGENT_LIVE_OK`, and an
  independent filesystem read confirmed `GEMINI_AGENT_FILE_OK`. Both tool
  calls completed and no ordinary approval prompt appeared.
- Foreground plus ten-second token synchronization was observed against the
  real account. Refreshes are serialized; after two complete poll cycles the
  eight conversation-capable groups and selected Gemini model remained stable.
  Typecheck passed; no fixture response is used as live acceptance evidence.

### Grok Agent And System Scope Retest (Completed 2026-07-23)

- The signed-in catalog returned `grok / grok-4.5`, uniquely attributed it to
  xAI, and declared both `openai` and `openai-response`. Agent selected
  `/v1/responses`; Chat retained `/v1/chat/completions`.
- A real Responses request returned one function call, and its real
  `function_call_output` continuation returned the final answer. Both requests
  were HTTP 200. A separate real Chat request through the same group/model was
  also HTTP 200.
- The remaining System Full Access failure was not a sandbox downgrade. Agent
  persisted the user message first, then rebuilt the current model input from
  path-redacted history, so the model never received the authorized absolute
  target. Full-access turns now use the credential-redacted current prompt
  held in Main memory while persisted history continues to store
  `<local-path>`.
- A fresh real Grok Agent turn then created and read one harmless file outside
  its automatically provisioned `Documents\Codex` workspace. The model's
  `write_file` and `read_file` proposals both contained the exact absolute
  target; all three Responses rounds returned HTTP 200, both tools completed,
  the independent read matched the marker, and no approval event appeared.
  The diagnostic removed its task, marker, and temporary workspace afterward.

### Gemini Group Refresh Retest (Completed 2026-07-25)

- The real account returned seven groups and nine tokens after the older
  process stopped. Both sources contained the exact canonical id `Gemini cil`;
  do not normalize it to `gemini` or infer a provider from its spelling.
- The user-visible Chat menu showed all seven groups and `Gemini cil` exactly
  once. Selecting it completed the asynchronous catalog read and displayed
  three models. Chat and Agent catalog IPC returned the same three models,
  including native-Gemini `gemini-3.6-flash-high` with tool use.
- Previously dispatched real Chat and Agent turns were still complete, and an
  independent workspace read matched `GEMINI_AGENT_FILE_OK`. The four bounded
  acceptance tasks were then deleted successfully.
- The failure was a real HTTP 429 request burst, not a group alias bug. Main
  now merges and briefly caches account metadata, caches pricing, and cools
  down after a metadata 429; Renderer preserves token-backed groups across a
  temporary catalog failure and retries failed catalogs even when token
  metadata is unchanged.
- The focused Relay suite passed 43/43, the catalog/mode-group checks passed
  11/11, and typecheck passed. The check reused the sole running Electron
  instance and did not expose credentials, create a mock service, or build an
  installer.
