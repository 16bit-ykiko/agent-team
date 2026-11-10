---
name: add-model
description: Add or rename a Claude, Codex or Cursor model in agent-team — presets entry, verifying the binary the server actually runs supports it, SDK/CLI bumps, smoke tests. Read BEFORE editing service/src/config/presets.ts.
---

# Adding a model

`MODEL_OPTIONS` in `service/src/config/presets.ts` only populates the picker. Whether the model _works_ depends on the binary the server spawns (Claude, Codex: they resolve it in opposite ways) or on the account's catalog (Cursor). The first two have burned a deploy before: the option appeared and every session failed.

## Claude

The server runs the SDK's bundled binary, **not** the pixi/system `claude`:

```bash
grep -hoaE "claude-(fable|opus|sonnet|haiku)-[0-9a-z-]+" \
  node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude | sort -u
```

If the id is missing: `npm install @anthropic-ai/claude-agent-sdk@latest -w service`. CLI and SDK move in lockstep on the patch number (CLI 2.1.x ↔ SDK 0.3.x), so the system CLI's version hints what to bump _to_ — never what is supported now. The SDK is `external` in `service/esbuild.mjs`, so the new version is picked up at runtime after a restart (deploy skill).

Smoke test through the same path the server uses:

```bash
npm run smoke:claude -- claude-fable-5-2 high     # prints init model/effort + PONG
```

Then the preset: id, label, `backend: "claude"`, `defaultEffort`, whether it `supportsFastMode` (only models the SDK reports `fast_mode_state` for). Effort levels come from the picker; check `defaultEffortForModel`.

## Codex

The server runs the native binary of the `@openai/codex` version pinned in `service/package.json` (`codexBinary()` in `service/src/session/codex-rpc.ts`), never a `codex` on PATH: the app-server protocol is experimental and changes with the binary. A model the pinned binary does not know needs a bump there:

```bash
npm install -w service --save-exact @openai/codex@<version>
npm run smoke:codex -- <slug>                       # prints the binary and its version, then PONG
```

A bump re-records the codex snap fixtures (capture-sdk skill) and checks the protocol types in `codex-rpc.ts` against `codex app-server generate-ts --experimental --out <dir>`.

Codex has a machine-readable list Claude lacks: `~/.codex/models_cache.json` (refreshed by the CLI). Each entry has `slug`, `display_name`, `default_reasoning_level`, `supported_reasoning_levels`, `visibility`; only `visibility: "list"` entries belong in the picker, and `client_version` tells you which CLI version the account is served.

Smoke test:

```bash
npm run smoke:codex -- gpt-6-astra high            # binary path/version + PONG, through CodexSession
```

Preset fields for Codex: `codexModelId` strips the `[1m]` suffix; `[1m]` variants set `contextWindow: 872_000` and are passed as `model_context_window`; `fastTier: "priority"` backs `/fast`.

## Cursor

No binary: `@cursor/sdk` runs the agent loop in the server, and what a model takes comes from the account's catalog. Reading it is one API call, not a session (behind the proxy, `NODE_USE_ENV_PROXY=1`):

```bash
NODE_USE_ENV_PROXY=1 CURSOR_API_KEY="$(cat ~/.cursor/api_key.txt)" node --input-type=module -e '
import { Cursor } from "@cursor/sdk";
for (const m of await Cursor.models.list()) console.log(m.id, JSON.stringify(m.parameters), JSON.stringify(m.variants?.find((v) => v.isDefault)));'
```

The preset: id `cursor/<catalog id>` (the catalog shares Claude and GPT ids, the prefix is the backend), `backend: "cursor"`, `cursorParams.effort` = the id of the model's effort parameter (`effort`, `reasoning_effort`, `reasoning`, ... per model), `effortLevels` = its values, `defaultEffort` = the default variant's value, `cursorParams.fast` when it has a `fast` parameter. `cursorModel()` sends effort (or the default) and fast with every run: a parameter left out runs at its _first_ value, not the default variant's. Only Cursor's own models are listed (the user's call: Claude and GPT run through their own backends).

Smoke test, one real session through `CursorSession`, panel tools included:

```bash
npm run smoke:cursor -- cursor/grok-4.7 high       # events, report_progress call, usage
```

## Retiring a model

The picker lists only current models. A model dropped from `MODEL_OPTIONS` moves to `LEGACY_MODELS` (same file): agents still on it keep their effort levels and thinking settings, and move with `/model <id>` (or the model menu in the Agents panel) — the session resumes on the new model with its history. An id in neither list is treated as a newer Claude model (fast mode, adaptive thinking), a `cursor/` one as a Cursor model without parameters, so a just-released model can be tried with `/model` before its preset exists; the CLI rejects ids it does not know on the next turn.

## Tests

`service/tests/unit/presets.test.ts` covers the helper functions (`backendForModel`, `codexModelId`, `codexContextWindow`, `supportsFastMode`, `defaultEffortForModel`); `cursor-session.test.ts` covers `cursorModel`. Add the new id to whichever cases enumerate models. Restart is a separate, user-approved step (deploy skill).
