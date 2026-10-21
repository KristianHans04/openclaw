import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import type { HostDesktopStatus } from "../gateway/desktop/host-source.js";
import type { PluginCompatibilityNotice } from "../plugins/status-compatibility.js";
import { redactSecretDegradationReason } from "../secrets/runtime-degraded-state.js";
import type { StatusSummary } from "../status/summary.js";
import { formatTokenCount } from "../utils/token-format.js";
import { redactStatusSecrets } from "./status-all/format.js";

export function formatHostDesktopStatus(status?: HostDesktopStatus): string {
  if (!status || status.state === "disabled") {
    return "disabled";
  }
  if (status.state === "managed") {
    return status.managedState === "running"
      ? `managed · running · display :${status.display} · 127.0.0.1:${status.port} · security VncAuth`
      : status.managedState === "failed"
        ? `managed · failed: ${status.error}`
        : status.managedState === "unknown"
          ? "managed · runtime state unavailable"
          : `managed · ${status.managedState === "not-started" ? "not started" : "starting"}`;
  }
  return `${status.state} · 127.0.0.1:${status.port}${status.security ? ` · security ${status.security}` : ""}`;
}

/** Combines Gateway-owned degradation with distinct command-local human diagnostics. */
export function buildStatusSecretDiagnostics(
  owners: NonNullable<StatusSummary["degradedSecretOwners"]>,
  diagnostics: string[],
): string[] {
  const safeText = (value: string) =>
    truncateUtf16Safe(redactStatusSecrets(sanitizeTerminalText(redactStatusSecrets(value))), 160);
  const ownerPaths = new Set(owners.flatMap((owner) => owner.paths));
  const ownerDiagnostics = new Map(
    owners.map((owner) => [
      `${owner.ownerKind}\0${owner.ownerId}`,
      `${owner.degradationState ?? "cold"} ${owner.ownerKind}:${safeText(owner.ownerId)} (${owner.paths.slice(0, 3).map(safeText).join(", ")}${owner.paths.length > 3 ? ", …" : ""}): ${redactSecretDegradationReason(owner.reason)}`,
    ]),
  );
  const localDiagnostics = diagnostics.filter((diagnostic) => {
    const ownerPath =
      /^.+?: (.+?) is unavailable in this command path(?:;|$)/.exec(diagnostic)?.[1] ??
      diagnostic.split(":", 1)[0];
    return ownerPath === undefined || !ownerPaths.has(ownerPath);
  });
  return [...ownerDiagnostics.values(), ...new Set(localDiagnostics.map(safeText))];
}

type AgentStatusLike = {
  bootstrapPendingCount: number;
  totalSessions: number;
  agents: Array<{
    id: string;
    lastActiveAgeMs?: number | null;
  }>;
};

type SummarySessionsLike = {
  count: number;
  paths: string[];
  defaults: {
    model?: string | null;
    contextTokens?: number | null;
  };
};

export function countActiveStatusAgents(params: {
  agentStatus: Pick<AgentStatusLike, "agents">;
  activeThresholdMs?: number;
}) {
  const activeThresholdMs = params.activeThresholdMs ?? 10 * 60_000;
  // "Active" means a recent session update, not merely a configured agent.
  return params.agentStatus.agents.filter(
    (agent) => agent.lastActiveAgeMs != null && agent.lastActiveAgeMs <= activeThresholdMs,
  ).length;
}

export function buildStatusAllAgentsValue(agentStatus: AgentStatusLike) {
  const activeAgents = countActiveStatusAgents({ agentStatus });
  return `${agentStatus.agents.length} total · ${agentStatus.bootstrapPendingCount} bootstrapping · ${activeAgents} active · ${agentStatus.totalSessions} sessions`;
}

export function buildStatusSecretsValue(count: number) {
  return count > 0 ? `${count} diagnostic${count === 1 ? "" : "s"}` : "none";
}

export function buildStatusEventsValue(params: { queuedSystemEvents: string[] }) {
  return params.queuedSystemEvents.length > 0
    ? `${params.queuedSystemEvents.length} queued`
    : "none";
}

export function buildStatusProbesValue(params: { health?: unknown }) {
  return params.health ? theme.success("enabled") : theme.muted("skipped (use --deep)");
}

export function buildStatusPluginCompatibilityValue(params: {
  notices: Pick<PluginCompatibilityNotice, "pluginId">[];
}) {
  if (params.notices.length === 0) {
    return theme.success("none");
  }
  const pluginCount = new Set(params.notices.map((notice) => notice.pluginId)).size;
  return theme.warn(
    `${params.notices.length} notice${params.notices.length === 1 ? "" : "s"} · ${pluginCount} plugin${pluginCount === 1 ? "" : "s"}`,
  );
}

export function buildStatusSessionsOverviewValue(params: { sessions: SummarySessionsLike }) {
  const defaultCtx = params.sessions.defaults.contextTokens
    ? ` (${formatTokenCount(params.sessions.defaults.contextTokens)} ctx)`
    : "";
  const storeLabel =
    params.sessions.paths.length > 1
      ? `${params.sessions.paths.length} stores`
      : (params.sessions.paths[0] ?? "unknown");
  return `${params.sessions.count} stored · default ${params.sessions.defaults.model ?? "unknown"}${defaultCtx} · ${storeLabel}`;
}
