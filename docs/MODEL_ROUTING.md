# Model Routing And Reasoning Contracts

Model IDs remain opaque for endpoint routing. Endpoint selection comes only
from bounded server metadata. Reasoning availability first follows bounded
remote model metadata, then a narrow official provider/model fallback when the
remote row publishes no reasoning declaration.

## Catalog Metadata

NewAPI's OpenAI-compatible model list publishes
`supported_endpoint_types`. AI-terminal preserves the declared order and uses
it as Chat's endpoint preference for Responses, Chat Completions, Anthropic
Messages, Gemini GenerateContent, or Images. Pricing metadata may narrow
endpoint capability but must not widen exact group membership.

Agent has a separate primary-endpoint projection. When pricing resolves a
model to exactly one xAI vendor and the model explicitly declares
`openai-response`, Agent selects `/v1/responses` even if the declaration lists
`openai` first. Remaining declared Agent endpoints stay available as ordered
fallbacks. This does not change `preferredChatEndpoint`: Chat continues to use
the server-declared order. Unknown or ambiguous vendors receive no override,
and model IDs are never inspected to infer provider identity.

The signed-in 2026-07-23 acceptance confirmed this exact split for
`grok-4.5`: Agent completed a Responses function call and
`function_call_output` continuation through `/v1/responses`, while Chat
completed independently through `/v1/chat/completions`. All observed requests
returned HTTP 200. The current relay accepted the standard Responses tool
fields, so no speculative xAI-wide request-field removal was added.

The current upstream NewAPI model object does not publish a standard per-model
reasoning-strength list. AI-terminal accepts bounded extension fields
such as `reasoning`, `reasoning_efforts`, `supported_reasoning_efforts`,
`supported_reasoning_levels`, and their camelCase or nested equivalents. A
nested declaration may be an array or a bounded schema object using `enum`,
`values`, `allowed_values`, `oneOf`, or `anyOf`. Anthropic
`output_config.effort` and Gemini `thinkingConfig.thinkingLevel` declarations
use the same projection. A scalar default such as `reasoning_effort: "high"`
is not a supported-values list and does not widen the UI. Codex v2-style level
objects such as `{ "reasoningEffort": "max", "description": "..." }` are
accepted; the description is display metadata and does not change the value.

Remote reasoning metadata is authoritative after endpoint/protocol projection.
If a remote row contains a recognized supported-values declaration that can be
projected onto the selected endpoint, its projected list wins even when it
normalizes to only `Auto`; the fallback registry never widens or replaces it.
For native provider thinking, projection also requires a matching explicit
`reasoning_protocol` (or bounded alias). An incomplete native declaration is
not treated as a usable protocol declaration.

When the remote row has no reasoning declaration, the relay catalog may apply
the fallback registry only if all of these are true:

- pricing resolves the model to exactly one recognized vendor using explicit
  `vendor_id`/vendor name metadata, or `owner_by` when no `vendor_id` exists;
- the model ID exactly matches a registry key; aliases, suffixes, and prefix
  matches do not qualify;
- the already server-selected preferred conversation endpoint is compatible
  with that profile.

The reasoning registry supplies reasoning values and, for native Anthropic/Gemini
profiles, the matching protocol. It never chooses an endpoint, widens group
membership, or turns an Images model into a conversation model. Unknown,
ambiguous, or endpoint-mismatched rows remain `Auto`.

## Official Fallback Registry

The current exact profiles are:

| Vendor | Exact model IDs | UI strengths added after `Auto` |
| --- | --- | --- |
| OpenAI | `gpt-5.6-sol`, `gpt-5.6-terra` | `Light`, `Medium`, `High`, `XHigh`, `Max`, `Ultra` |
| OpenAI | `gpt-5.6-luna` | `Light`, `Medium`, `High`, `XHigh`, `Max` |
| OpenAI | `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini` | `Light`, `Medium`, `High`, `XHigh` |
| Anthropic | `claude-opus-4-5`, `claude-opus-4-6`, `claude-sonnet-4-6` | `Light`, `Medium`, `High`, `Max` |
| Anthropic | `claude-opus-4-7`, `claude-opus-4-8`, `claude-fable-5`, `claude-sonnet-5` | `Light`, `Medium`, `High`, `XHigh`, `Max` |
| xAI | `grok-4.5` | `Light`, `Medium`, `High`, `XHigh` |
| Gemini | `gemini-3.1-pro-preview` | `Light`, `Medium`, `High` |
| Gemini | `gemini-3.1-flash-lite-image` | `Minimal`, `High` |
| Gemini | `gemini-3-flash-preview`, `gemini-3.5-flash` | `Minimal`, `Light`, `Medium`, `High` |
| Gemini | `gemini-3-pro-preview` | `Light`, `High` |
| Gemini | `gemini-2.5-pro` | `Light` = 1,024, `Medium` = 8,192, `High` = 32,768 thinking tokens |
| Gemini | `gemini-2.5-flash`, `gemini-2.5-flash-lite` | `None` = 0, `Light` = 1,024, `Medium` = 8,192, `High` = 24,576 thinking tokens |

