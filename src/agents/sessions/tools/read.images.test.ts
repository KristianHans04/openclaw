import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createReadTool } from "./read.js";

const imageOps = vi.hoisted(() => ({
  convertImageToPng: vi.fn(),
  probe: vi.fn(),
  encode: vi.fn(),
}));
vi.mock("../../../media/image-ops.js", () => ({
  convertImageToPng: imageOps.convertImageToPng,
  createImageProcessor: () => ({ probe: imageOps.probe, encode: imageOps.encode }),
}));
beforeEach(() => Object.values(imageOps).forEach((mock) => mock.mockReset()));

it.each([
  [" IMAGE/JPG ; quality=80", false, false, "image/jpeg"],
  ["image/png", true, false, "image/png"],
  ["image/bmp", true, true, "image/png"],
] as const)(
  "snapshots %s before processing",
  async (mime, autoResizeImages, converted, mimeType) => {
    const borrowed = Buffer.from([91, 1, 1, 1, 92]).subarray(1, 4);
    const snapshot = Buffer.from([2, 2, 2]);
    const detected = createDeferred(),
      entered = createDeferred(),
      release = createDeferred();
    const mimeResult = createDeferred<string>();
    const observe = async (input: Buffer) => {
      entered.resolve();
      await release.promise;
      expect(input).toEqual(snapshot);
    };
    imageOps.convertImageToPng.mockImplementation(async (input: Buffer) => {
      await observe(input);
      return Buffer.from(input);
    });
    imageOps.probe.mockImplementation(async (input: Buffer) => {
      if (!converted) {
        await observe(input);
      }
      expect(input).toEqual(snapshot);
      return { width: converted ? 4000 : 1, height: 1, orientation: null };
    });
    imageOps.encode.mockImplementation(async (input: Buffer) => {
      await Promise.resolve();
      expect(input).toEqual(snapshot);
      return {
        data: Buffer.from(input),
        mimeType: "image/png",
        width: 2000,
        height: 1,
        resized: true,
        withinBudget: true,
      };
    });
    const tool = createReadTool("/workspace", {
      autoResizeImages,
      get modelHasVision() {
        // Mutate after MIME detection but before the no-resize path returns.
        if (!autoResizeImages && !converted) {
          queueMicrotask(() => borrowed.fill(3));
        }
        return true;
      },
      operations: {
        access: async () => {},
        readFile: async () => borrowed,
        detectImageMimeType: async () => {
          detected.resolve();
          return mimeResult.promise;
        },
      },
    });
    const pending = tool.execute("read", { path: "synthetic-image" });
    await detected.promise;
    borrowed.fill(2);
    mimeResult.resolve(mime);
    if (autoResizeImages || converted) {
      await entered.promise;
      borrowed.fill(3);
      release.resolve();
    }
    const notes = [
      `Read image file [${mimeType}]`,
      ...(converted
        ? [
            "[Image converted from image/bmp to image/png.]",
            "[Image: original 4000x1, displayed at 2000x1. Multiply coordinates by 2.00 to map to original image.]",
          ]
        : []),
    ].join("\n");
    expect(await pending).toEqual({
      content: [
        { type: "text", text: notes },
        { type: "image", mimeType, data: snapshot.toString("base64") },
      ],
      details: { kind: "image", content: notes, mimeType },
    });
    expect(borrowed).toEqual(Buffer.from([3, 3, 3]));
  },
);
