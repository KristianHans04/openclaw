import { freezeJsonSnapshot, isDeeplyFrozenPlainData } from "../shared/immutable-data.js";
import {
  isInternalDiagnosticEventInterested,
  type InternalDiagnosticEventInterest,
} from "./diagnostic-event-listener-presence.js";

export type DiagnosticSnapshot<T> = T extends object
  ? { readonly [K in keyof T]: DiagnosticSnapshot<T[K]> }
  : T;

export type DiagnosticEventMetadata = Readonly<{
  internal?: boolean;
  trustedTraceContext?: boolean;
  trusted: boolean;
}>;

export type DiagnosticModelCallContent = Readonly<{
  inputMessages?: unknown;
  outputMessages?: unknown;
  systemPrompt?: string;
  toolDefinitions?: unknown;
}>;

export type DiagnosticEventPrivateData = DiagnosticSnapshot<{
  /** Raw failure text for trusted diagnostics exporters; never part of the public event payload. */
  errorMessage?: string;
  modelContent?: DiagnosticModelCallContent;
  skillUsage?: { skillFile: string };
  toolContent?: { toolInput?: unknown; toolOutput?: unknown };
  // Content gated by captureContent policy; never reaches untrusted onDiagnosticEvent listeners.
  messageContent?: { userPrompt?: string; finalResponse?: string };
  // Same gating as messageContent but for harness.run started/completed events.
  harnessContent?: { userPrompt?: string; finalResponse?: string };
}>;

export type DiagnosticDelivery<Event extends { type: string; seq: number }> = {
  type: Event["type"];
  seq: number;
  metadata: DiagnosticEventMetadata;
  eventForListener: () => Event;
  privateDataForListener?: () => DiagnosticEventPrivateData;
  hostPluginId?: string;
  trustedListenersOnly?: boolean;
};

export function createDiagnosticDelivery<Event extends { type: string; seq: number }>(
  event: Event,
  metadata: DiagnosticEventMetadata,
  trustedListeners: ReadonlyMap<
    unknown,
    (InternalDiagnosticEventInterest & { readonly includePrivateData?: boolean }) | undefined
  >,
  privateData?: DiagnosticEventPrivateData,
): DiagnosticDelivery<Event> {
  let privateDataForListener: (() => DiagnosticEventPrivateData) | undefined;
  if (privateData) {
    let privateSnapshot = privateData;
    for (const interest of trustedListeners.values()) {
      if (
        interest?.includePrivateData === false ||
        !isInternalDiagnosticEventInterested(interest, event.type, metadata.trusted)
      ) {
        continue;
      }
      if (Object.hasOwn(privateData, "hostPluginId")) {
        // Attribution is assigned by the host, never by private content.
        privateSnapshot = { ...privateData };
        Reflect.deleteProperty(privateSnapshot, "hostPluginId");
      }
      privateDataForListener = createDiagnosticValueForListeners(privateSnapshot, true);
      break;
    }
  }
  return {
    type: event.type,
    seq: event.seq,
    metadata: Object.freeze(metadata),
    eventForListener: createDiagnosticValueForListeners(event),
    privateDataForListener,
  };
}

export function cloneDiagnosticValueForListener<T>(value: T): T {
  return freezeJsonSnapshot(structuredClone(value));
}

/** Own one capture; opaque mutable internals still need a copy for each reader. */
export function createDiagnosticValueForListeners<T extends object>(
  value: T,
  owned = false,
): () => T {
  try {
    const snapshot =
      owned && isDeeplyFrozenPlainData(freezeJsonSnapshot(value))
        ? value
        : cloneDiagnosticValueForListener(value);
    return isDeeplyFrozenPlainData(snapshot)
      ? () => snapshot
      : () => cloneDiagnosticValueForListener(snapshot);
  } catch (error) {
    // Keep malformed-payload failures at the existing reader boundary.
    return () => {
      throw error;
    };
  }
}