These are fallback capabilities, not name-based routing rules. A compatible
remote declaration can publish a different bounded subset and always takes
precedence. OpenAI and xAI profiles apply only to server-selected
OpenAI-compatible Responses or Chat Completions endpoints; Anthropic profiles
inject `anthropic-adaptive`, Gemini 3 profiles inject `gemini-level`, and
Gemini 2.5 profiles inject their documented bounded `gemini-budget` maps.
`grok-4.20-multi-agent` advertises reasoning but no adjustable effort list, so
it remains `Auto` unless the remote row declares one.

## Wire Mapping

| Declared endpoint | Request field |
| --- | --- |
| OpenAI Responses | `reasoning.effort` |
| OpenAI Chat Completions | `reasoning_effort` |
| Anthropic adaptive | `thinking.type=adaptive` and `output_config.effort` |
| Anthropic budget | `thinking.type=enabled` and declared `budget_tokens` |
| Gemini level | `generationConfig.thinkingConfig.thinkingLevel` |
| Gemini budget | `generationConfig.thinkingConfig.thinkingBudget` |

UI `Light` maps to wire `low` for named protocols. `None` and `Minimal` remain
distinct and appear only when compatible remote metadata or an exact fallback
profile exposes them. Gemini 2.5 Flash profiles add `None` as the documented
zero-token budget; listed Gemini 3 profiles may add `Minimal`. Provider values
are matched case-insensitively; Gemini's
uppercase levels and a budget-map key named `low` normalize to the shared
`Minimal`/`Light`/`Medium`/`High` UI vocabulary. Budget values are never
invented client-side.

For native level/effort protocols, the projection is intentionally exact:

- The current official OpenAI effort set is exactly `none`, `minimal`, `low`,
  `medium`, `high`, `xhigh`, and `max`. Responses and Chat Completions accept
  the supported subset declared for the selected model or supplied by its exact
  fallback profile.
- Anthropic adaptive thinking accepts `low`, `medium`, `high`, `xhigh`, and
  `max` (subject to the model's declaration).
- Gemini `thinkingLevel` accepts only `MINIMAL`, `LOW`, `MEDIUM`, and `HIGH`.

NewAPI's generic request schema currently documents the conservative
`low`/`medium`/`high` subset. Richer values are exposed only by a bounded remote
declaration or by the exact vendor/model fallback above.

`Ultra` is a Codex product-level preset, not a public OpenAI API effort value.
For an OpenAI-compatible Responses or Chat Completions route, it is serialized
as `max`, matching Codex CLI's `reasoning_effort_for_request` projection.
Native Anthropic adaptive and Gemini level requests reject an incompatible
named effort before dispatch and never receive the literal string `ultra`. An
explicitly declared Anthropic or Gemini budget protocol may expose `Ultra`, but
the wire value is then only that declaration's bounded numeric token budget,
never the word `ultra` and never a client-invented value. A model row may list
several endpoint types: Chat projects reasoning only for its preferred
endpoint, while Agent retains the bounded native declaration and attaches it
only to the matching fallback candidate. This prevents an Anthropic thinking
object from being sent to an OpenAI Chat Completions request without discarding
it from a later declared Anthropic candidate.

## NewAPI Stream Compatibility

Transport selection remains independent from stream-shape compatibility.
NewAPI Chat Completions adapters may emit an empty interim `finish_reason`.
They may also emit empty tool `id` and function `name` strings on continuation
chunks after a valid first chunk established that tool call's identity. The
client treats only those bounded empty values as placeholders; an initial
empty identity, conflicting identity, unknown terminal reason, or malformed
tool arguments still fail closed. These rules do not add an undeclared
Responses fallback or route any provider by model name.

## Primary Sources

- NewAPI: <https://github.com/QuantumNous/new-api>
- OpenAI reasoning guide: <https://developers.openai.com/api/docs/guides/reasoning>
- OpenAI Responses API: <https://platform.openai.com/docs/api-reference/responses/create>
- Anthropic extended thinking: <https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking>
- Anthropic Messages API: <https://docs.anthropic.com/en/api/messages>
- xAI reasoning: <https://docs.x.ai/docs/guides/reasoning>
- Grok Build (native Responses Agent backend): <https://github.com/xai-org/grok-build>
- CC Switch (Responses provider routing): <https://github.com/farion1231/cc-switch>
- Gemini thinking: <https://ai.google.dev/gemini-api/docs/thinking>
- Gemini GenerateContent: <https://ai.google.dev/api/generate-content>

These sources define the wire fields and provider limits used to version the
registry. The project must update exact model entries as provider catalogs
change. A usable remote model declaration remains the first authority for
strengths; the exact fallback is used only when that projection is absent.
