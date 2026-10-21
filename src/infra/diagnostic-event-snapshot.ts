import { freezeJsonSnapshot, isDeeplyFrozenPlainData } from "../shared/immutable-data.js";
import {
  isInternalDiagnosticEventInterested,
  type InternalDiagnosticEventInterest,
} from "./diagnostic-event-listener-presence.js";
import type {
  DiagnosticEventMetadata,
  DiagnosticEventPayload,
  DiagnosticEventPrivateData,
} from "./diagnostic-events.js";

export type DiagnosticSnapshot<T> = T extends object
  ? { readonly [K in keyof T]: DiagnosticSnapshot<T[K]> }
  : T;

export type QueuedDiagnosticEvent = {
  type: DiagnosticEventPayload["type"];
  seq: number;
  metadata: DiagnosticEventMetadata;
  eventForListener: () => DiagnosticEventPayload;
  privateDataForListener?: () => DiagnosticEventPrivateData;
  hostPluginId?: string;
  trustedListenersOnly?: boolean;
};

export function createDiagnosticDelivery(
  event: DiagnosticEventPayload,
  metadata: DiagnosticEventMetadata,
  trustedListeners: ReadonlyMap<
    unknown,
    (InternalDiagnosticEventInterest & { readonly includePrivateData?: boolean }) | undefined
  >,
  privateData?: DiagnosticEventPrivateData,
): QueuedDiagnosticEvent {
  let privateDataForListener: QueuedDiagnosticEvent["privateDataForListener"];
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
