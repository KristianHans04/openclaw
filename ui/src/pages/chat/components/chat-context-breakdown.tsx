import { For, Loading, Show, createMemo, createSignal, onCleanup, type Element } from "solid-js";
import type { SessionSystemPromptReport } from "../../../../../src/config/sessions/session-system-prompt-report.js";
import type { GatewaySessionRow } from "../../../api/types.ts";
import type { ApplicationGateway } from "../../../app/gateway.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { formatCompactTokenCount } from "../../../lib/format.ts";
import { projectGateway } from "../../../lib/reactive/application.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { createParkedProjection } from "../../../lib/reactive/parked-projection.ts";
import {
  areUiSessionKeysEquivalent,
  scopedSessionArtifactKey,
} from "../../../lib/sessions/session-key.ts";
import { requestSessionUsage } from "../../../lib/sessions/usage.ts";
import {
  buildChatContextCategories,
  buildDeferredContextGroups,
  type ContextEntry,
  type ContextGroup,
  type ContextCategory,
} from "./chat-context-breakdown-model.ts";
import "../../../styles/chat/context-breakdown.css";

const labelKeys = {
  messages: "contextMessages",
  files: "contextFiles",
  tools: "contextTools",
  skills: "contextSkills",
  system: "contextSystem",
} as const;

const groupLabelKeys = {
  "agent-workspace": "contextAgentWorkspace",
  "execution-project": "contextProject",
  personal: "contextPersonal",
  other: "contextOtherFiles",
  openclaw: "contextSystemTools",
  mcp: "contextMcpTools",
  client: "contextClientTools",
  "unknown-tools": "contextTools",
} as const;

function ContextEntries(props: { entries: ContextEntry[] }) {
  return (
    <For each={props.entries} keyed={(entry) => entry.key}>
      {(entry) => (
        <div class="chat-context__entry">
          <span title={entry().path ?? entry().name}>
            <span>{entry().name}</span>
            <Show when={entry().path}>
              <small class="chat-context__path">{entry().path}</small>
            </Show>
          </span>
          <span>
            {entry().tokens === null
              ? t("chat.sessionDetails.contextUnverified")
              : "~" + formatCompactTokenCount(entry().tokens!)}
          </span>
        </div>
      )}
    </For>
  );
}

function ContextGroups(props: { groups: ContextGroup[] }) {
  return (
    <For each={props.groups} keyed={(group) => group.key}>
      {(group) => (
        <section class="chat-context__source" data-context-source={group().kind}>
          <div class="chat-context__source-heading">
            <span title={group().path}>
              {t("chat.sessionDetails." + groupLabelKeys[group().kind])}
              <Show when={group().name}> · {group().name}</Show>
            </span>
            <small>
              {group().entries.length} ·{" "}
              {group().tokens === null ? "—" : "~" + formatCompactTokenCount(group().tokens!)}
            </small>
          </div>
          <ContextEntries entries={group().entries} />
        </section>
      )}
    </For>
  );
}

function ContextRow(props: { category: ContextCategory; onOpen?: () => void }) {
  const content = () => (
    <>
      <span
        class={["chat-context__swatch", `chat-context__${props.category.id}`]}
        aria-hidden="true"
      />
      <span class="chat-context__label">
        {t("chat.sessionDetails." + labelKeys[props.category.id])}
        <Show when={props.category.entries.length > 0}>
          <small> {props.category.entries.length}</small>
        </Show>
      </span>
      <span class="chat-context__tokens">
        {props.category.tokens === null
          ? "—"
          : "~" + formatCompactTokenCount(props.category.tokens)}
      </span>
    </>
  );
  return (
    <Show
      when={props.onOpen && props.category.entries.length > 0}
      fallback={
        <div class="chat-context__row" data-context-category={props.category.id}>
          {content()}
        </div>
      }
    >
      <button
        class="chat-context__row"
        type="button"
        data-context-category={props.category.id}
        onClick={() => props.onOpen?.()}
      >
        {content()}
        <Icon name="chevronRight" />
      </button>
    </Show>
  );
}

function ContextSections(props: { categories: ContextCategory[] }) {
  return (
    <For
      each={props.categories.filter((category) => category.entries.length > 0)}
      keyed={(category) => category.id}
    >
      {(category) => (
        <section class="chat-context__section" data-context-section={category().id}>
          <h3>{t("chat.sessionDetails." + labelKeys[category().id])}</h3>
          <div class="chat-context__entries">
            <Show
              when={category().groups}
              fallback={<ContextEntries entries={category().entries} />}
            >
              {(groups) => <ContextGroups groups={groups()} />}
            </Show>
          </div>
        </section>
      )}
    </For>
  );
}

function ContextActions(props: { onOpen?: () => void; onRefresh: () => void }) {
  return (
    <div class="chat-context__actions">
      <Show when={props.onOpen}>
        <button type="button" class="chat-context__open" onClick={() => props.onOpen?.()}>
          {t("chat.sessionDetails.contextOpen")}
          <Icon name="panelRightOpen" />
        </button>
      </Show>
      <button
        type="button"
        class="chat-context__refresh"
        aria-label={t("common.refresh")}
        title={t("common.refresh")}
        onClick={() => props.onRefresh()}
      >
        <Icon name="refresh" />
        <Show when={!props.onOpen}>{t("common.refresh")}</Show>
      </button>
    </div>
  );
}

