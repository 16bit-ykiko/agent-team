---
name: add-model
description: Add or rename a Claude or Codex model in agent-team — presets entry, verifying the binary the server actually runs supports it, SDK/CLI bumps, smoke tests. Read BEFORE editing service/src/presets.ts.
---

# Adding a model

`MODEL_OPTIONS` in `service/src/presets.ts` only populates the picker. Whether the model _works_ depends on the binary the server spawns, and the two backends resolve it in opposite ways. Both have burned a deploy before: the option appeared and every session failed.

## Claude

The server runs the SDK's bundled binary, **not** the pixi/system `claude`:

```bash
grep -hoaE "claude-(fable|opus|sonnet|haiku)-[0-9a-z-]+" \
  node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude | sort -u
```

If the id is missing: `npm install @anthropic-ai/claude-agent-sdk@latest -w service`. CLI and SDK move in lockstep on the patch number (CLI 2.1.x ↔ SDK 0.3.x), so the system CLI's version hints what to bump _to_ — never what is supported now. The SDK is `external` in `service/esbuild.mjs`, so the new version is picked up at runtime after a restart (deploy skill).

Smoke test through the same path the server uses:

```bash
node scripts/smoke-claude.ts claude-fable-5-1 high     # prints init model/effort + PONG
```

Then the preset: id, label, `backend: "claude"`, `defaultEffort`, whether it `supportsFastMode` (only models the SDK reports `fast_mode_state` for). Effort levels come from the picker; check `defaultEffortForModel`.

## Codex

`getCodexBin()` in `service/src/codex-session.ts` tries `which codex` **first**, so the system CLI (`~/.pixi/envs/nodejs/bin/codex`) runs; the `@openai/codex-*` binaries under `node_modules` are never executed. Bump the CLI, not (only) the workspace SDK:

```bash
~/.pixi/envs/nodejs/bin/npm install -g @openai/codex@latest
codex --version
grep -ac gpt-6-astra "$(readlink -f "$(which codex)")"   # slug present in the binary?
```

Keep `@openai/codex-sdk` in `service/package.json` on the same version anyway — it supplies `ThreadOptions` types.

Codex has a machine-readable list Claude lacks: `~/.codex/models_cache.json` (refreshed by the CLI). Each entry has `slug`, `display_name`, `default_reasoning_level`, `supported_reasoning_levels`, `visibility`; only `visibility: "list"` entries belong in the picker, and `client_version` tells you which CLI version the account is served.

Smoke test:

```bash
node scripts/smoke-codex.ts gpt-6-astra high            # prints binary path/version + PONG
```

Preset fields for Codex: `codexModelId` strips the `[1m]` suffix; `[1m]` variants set `contextWindow: 872_000` and are passed as `model_context_window`; `fastTier: "priority"` backs `/fast`.

## Tests

`service/tests/presets.test.ts` covers the helper functions (`backendForModel`, `codexModelId`, `codexContextWindow`, `supportsFastMode`, `defaultEffortForModel`). Add the new id to whichever cases enumerate models. Restart is a separate, user-approved step (deploy skill).
