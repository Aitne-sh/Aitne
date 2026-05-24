import type { Context } from "hono";
import type Database from "better-sqlite3";
import {
  INTEGRATION_DESCRIPTORS,
  filterDeniedToolsForBackend,
  integrationPatchSchema,
  isIntegrationKey,
  recommendedStarterDeniedTools,
  supportedNativeBackends,
  validateDeniedTools,
  type BackendId,
  type IntegrationKey,
} from "@aitne/shared";
import {
  readIntegrations,
  updateIntegrationState,
} from "../../../db/integrations-store.js";
import { writeManagementMd } from "../../../core/management-md.js";
import {
  missingDelegatedVariants,
  missingNativeVariants,
} from "../../../core/skills-compiler-variants.js";
import {
  acquireIntegrationFlipLock,
  releaseIntegrationFlipLock,
} from "../../../core/integration-lifecycle.js";
import { readMainBackend } from "../../../core/integration-main-backend.js";
import {
  deleteProbesForIntegration,
  readProbe,
} from "../../../db/integration-probe-store.js";
import {
  knownProxyModels,
  proxyModelIsKnown,
} from "../../../core/backends/proxy-model-registry.js";
import { readJsonBody } from "../../json-body.js";
import { createLogger } from "../../../logging.js";
import { composeIssue, respondWithAgentError } from "../../helpers/agent-errors.js";
import { createSettingsStore } from "../../../settings/settings-store.js";
import type { ApiDependencies } from "../../server.js";

const logger = createLogger("integrations-api");

/**
 * `PATCH /api/integrations/:key` handler body.
 *
 * Extracted from the original `routes/integrations.ts` createIntegrationRoutes
 * factory so the surrounding `crud.ts` stays under the ~800 line soft
 * ceiling. Behavior is byte-identical to the pre-split inline closure.
 *
 * Lifecycle (mirrors `docs/design/14-integration-delegation.md` §14.6):
 *   validate → flip-lock acquire → mode-specific gates (native, delegated,
 *   delegatedModel, deniedTools) → DB update → `integrations.md` re-render →
 *   probe-cache eviction → running-session re-materialisation →
 *   audit → flip-lock release.
 */
