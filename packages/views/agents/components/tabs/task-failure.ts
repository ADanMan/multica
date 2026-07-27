import { resolveFailureReasonKey } from "@multica/core/agents";
import type { TaskFailureReason } from "@multica/core/types";

// Human-readable copy for the back-end task failure reason taxonomy.
// Surfaced in the agent detail Recent Work tab and the issue execution log —
// the only places the front-end exposes failure_reason directly to the user.
//
// Lives next to the consuming tab (rather than in agents/presence) because
// failed tasks no longer have a top-level workload state; failure context
// is purely a detail-page concern now.
//
// Partial by design: read it through `failureReasonLabelFor`, which degrades
// an `agent_error.*` value this map doesn't name to the generic agent_error
// line instead of rendering nothing.
export const failureReasonLabel: Partial<Record<TaskFailureReason, string>> = {
  // Platform / scheduler side.
  queued_expired: "Expired in queue",
  runtime_offline: "Daemon offline",
  runtime_recovery: "Daemon restarted",
  timeout: "Task timed out",
  iteration_limit: "Iteration limit reached",
  agent_blocked: "Agent asked for input",
  api_invalid_request: "Provider rejected the request",
  skill_bundle_unavailable: "Skill download failed",
  // Agent process side.
  agent_error: "Agent execution error",
  "agent_error.provider_auth_or_access": "Provider auth failed",
  "agent_error.provider_quota_limit": "Provider quota exhausted",
  "agent_error.provider_capacity_or_rate_limit": "Provider rate-limited",
  "agent_error.provider_server_error": "Provider server error",
  "agent_error.provider_network": "Provider network error",
  "agent_error.process_failure": "Agent process crashed",
  "agent_error.empty_or_unparseable_output": "Unreadable agent output",
  "agent_error.agent_timeout": "Agent timed out",
  "agent_error.context_overflow": "Context window exceeded",
  "agent_error.missing_config": "Agent config missing",
  "agent_error.model_not_found_or_unavailable": "Model unavailable",
  "agent_error.runtime_version_unsupported": "Runner CLI too old",
  "agent_error.runtime_missing_executable": "Runner CLI not found",
  "agent_error.unknown": "Agent execution error",
  // Operational values outside the canonical taxonomy.
  codex_semantic_inactivity: "Codex semantic inactivity timeout",
  agent_fallback_message: "Agent returned a fallback message",
  idle_watchdog: "Stopped after going idle",
  local_directory_error: "Local directory unavailable",
  cancelled: "Cancelled",
  manual: "Cancelled by user",
};

/**
 * Label for a server-supplied failure_reason, or `undefined` when the reason
 * is absent or unrecognisable. Callers render their own neutral text for
 * `undefined` rather than leaking the raw enum string.
 */
export function failureReasonLabelFor(
  reason: TaskFailureReason | string | null | undefined,
): string | undefined {
  const key = resolveFailureReasonKey(reason, failureReasonLabel);
  return key ? failureReasonLabel[key] : undefined;
}
