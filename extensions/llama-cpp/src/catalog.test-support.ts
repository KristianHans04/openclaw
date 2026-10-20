import type { LlamaCppHardware } from "./hardware.js";

export const GIB = 1024 ** 3;
export function hardware(
  memoryGiB = 8,
  overrides: Partial<LlamaCppHardware> = {},
): LlamaCppHardware {
  return {
    platform: "darwin",
    arch: "arm64",
    totalMemoryBytes: memoryGiB * GIB,
    availableMemoryBytes: memoryGiB * GIB,
    availableDiskBytes: 100 * GIB,
    availableRuntimeDiskBytes: 100 * GIB,
    sharedDisk: true,
    accelerator: { kind: "metal" },
    ...overrides,
  };
}