export function ChatContextBreakdown(props: {
  gateway: ApplicationGateway;
  session: GatewaySessionRow;
  agentId?: string;
  used: number;
  limit: number;
  approximate?: boolean;
  presented?: boolean;
  expanded?: boolean;
  onOpen?: () => void;
  children?: Element;
}) {
  const gateway = createMemo(() => projectGateway(props.gateway));
  const [revision, setRevision] = createSignal(0);
  const liveTarget = createMemo(
    () => {
      const connection = gateway().read();
      return {
        client: connection.snapshot.phase === "connected" ? connection.snapshot.client : null,
        connectionRevision: connection.connectionRevision,
        agentId: props.agentId,
        key: scopedSessionArtifactKey(props.session.key, props.agentId),
        sessionId: props.session.sessionId,
        model: props.session.activeModel || props.session.model,
        provider: props.session.modelProvider,
        revision: revision(),
        used: props.used,
      };
    },
    {
      equals: (a, b) =>
        a.client === b.client &&
        a.connectionRevision === b.connectionRevision &&
        a.agentId === b.agentId &&
        a.key === b.key &&
        a.sessionId === b.sessionId &&
        a.model === b.model &&
        a.provider === b.provider &&
        a.revision === b.revision &&
        a.used === b.used,
    },
  );
  // Resuming the same report must keep its content and scroll position intact.
  const target = createMemo(createParkedProjection(liveTarget, () => props.presented !== false));
  const result = createMemo(
    async (): Promise<{
      report: SessionSystemPromptReport | null;
      failed?: boolean;
      offline?: boolean;
    }> => {
      const current = target();
      if (!current.client) {
        return { report: null, offline: true };
      }
      const controller = new AbortController();
      onCleanup(() => controller.abort());
      try {
        // Context reports are independent of the usage date range. Keep this
        // existing single-session read bounded to today's usage, not its history.
        const today = new Date().toISOString().slice(0, 10);
        const response = await requestSessionUsage(
          current.client,
          {
            startDate: today,
            endDate: today,
            timeZone: "utc",
            scope: "instance",
            agentId: current.agentId,
          },
          { key: current.key, includeContextWeight: true, signal: controller.signal },
        );
        const row = response.sessions.find((entry) =>
          areUiSessionKeysEquivalent(entry.key, current.key),
        );
        const report = row?.contextWeight;
        if (
          !report ||
          (current.sessionId &&
            (row?.sessionId !== current.sessionId ||
              (report.sessionId && report.sessionId !== current.sessionId))) ||
          (report.model && current.model && report.model !== current.model) ||
          (report.provider && current.provider && report.provider !== current.provider)
        ) {
          return { report: null };
        }
        return { report };
      } catch {
        return { report: null, failed: true };
      }
    },
  );
  return (
    <div class={["chat-context", { "chat-context--expanded": props.expanded }]}>
      <Show when={props.expanded}>
        <ContextActions onRefresh={() => setRevision((value) => value + 1)} />
      </Show>
      <Loading
        on={target()}
        fallback={
          <>
            <p class="chat-context__note" role="status">
              {t("chat.sessionDetails.contextLoading")}
            </p>
            {props.children}
          </>
        }
      >
        <Show
          when={result().report}
          fallback={
            <>
              <p class="chat-context__note" role="status">
                {t(
                  result().offline
                    ? "chat.sessionDetails.contextOffline"
                    : result().failed
                      ? "chat.sessionDetails.contextError"
                      : "chat.sessionDetails.contextUnavailable",
                )}
              </p>
              {props.children}
            </>
          }
        >
          {(report) => {
            const categories = createMemo(() => buildChatContextCategories(report(), props.used));
            const deferred = createMemo(() => buildDeferredContextGroups(report()));
            return (
              <>
                <div class="chat-context__bar" aria-hidden="true">
                  <For each={categories()} keyed={(category) => category.id}>
                    {(category) => (
                      <span
                        class={["chat-context__segment", `chat-context__${category().id}`]}
                        style={{
                          width:
                            Math.min(100, ((category().tokens ?? 0) / props.limit) * 100) + "%",
                        }}
                      />
                    )}
                  </For>
                </div>
                <div class="chat-context__legend">
                  <For each={categories()} keyed={(category) => category.id}>
                    {(category) => (
                      <ContextRow
                        category={category()}
                        onOpen={props.expanded ? undefined : props.onOpen}
                      />
                    )}
                  </For>
                  <Show when={props.expanded}>
                    <div class="chat-context__row" data-context-category="free">
                      <span class="chat-context__swatch chat-context__free" aria-hidden="true" />
                      <span class="chat-context__label">
                        {t("chat.sessionDetails.contextFree")}
                      </span>
                      <span class="chat-context__tokens">
                        {props.approximate ? "~" : ""}
                        {formatCompactTokenCount(Math.max(0, props.limit - props.used))}
                      </span>
                    </div>
                  </Show>
                </div>
                {props.children}
                <Show when={props.expanded}>
                  <ContextSections categories={categories()} />
                </Show>
                <Show when={props.expanded && deferred().length > 0}>
                  <details
                    class="chat-context__details chat-context__deferred"
                    data-context-details="deferred"
                  >
                    <summary class="chat-context__source-heading">
                      <span>{t("chat.sessionDetails.contextAvailableOnDemand")}</span>
                      <small>
                        {deferred().reduce((sum, group) => sum + group.entries.length, 0)}
                      </small>
                      <Icon name="chevronDown" />
                    </summary>
                    <p class="chat-context__note">
                      {t("chat.sessionDetails.contextDeferredEstimate")}
                    </p>
                    <div class="chat-context__entries">
                      <ContextGroups groups={deferred()} />
                    </div>
                  </details>
                </Show>
              </>
            );
          }}
        </Show>
      </Loading>
      <Show when={!props.expanded}>
        <ContextActions onOpen={props.onOpen} onRefresh={() => setRevision((value) => value + 1)} />
      </Show>
    </div>
  );
}
