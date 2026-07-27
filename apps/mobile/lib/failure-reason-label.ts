/**
 * Mirror of `packages/views/agents/components/tabs/task-failure.ts:failureReasonLabel`.
 *
 * Why mirror: mobile cannot import from packages/views per the apps/mobile
 * CLAUDE.md sharing rule. The enum itself comes from packages/core/types
 * (type-only import is fine) and the degradation helper is a pure function
 * from packages/core (also fine); only the human copy is mobile-owned.
 *
 * Used by the destructive chat bubble. `resolveFailureReasonKey` handles enum
 * drift — a refined reason this build doesn't name degrades to its
 * `agent_error` family, and anything unrecognisable renders a generic
 * "Failed" rather than crashing or leaking the raw enum string, matching the
 * root CLAUDE.md "Enum drift downgrades, not crashes" rule.
 */
import { resolveFailureReasonKey } from "@multica/core/agents/failure-reason";
import type { TaskFailureReason } from "@multica/core/types";

const LABELS: Partial<Record<TaskFailureReason, string>> = {
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

export function failureReasonLabel(
  reason: TaskFailureReason | string | null | undefined,
): string {
  const key = resolveFailureReasonKey(reason, LABELS);
  return (key && LABELS[key]) ?? "Failed";
}
