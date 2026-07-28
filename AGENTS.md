# AI Terminal Working Rules

These instructions are the entry point for future work in this repository.

## Project Authority

- `C:\Users\zz182\Desktop\AI-terminal-main` is the only product project.
- This directory has no `.git`. Do not switch to an old Studio, workspace
  stage, `main-link`, `project-link`, link directory, or another checkout as
  the source of truth. Those paths may be disposable diagnostics only; never
  edit or run the product from them.
- Read `docs/PROJECT_CONTEXT.md` once for stable contracts, then use the focused
  file/test row in `docs/MAINTENANCE.md`. Do not rescan the whole repository.
- Record durable protocol or architecture decisions in those documents instead
  of rediscovering them in later tasks.
- Read `docs/REAL_ACCOUNT_FIRST.md` for the online acceptance rules. Real
  account connectivity takes priority over mock, preview, smoke, and repeated
  security checks.

## Work Order

1. Check port `5173` and the matching Electron process, then attach to the one
   existing development instance.
2. Reproduce the user-visible failure against the signed-in real account and
   its remote NewAPI. This real connection is the first acceptance target.
3. Restore the requested behavior, then repeat the same real-account action.
4. After the live path works, run only the focused type, service, or UI check
   that covers the changed path.
5. Do not rerun the broad security suite, the full Playwright E2E suite, or the
   full Electron matrix unless the user explicitly requests that verification.

Mock servers, preview harnesses, seeded state, synthetic responses, local
models, and local image generation are never evidence that an online task is
complete. Prefer CDP attachment and narrowly scoped scripts for interaction
with the existing Electron window. Do not take over the user's mouse or
keyboard when the same check can be completed through CDP or an automated
script.

Before starting a development process, check port `5173` and matching Electron
processes. Never start a duplicate `npm run dev` instance.

## Product Contracts

- Chat, Agent, and Studio use only the signed-in account's real remote NewAPI.
  Do not add local models, local image generation, demo data in production, or
  silent fallback responses.
- Group membership comes from usable user-created tokens and the exact selected
  group's server catalog. Chat/Agent require a conversation endpoint; Studio
  requires `image-generation`.
- Model IDs are opaque. Endpoint routing and reasoning choices come only from
  bounded server metadata, never from model-name guesses.
- Image generation is tested only in Studio. Generation uses
  `/images/generations`; connected image editing uses `/images/edits`.
- Keep Chat/Agent/Studio switching at the upper left. Keep Studio's group picker
  beside Run, its account identity at the lower left, and its canvas dominant.
- Do not reintroduce explanatory UI labels such as "online", "NewAPI", or
  "online group" where the control or status already communicates the meaning.

## Agent Permissions

- Treat approval policy and workspace/process boundaries as separate controls.
- `request` asks for the exact operation; `auto` performs bounded reads and asks
  for writes/commands. Both modes remain inside the selected workspace.
- `full` means System Full Access: it skips ordinary prompts and removes the
  workspace filesystem/process boundary. The selected workspace remains the
  default cwd, Git target, and task binding, but absolute paths, parent
  traversal, explicit shells, and system executables are valid.
- Keep operation-type limits for Plan, Review, and read-only subagents. Keep
  cancellation, timeouts, bounded output, process-tree termination, and output
  redaction in every scope; do not reintroduce a path boundary in `full`.

## Essential Data Boundaries

- Never print, log, or expose complete API keys, refresh tokens, request bodies,
  private reasoning blocks, or absolute workspace paths.
- Renderer never receives real model credentials. Main owns network, storage,
  local files, and processes.
- Do not delete the whole `ai-terminal` user-data directory or its `secure`
  storage. Do not delete or move a computed path until its resolved absolute
  target has been checked.
- Preserve the shared redaction, bounded-output, timeout, cancellation, and
  process-tree termination paths while fixing functionality.