export async function handleIntegrationPatch(
  c: Context,
  deps: ApiDependencies,
): Promise<Response> {
  const { db, config } = deps;
  // `c.req.param("key")` is typed `string` inside an `app.patch("/:key", ...)`
  // closure but widens to `string | undefined` when the handler is extracted
  // into a free function with a generic `Context`. The route registration in
  // `./crud.ts` guarantees presence; the `undefined` branch is impossible
  // at runtime, so we fold it into the unknown_integration 404 to keep
  // behavior byte-identical to the pre-split inline closure.
  const key = c.req.param("key");
  if (key === undefined || !isIntegrationKey(key)) {
    return respondWithAgentError(c, 404, [
      composeIssue("integrations.unknown_integration", {
        field: "key",
        received: key,
      }),
    ], { legacyFields: { key } });
  }

  const parsedBody = await readJsonBody(c);
  if (!parsedBody.ok) return parsedBody.response;

  const parsed = integrationPatchSchema.safeParse(parsedBody.body);
  if (!parsed.success) {
    return c.json(
      {
        error: "validation_error",
        issues: parsed.error.issues.map((i) => ({
          path: i.path,
          message: i.message,
        })),
      },
      400,
    );
  }

  const descriptor = INTEGRATION_DESCRIPTORS[key];
  if (!descriptor.supportedModes.includes(parsed.data.mode)) {
    return c.json(
      {
        error: "unsupported_mode",
        key,
        mode: parsed.data.mode,
        supportedModes: descriptor.supportedModes,
      },
      400,
    );
  }

  const previous = readIntegrations(db)[key];

  // Compute the side-effect-relevant flags up-front:
  //  - modeChanged: probe-cache eviction + lifecycle observer flip + variants
  //    gate all key off this. A pure deniedTools edit must NOT trigger any of
  //    them — those are mode-change concerns.
  //  - effectiveBackend: which backend the post-PATCH state will run against
  //    in `delegated` mode. Used for both the missing-variants gate and the
  //    deniedTools validator. If the user omits delegatedBackend on a
  //    delegated→delegated edit (e.g. just toggling tool permissions), we
  //    keep the previous backend.
  //  - effectiveNativeBackend: same shape for `native` mode
  //    (INTEGRATION_NATIVE_MODE_DESIGN.md §11.2). Validated against the
  //    current main backend below.
  const modeChanged =
    parsed.data.mode !== previous.mode
    || (parsed.data.delegatedBackend ?? null) !==
      (previous.delegatedBackend ?? null)
    || (parsed.data.nativeBackend ?? null) !==
      (previous.nativeBackend ?? null);
  const effectiveBackend: BackendId | null =
    parsed.data.mode === "delegated"
      ? (parsed.data.delegatedBackend ?? previous.delegatedBackend ?? null)
      : null;
  const effectiveNativeBackend: BackendId | null =
    parsed.data.mode === "native"
      ? (parsed.data.nativeBackend ?? previous.nativeBackend ?? null)
      : null;

  // INTEGRATION_NATIVE_MODE_DESIGN.md §11.2 — `native` mode validation.
  // Runs BEFORE the delegated-mode validation block because native and
  // delegated are mutually exclusive: a single PATCH cannot ask for both.
  // The schema's `superRefine` already rejects co-occurring fields, but
  // the explicit branch here surfaces a clearer error and runs the live
  // probe + variant-file gate.
  if (parsed.data.mode === "native") {
    if (!effectiveNativeBackend) {
      return c.json(
        {
          error: "validation_error",
          issues: [
            {
              path: ["nativeBackend"],
              message: "nativeBackend is required when mode is 'native'",
            },
          ],
        },
        400,
      );
    }

    const supported = supportedNativeBackends(key);
    if (!supported.includes(effectiveNativeBackend)) {
      // Descriptor-driven integrations only — user-managed descriptors
      // pass automatically because `supportedNativeBackends` returns
      // every registered backend for them (INTEGRATION_NATIVE_MODE_DESIGN.md
      // §5.3 2026-05 amendment).
      return c.json(
        {
          error: "backend_not_supported_native",
          key,
          backend: effectiveNativeBackend,
          supportedNativeBackends: supported,
          message: `Backend '${effectiveNativeBackend}' has no native connector for '${key}'. Native mode for this integration is offered only on backends that ship a registry connector.`,
        },
        400,
      );
    }

    // §3.3 invariant: native binds to the main backend. The setup wizard
    // will hide the Native option entirely when the main backend doesn't
    // appear in `supportedNativeBackends(key)`; this check is the API-
    // layer defense against an out-of-band PATCH (CLI / curl).
    const mainBackend = readMainBackend(db);
    if (mainBackend !== null && effectiveNativeBackend !== mainBackend) {
      return c.json(
        {
          error: "native_backend_mismatches_main",
          key,
          nativeBackend: effectiveNativeBackend,
          mainBackend,
          message: `Native mode binds to the main backend (${mainBackend}); refusing to set nativeBackend='${effectiveNativeBackend}'. Switch the main backend first (PUT /api/backends/main) or pick a different mode.`,
        },
        400,
      );
    }

    // §7.4 / §8.5 missing-variant gate. Only re-runs when this is an
    // actual mode/binding change (a pure annotation PATCH on an already-
    // native row leaves the variant set unchanged).
    //
    // User-managed connector integrations (e.g. Outlook) skip the
    // descriptor-driven variant check — there is no daemon-shipped
    // `SKILL.native.<backend>.md` for them. The user's MCP / skill
    // harness on their backend is the authority, mirroring the
    // delegated-mode path above. §5.3 (2026-05 amendment).
    if (modeChanged && !descriptor.userManagedConnector) {
      const missing = missingNativeVariants(
        config.workspaceDir,
        key,
        effectiveNativeBackend,
      );
      if (missing.skills.length > 0 || missing.taskFlows.length > 0) {
        return c.json(
          {
            error: "missing_variants",
            key,
            backend: effectiveNativeBackend,
            mode: "native",
            missingSkills: missing.skills,
            missingTaskFlows: missing.taskFlows,
            message: `Cannot enter native mode for '${key}' on backend '${effectiveNativeBackend}' — ${missing.skills.length + missing.taskFlows.length} variant file(s) missing. Phase B1 stubs every supported native variant; rebuild the package if your tree is stale.`,
          },
          400,
        );
      }
    }
  }

  if (parsed.data.mode === "delegated") {
    if (!effectiveBackend) {
      return c.json(
        {
          error: "validation_error",
          issues: [{
            path: ["delegatedBackend"],
            message: "delegatedBackend is required when mode is 'delegated'",
          }],
        },
        400,
      );
    }
    // User-managed connector integrations (e.g. Outlook) skip the
    // descriptor-driven connector check and the variant gate: the user
    // installs an Outlook / Microsoft Graph MCP on their selected
    // backend (Claude Code Connector / Codex MCP / Gemini extension)
    // and the daemon trusts that wiring. Capability probing is the
    // user's responsibility on the backend side.
    if (!descriptor.userManagedConnector) {
      if (!descriptor.backendConnectors[effectiveBackend]) {
        return c.json(
          {
            error: "backend_not_supported",
            key,
            backend: effectiveBackend,
            availableBackends: Object.keys(descriptor.backendConnectors),
          },
          400,
        );
      }

      // §4.7 "Missing-variant policy" — only re-run the gate when the user
      // is actually changing mode or backend. A pure deniedTools edit on an
      // already-delegated integration leaves the variant set unchanged, so
      // re-walking the file system would be wasted work AND would surface a
      // stale-during-author error if a variant was momentarily missing.
      //
      // DELEGATED-MODE-V2-DESIGN.md §11 (Phase 3) re-activated the
      // legacy variant gate for every delegated integration. gmail and
      // google_calendar now ship `SKILL.delegated.<sessionBackend>.md`
      // (cross-backend) and resolve to `null` for same-backend, so
      // missing variants are a real configuration error.
      if (modeChanged) {
        const missing = missingDelegatedVariants(
          config.workspaceDir,
          key,
          effectiveBackend,
        );
        if (missing.skills.length > 0 || missing.taskFlows.length > 0) {
          return c.json(
            {
              error: "missing_variants",
              key,
              backend: effectiveBackend,
              missingSkills: missing.skills,
              missingTaskFlows: missing.taskFlows,
              message:
                `Cannot enter delegated mode for '${key}' on backend '${effectiveBackend}' — ${missing.skills.length + missing.taskFlows.length} variant file(s) missing. Author the listed files or narrow the registry's skillsTouched / taskFlowsTouched before retrying.`,
            },
            400,
          );
        }
      }
    }
  }

  // DELEGATED-PROXY-API-DESIGN.md §6.1 — `delegatedModel` validation.
  // The schema rejects empty strings already; here we additionally
  // reject values that don't appear in the registered model list for
  // the effective backend (or in user-pinned `process_backend_config`
  // rows for the same backend, per §4.2's "trust custom pins" rule).
  // The value is *allowed* on any mode so the user can pre-stage a pin
  // before flipping to delegated; validation only runs when we have a
  // backend to validate against.
  if (
    parsed.data.delegatedModel !== undefined
    && parsed.data.delegatedModel !== null
    && effectiveBackend
  ) {
    const candidate = parsed.data.delegatedModel;
    if (!proxyModelIsKnown(db, effectiveBackend, candidate)) {
      return c.json(
        {
          error: "unknown_model",
          key,
          backend: effectiveBackend,
          model: candidate,
          knownModels: knownProxyModels(db, effectiveBackend),
          message: `Model '${candidate}' is not registered for backend '${effectiveBackend}'. Pick one of the known models or pass null to use the canonical light-tier default.`,
        },
        400,
      );
    }
  }

  // §7.7 — `deniedTools` validation. We accept the field on any mode so
  // the user can pre-stage a deny list before flipping to delegated, but
  // validation only runs against the effective backend when one exists.
  // For non-delegated modes, deniedTools persists as-is (no live backend
  // to validate against — the value is inert until delegated).
  //
  // DELEGATED-MODE-V2-DESIGN.md §4.5.4 — first-time delegated setup
  // pre-populates `deniedTools` with the recommended starter list when
  // the caller didn't supply one (PATCH omits the field). This keeps the
  // CLAUDE.md "destructive ops require user confirmation" invariant
  // intact on a fresh install. The user opts out explicitly by passing
  // `deniedTools: []` (empty array, distinct from undefined).
  //
  // The starter floor fires in two distinct shapes — both arrive at an
  // effectively-empty deny set after the PATCH and would otherwise leave
  // the agent unconstrained:
  //
  //   (a) Entering delegated mode for the first time on this integration
  //       (previous mode was direct/disabled) AND no curated list was
  //       already pre-staged — re-entry from disabled with prior denies
  //       kept means the user already curated, don't overwrite.
  //
  //   (b) Backend swap (delegated → delegated, different `delegatedBackend`)
  //       where every entry in `previous.deniedTools` is namespace-stale on
  //       the new backend. The user's curation referenced tools the new
  //       connector doesn't expose (e.g. Claude's `label_message` carried
  //       into a Codex session), so the materializer's stale-drop pass
  //       would empty the disallowedTools array silently — closing the
  //       same §4.5.4 floor the design wrote (a) to defend. The original
  //       design framed §4.5.4 as "first delegated setup only" and missed
  //       this case; surfaced during the 2026-04-26 implementation review.
  //
  // The wizard UI for the opt-out / "use recommended" / "I'll edit"
  // branches is Phase 4 polish (see §Phase 4.2). For now the API default
  // closes the safety floor; the dashboard editor card surfaces the
  // populated list for editing.
  const enteringDelegated =
    parsed.data.mode === "delegated" && previous.mode !== "delegated";
  const omittedDeniedTools = parsed.data.deniedTools === undefined;
  const previousDeniedToolsEmpty = (previous.deniedTools ?? []).length === 0;
  const swappingDelegatedBackend =
    parsed.data.mode === "delegated"
    && previous.mode === "delegated"
    && effectiveBackend !== null
    && previous.delegatedBackend !== undefined
    && previous.delegatedBackend !== effectiveBackend;
  // For shape (b): the previous list had at least one entry (otherwise the
  // floor was already empty and shape (a)'s logic doesn't apply here either),
  // and *every* entry is stale on the new backend.
  const swapWipesAllDenies =
    swappingDelegatedBackend
    && (previous.deniedTools ?? []).length > 0
    && filterDeniedToolsForBackend(
         key,
         effectiveBackend!,
         /* c8 ignore next -- ?? [] unreachable: length > 0 guard above ensures non-empty array */
         previous.deniedTools ?? [],
       ).active.length === 0;
  const useStarter =
    effectiveBackend !== null
    && omittedDeniedTools
    && (
      (enteringDelegated && previousDeniedToolsEmpty)
      || swapWipesAllDenies
    );
  const finalDeniedTools = useStarter
    ? recommendedStarterDeniedTools(key, effectiveBackend!)
    : parsed.data.deniedTools !== undefined
      ? parsed.data.deniedTools
      : (previous.deniedTools ?? []);
  if (useStarter && finalDeniedTools.length > 0) {
    logger.info(
      {
        key,
        backend: effectiveBackend,
        starter: finalDeniedTools,
        // Distinguish the two shapes so log readers can spot the
        // backend-swap fallback separately from first-time setup.
        // `enteringDelegated` covers shape (a); `swapWipesAllDenies`
        // covers shape (b). They are mutually exclusive by construction
        // (a requires `previous.mode !== "delegated"`, b requires
        // `previous.mode === "delegated"`).
        trigger: enteringDelegated ? "first_delegated" : "backend_swap_stale",
        previousBackend: swappingDelegatedBackend
          ? previous.delegatedBackend
          : null,
      },
      "applied starter deniedTools floor",
    );
  }

  if (effectiveBackend && parsed.data.deniedTools !== undefined) {
    const result = validateDeniedTools(
      key,
      effectiveBackend,
      finalDeniedTools,
    );
    if (!result.ok) {
      if (result.error === "unknown_tool") {
        return c.json(
          {
            error: "unknown_tool",
            key,
            backend: effectiveBackend,
            tool: result.tool,
            knownTools: result.knownTools,
            message: `Tool '${result.tool}' is not declared in the ${effectiveBackend} connector for '${key}'. Pick a tool from the descriptor's capability list.`,
          },
          400,
        );
      }
      if (result.error === "denial_breaks_required_capability") {
        return c.json(
          {
            error: "denial_breaks_required_capability",
            key,
            backend: effectiveBackend,
            capability: result.capability,
            remainingTools: result.remainingTools,
            message: `Denying these tools removes the only path for required capability '${result.capability}'. Keep at least one of: ${result.remainingTools.join(", ")}.`,
          },
          400,
        );
      }
      // "no_connector" should be unreachable — we already validated
      // `descriptor.backendConnectors[effectiveBackend]` above. Map to a
      // 500 rather than a 400 because it indicates a server-side mismatch.
      return respondWithAgentError(c, 500, [
        composeIssue("integrations.internal_error", {
          field: "<server>",
          received: "<connector_mismatch>",
        }),
      ]);
    }
  }

  // DELEGATED-PROXY-API-DESIGN.md §4.2 — `delegatedModel` carry-over
  // rules:
  //   - PATCH omits the field → preserve previous value (mode-flip
  //     idempotent: direct ↔ delegated keeps the pin).
  //   - PATCH passes `null` → clear the pin (canonical fallback at
  //     call time). Surfaced by the dashboard's "Reset to default"
  //     affordance after a backend swap.
  //   - PATCH passes a non-empty string → validated above and stored.
  // Same shape for `delegatedMaxTurns` (forward-compat — no UI yet).
  const finalDelegatedModel =
    parsed.data.delegatedModel === undefined
      ? (previous.delegatedModel ?? null)
      : parsed.data.delegatedModel;
  const finalDelegatedMaxTurns =
    parsed.data.delegatedMaxTurns === undefined
      ? (previous.delegatedMaxTurns ?? null)
      : parsed.data.delegatedMaxTurns;
  const finalDelegatedSyncEnabled =
    parsed.data.delegatedSyncEnabled === undefined
      ? previous.delegatedSyncEnabled
      : parsed.data.delegatedSyncEnabled;
  // INTEGRATION_NATIVE_MODE_DESIGN.md §19.4 — mirror of the delegated
  // collapse: PATCH omits → preserve previous; PATCH passes a boolean
  // → store. Accepted in any mode so the operator can pre-stage the
  // setting before flipping `mode = "native"`.
  const finalNativeSyncEnabled =
    parsed.data.nativeSyncEnabled === undefined
      ? previous.nativeSyncEnabled
      : parsed.data.nativeSyncEnabled;

  // §14.7 — synchronously consult the cached probe before committing a
  // mode flip to delegated/native. Per §14.7 the PATCH response path
  // intentionally never spawns a live probe ("no blocking subprocess");
  // POST /api/integrations/:key/probe and the DelegatedProbeObserver own
  // the live-probe cost. But when the user (or the wizard) HAS recently
  // probed and the cached row shows missing required capabilities,
  // committing the mode flip would only surface as a runtime "tool not
  // found" at the next dispatch — bad UX with no actionable signal.
  // Refusing here turns an opaque downstream failure into a 400 with
  // the missing capabilities listed. When no cached row exists
  // (post-eviction or never-probed) we fall through, mirroring the
  // /health POC-default fallback — the wizard / dashboard is expected
  // to probe first; CLI / curl callers accept the runtime feedback
  // path. User-managed connectors (Outlook) are exempt: their probes
  // are synthesised via makeUserManagedProbeResult with present=true,
  // so a cached row from a prior live probe is always
  // capability-trivial.
  if (
    modeChanged
    && (parsed.data.mode === "delegated" || parsed.data.mode === "native")
    && !descriptor.userManagedConnector
  ) {
    const targetBackend = parsed.data.mode === "delegated"
      ? effectiveBackend
      : effectiveNativeBackend;
    if (targetBackend) {
      const cached = readProbe(db, key, targetBackend);
      if (cached !== null && !cached.present) {
        return c.json(
          {
            error: "probe_missing_required_capabilities",
            key,
            backend: targetBackend,
            mode: parsed.data.mode,
            missingRequired: cached.missingRequired,
            probedAt: cached.probedAt,
            message:
              `Cannot enter ${parsed.data.mode} mode for '${key}' on backend `
              + `'${targetBackend}' — last probe (${cached.probedAt}) found `
              + `missing required capabilities: ${cached.missingRequired.join(", ")}. `
              + `Restore the connector and re-run POST /api/integrations/${key}/probe.`,
          },
          400,
        );
      }
    }
  }

  const stamped = new Date().toISOString();

  // INTEGRATION_NATIVE_MODE_DESIGN.md §11.3.1 — flip-lock orchestration.
  // Only acquired when the mode or a backend binding is changing; pure
  // annotation edits (deniedTools / delegatedModel) on an already-correct
  // row don't need the lock because no observer / worker / session needs
  // to drain. A concurrent flip on the same key (parallel PATCH from
  // CLI + dashboard) is rejected with 409.
  let flipLockHeld = false;
  if (modeChanged) {
    const acquire = acquireIntegrationFlipLock(db, key);
    if (!acquire.ok) {
      // §11.3.1 — concurrent flip on the same key. The expected hold
      // window is short (probe + drain are both bounded by the 5s
      // tick boundary), so signal the retry interval explicitly via
      // `Retry-After`. Standards-compliant clients (and the dashboard's
      // mode-dialog) honor this; the message body keeps the hold
      // metadata for forensics.
      c.header("Retry-After", "5");
      return c.json(
        {
          error: "integration_flip_in_progress",
          key,
          heldBy: acquire.current,
          retryAfterSeconds: 5,
          message: `A mode flip for '${key}' is already in progress (acquired ${acquire.current.acquiredAt} by pid ${acquire.current.processId}). Retry in a few seconds.`,
        },
        409,
      );
    }
    flipLockHeld = true;
  }

  try {
    const next = updateIntegrationState(db, key, {
      mode: parsed.data.mode,
      // Only carry delegatedBackend when mode is delegated. The schema
      // already enforces presence in that branch (superRefine), so a
      // direct/disabled flip drops it cleanly. Don't fall back to the
      // previous value here — that breaks the delegated → direct path
      // (the integration would keep its old backend forever).
      ...(parsed.data.mode === "delegated" && parsed.data.delegatedBackend
        ? { delegatedBackend: parsed.data.delegatedBackend }
        : {}),
      // INTEGRATION_NATIVE_MODE_DESIGN.md §5.2 — same shape for the
      // nativeBackend column. Schema's `superRefine` enforces mutual
      // exclusion with `delegatedBackend`.
      ...(parsed.data.mode === "native" && effectiveNativeBackend
        ? { nativeBackend: effectiveNativeBackend }
        : {}),
      // Always persist the resolved delegatedModel/delegatedMaxTurns —
      // null clears, undefined was already collapsed above to the
      // previous value or null. Keeps the JSON blob shape stable
      // across PATCHes even when the field is inert (mode !== delegated).
      ...(finalDelegatedModel !== null
        ? { delegatedModel: finalDelegatedModel }
        : {}),
      ...(finalDelegatedMaxTurns !== null
        ? { delegatedMaxTurns: finalDelegatedMaxTurns }
        : {}),
      ...(finalDelegatedSyncEnabled === false
        ? { delegatedSyncEnabled: false }
        : {}),
      ...(finalNativeSyncEnabled === false
        ? { nativeSyncEnabled: false }
        : {}),
      deniedTools: finalDeniedTools,
      lastChangedAt: stamped,
    });

    await writeManagementMd(config.dataDir, next, {
      externalObsidianVaultPath: config.externalObsidianVaultPath,
      externalObsidianWatch: config.externalObsidianWatch,
    });

    // §4.11 probe-cache eviction is a *mode-change* concern. A pure
    // deniedTools edit doesn't invalidate which capabilities the
    // connector exposes — the live probe answer is identical, only what
    // the agent is allowed to invoke from the skill body changes. So
    // gate eviction on modeChanged.
    if (modeChanged) {
      const cleared = deleteProbesForIntegration(db, key);
      if (cleared > 0) {
        logger.info(
          { key, cleared },
          "cleared stale probe cache after integration mode change",
        );
      }
    }

    // DELEGATED-MODE-V2-DESIGN.md §4.4 #2 — a deniedTools-only edit must
    // also re-materialize active DM workdirs, since the per-session
    // `disallowedTools` array (Claude SDK), admin-policy TOML (Gemini),
    // and AGENTS.md prose block (Codex) are derived from `state.deniedTools`
    // at materialization time. A stale workdir would leak the old policy
    // into the next turn. We compute the policy diff up front so we can
    // gate the lifecycle callback on it.
    const policyDiff = diffDeniedTools(
      previous.deniedTools ?? [],
      next[key].deniedTools ?? [],
    );
    const policyChanged =
      policyDiff.added.length > 0 || policyDiff.removed.length > 0;
    // Only `delegatedSyncEnabled` gates an observer-lifecycle
    // re-evaluation — the predicate
    // (`hasActiveDelegatedSyncIntegration`) ignores `nativeSyncEnabled`
    // because the worker has no role in native mode (see appendix
    // §"Polling, observers, and the hourly-check threshold"). The
    // `nativeSyncEnabled` field is retained on the state row for
    // schema compatibility but toggling it is inert today.
    const syncChanged =
      (previous.delegatedSyncEnabled ?? true)
      !== (next[key].delegatedSyncEnabled ?? true);

    // §4.10 lifecycle step 4 — observer flip side of the callback is
    // gated on `wasDirect !== isDirect` inside `applyIntegrationModeChange`,
    // so calling it on a deniedTools-only edit is safe: observer
    // start/stop is a no-op, only `rematerializeDmSessions` fires.
    if ((modeChanged || policyChanged || syncChanged) && deps.onIntegrationModeChange) {
      void Promise.resolve()
        .then(() => deps.onIntegrationModeChange?.(key, previous, next[key]))
        .catch((err) => {
          logger.error(
            { err, key },
            "integration mode-change side-effects failed — DB state already updated",
          );
        });
    }

    // §7.7 audit. Two distinct action types so log readers can filter:
    //  - integration.mode_change: mode or delegatedBackend moved
    //  - integration.policy_change: deniedTools diff (with no mode flip)
    // Both can fire on a single PATCH when the user changes mode AND
    // deniedTools simultaneously — that's intentional, the diff is at
    // different granularities.
    if (modeChanged) {
      recordAuditModeChange(db, key, previous, next[key]);
    }
    if (policyChanged) {
      recordAuditPolicyChange(db, key, policyDiff);
    }

    logger.info(
      {
        key,
        from: previous.mode,
        to: next[key].mode,
        delegatedBackend: next[key].delegatedBackend,
        nativeBackend: next[key].nativeBackend,
        delegatedModelFrom: previous.delegatedModel ?? null,
        delegatedModelTo: next[key].delegatedModel ?? null,
        deniedToolsAdded: policyDiff.added,
        deniedToolsRemoved: policyDiff.removed,
      },
      modeChanged
        ? "integration mode updated"
        : "integration policy updated (deniedTools / delegatedModel)",
    );

    // Auto-enable the global task-mode flag the first time *any*
    // integration enters delegated mode. Rationale:
    //   - The legacy `/integrations/:key/invoke` RPC is dead (commented
    //     out 2026-05-01 in this same file); every delegated skill body
    //     and task flow now talks to `/exec`.
    //   - `/exec` is gated by `delegatedTaskModeEnabled`, originally a
    //     Phase-1 canary that defaults `false`. With `/invoke` gone,
    //     "delegated mode + task mode off" is a degenerate state with
    //     no productive use — the agent calls `/exec`, gets 503,
    //     fails. So flipping an integration to delegated *is* the
    //     enablement signal.
    //   - We only flip on the transition into delegated, not on every
    //     PATCH against an already-delegated integration. A pure
    //     deniedTools edit must not silently re-enable a flag the
    //     operator manually toggled off; emergency-disable is the
    //     flag's remaining role.
    const enteringDelegated =
      next[key].mode === "delegated" && previous.mode !== "delegated";
    if (enteringDelegated && !config.delegatedTaskModeEnabled) {
      try {
        createSettingsStore(db).set("delegatedTaskModeEnabled", true);
        (config as { delegatedTaskModeEnabled: boolean }).delegatedTaskModeEnabled = true;
        logger.info(
          { key, backend: effectiveBackend, trigger: "first_delegated" },
          "auto-enabled delegatedTaskModeEnabled — first delegated integration",
        );
      /* c8 ignore start -- settings write never fails with in-memory DB; defensive for production */
      } catch (err) {
        logger.error(
          { err, key },
          "failed to persist delegatedTaskModeEnabled auto-enable; in-memory config still updated",
        );
      }
      /* c8 ignore stop */
    }

    return c.json({ ok: true, integration: next[key] });
  /* c8 ignore start -- updateIntegrationState never throws with in-memory DB; defensive for production */
  } catch (err) {
    logger.error({ err, key }, "integration mode update failed");
    return respondWithAgentError(c, 500, [
      composeIssue("integrations.internal_error", {
        field: "<server>",
        received: "<state_update_failed>",
      }),
    ]);
  /* c8 ignore stop */
  } finally {
    // §11.3.1 — release the flip lock regardless of success/failure so
    // the next PATCH for this key is unblocked.
    if (flipLockHeld) {
      releaseIntegrationFlipLock(db, key);
    }
  }
}

function recordAuditModeChange(
  db: Database.Database,
  key: IntegrationKey,
  previous: {
    mode: string;
    delegatedBackend?: string | null;
    nativeBackend?: string | null;
  },
  next: {
    mode: string;
    delegatedBackend?: string | null;
    nativeBackend?: string | null;
  },
): void {
  try {
    db.prepare(
      `INSERT INTO agent_actions
         (event_id, action_type, trigger, result, detail, started_at, completed_at)
       VALUES (?, 'integration.mode_change', 'reactive', 'success', ?, datetime('now'), datetime('now'))`,
    ).run(
      `integration:${key}:${Date.now()}`,
      JSON.stringify({
        key,
        from: {
          mode: previous.mode,
          delegatedBackend: previous.delegatedBackend ?? null,
          // INTEGRATION_NATIVE_MODE_DESIGN.md §11.4 — preserve the prior
          // native binding in the audit row so the forensic chain survives
          // the schema clearing `nativeBackend` once mode flips away.
          nativeBackend: previous.nativeBackend ?? null,
        },
        to: {
          mode: next.mode,
          delegatedBackend: next.delegatedBackend ?? null,
          nativeBackend: next.nativeBackend ?? null,
        },
      }),
    );
  /* c8 ignore start -- in-memory DB always succeeds; catch is defensive for production DB errors */
  } catch (err) {
    logger.warn({ err, key }, "failed to write integration audit row");
  }
  /* c8 ignore stop */
}

function recordAuditPolicyChange(
  db: Database.Database,
  key: IntegrationKey,
  diff: { added: string[]; removed: string[] },
): void {
  try {
    db.prepare(
      `INSERT INTO agent_actions
         (event_id, action_type, trigger, result, detail, started_at, completed_at)
       VALUES (?, 'integration.policy_change', 'reactive', 'success', ?, datetime('now'), datetime('now'))`,
    ).run(
      `integration:${key}:policy:${Date.now()}`,
      JSON.stringify({ key, deniedTools: diff }),
    );
  /* c8 ignore start -- in-memory DB always succeeds; catch is defensive for production DB errors */
  } catch (err) {
    logger.warn({ err, key }, "failed to write integration policy audit row");
  }
  /* c8 ignore stop */
}

function diffDeniedTools(
  previous: readonly string[],
  next: readonly string[],
): { added: string[]; removed: string[] } {
  const prevSet = new Set(previous);
  const nextSet = new Set(next);
  const added = next.filter((t) => !prevSet.has(t));
  const removed = previous.filter((t) => !nextSet.has(t));
  return { added, removed };
}
