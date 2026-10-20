import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { page } from "vitest/browser";
import type { ApplicationContext } from "../../app/context.ts";
import { REDACTED_SENTINEL, type JsonSchema } from "../../lib/config-form-utils.ts";
import type { GatewayPageBinding } from "../../lib/gateway-page-binding.ts";
import { ControlUiPluginRuntime } from "../../plugins/control-ui-runtime.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import {
  createApplicationGateway,
  createSolidApplicationContextProvider,
} from "../../test-helpers/solid-application-context.tsx";
import { createContext } from "./plugins-page.test-support.ts";
import { PluginSettingsEditor, type PluginSettingsEditorProps } from "./settings-editor.tsx";
import type { PluginSettingsEditorModel } from "./settings-model.ts";
import { renderPluginSettingsInventory as PluginSettingsInventory } from "./settings-view.tsx";
import "../../styles.css";
import "../../styles/settings.css";

const prefix = "plugins.entries.fixture.config";
const configPath = (...parts: string[]) => ["plugins", "entries", "fixture", "config", ...parts];
const getField = (root: ParentNode, label: string) =>
  root.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
function typeInto(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
const textContents = (root: ParentNode, selector: string) =>
  [...root.querySelectorAll(selector)].map((element) => element.textContent?.trim());
const findElement = <T extends Element = HTMLElement>(root: ParentNode, selector: string) =>
  root.querySelector<T>(selector)!;
const configValue = (config: Record<string, unknown>) => ({
  plugins: { entries: { fixture: { config } } },
});
const objectSchema = (properties: Record<string, JsonSchema>): JsonSchema => ({
  type: "object",
  additionalProperties: false,
  properties,
});
async function mount(overrides: Partial<PluginSettingsEditorModel> = {}) {
  const model: PluginSettingsEditorModel = {
    pluginId: "fixture",
    result: null,
    connected: true,
    configValue: configValue({ enabled: true }),
    configSchema: objectSchema({
      enabled: { type: "boolean", title: "Enabled", default: false },
      storage: {
        type: "object",
        additionalProperties: false,
        default: { path: "original", mode: "keep" },
        properties: {
          path: { type: "string", title: "Path" },
          mode: { type: "string", title: "Mode" },
        },
      },
      timeout: { type: "integer", title: "Timeout", default: 30 },
    }),
    configHints: {
      [prefix]: {
        groups: [
          { id: "capture", title: "Capture", order: 20, properties: ["enabled"] },
          { id: "data", title: "Data storage", order: 10, properties: ["storage"] },
        ],
      },
    },
    configUnsupportedPaths: [],
    canEditConfig: true,
    configBusy: false,
    configSchemaLoading: false,
    configError: null,
    onConfigPatch: vi.fn(),
    onConfigRemove: vi.fn(),
    onConfigReadRetry: vi.fn(),
    onConfigWriteRetry: vi.fn(),
    backHref: "/settings/plugins/fixture",
    onBack: vi.fn(),
    ...overrides,
  };
  const [props, setProps] = createSignal<PluginSettingsEditorProps>({ model });
  const host = document.createElement("div");
  document.body.append(host);
  mountSolid(() => <PluginSettingsEditor {...props()} />, { container: host });
  const editor = findElement(host, "openclaw-plugin-settings-editor");
  const update = async (next: Partial<PluginSettingsEditorProps>) => {
    setProps((current) => ({ ...current, ...next }));
    await settle();
  };
  await settle();
  return { editor, model, update };
}
async function searchSettings(editor: HTMLElement, search: string) {
  const input = findElement<HTMLInputElement>(editor, 'input[type="search"]');
  expect(input).not.toBeNull();
  typeInto(input, search);
  await settle();
}
async function settle() {
  flush();
  await Promise.resolve();
  flush();
}
afterEach(() => {
  document.body.replaceChildren();
});
describe("grouped plugin settings", () => {
  it("keeps typing and focus in Advanced settings when configuration updates", async () => {
    const [value, setValue] = createSignal({ plugins: { label: "" } });
    const schema = objectSchema({ label: { type: "string", title: "Label" } });
    const onPatch = vi.fn((_path: Array<string | number>, next: unknown) => {
      setValue({ plugins: { label: String(next) } });
    });
    const { gateway } = createApplicationGateway();
    const plugins = new ControlUiPluginRuntime(() => context);
    onTestFinished(() => plugins.dispose());
    const context: ApplicationContext = { ...createContext(gateway), plugins };
    const provider = createSolidApplicationContextProvider(context);
    const mounted = mountSolid(
      () => (
        <PluginSettingsInventory
          tab="advanced"
          query=""
          result={null}
          connected
          loading={false}
          error={null}
          busy={{}}
          messages={{}}
          iconUrls={{}}
          canMutate
          mutationBlockedReason={null}
          configValue={value()}
          configHints={{}}
          configUnsupportedPaths={[]}
          advancedSchema={schema}
          canEditConfig
          configBusy={false}
          configSchemaLoading={false}
          configError={null}
          onConfigPatch={onPatch}
          onConfigRemove={vi.fn()}
          onConfigReadRetry={vi.fn()}
          onConfigWriteRetry={vi.fn()}
          onConfigReload={vi.fn()}
          onRefresh={vi.fn()}
          onTabChange={vi.fn()}
          onQueryChange={vi.fn()}
          onIconError={vi.fn()}
          onSetEnabled={vi.fn()}
          onUninstall={vi.fn()}
          pluginHref={() => "#"}
          onOpenPlugin={vi.fn()}
        />
      ),
      { wrapper: provider.wrapper },
    );
    await settle();
    const input = getField(mounted.container, "Label");
    input.focus();
    for (const text of ["a", "ab"]) {
      typeInto(input, text);
      await settle();
      expect(document.activeElement).toBe(input);
      expect(input.value).toBe(text);
      expect(onPatch).toHaveBeenLastCalledWith(["plugins", "label"], text);
    }
  });
  it("retains an optional config draft across refreshes and a rejected atomic save", async () => {
    const onConfigPatch = vi.fn(() => false);
    const { editor, model, update } = await mount({
      configValue: { plugins: { entries: { fixture: {} } } },
      configHints: {},
      configSchema: {
        ...objectSchema({
          host: { type: "string", title: "Host", minLength: 1 },
          port: { type: "integer", title: "Port", minimum: 1 },
        }),
        required: ["host", "port"],
      },
      onConfigPatch,
    });
    const host = getField(editor, "Host");
    host.focus();
    typeInto(host, "gateway.local");
    host.blur();
    await settle();
    expect(onConfigPatch).not.toHaveBeenCalled();

    await update({ model: { ...model } });
    expect(getField(editor, "Host").value).toBe("gateway.local");
    const port = getField(editor, "Port");
    port.focus();
    typeInto(port, "18789");
    port.blur();
    await settle();
    expect(onConfigPatch).toHaveBeenCalledExactlyOnceWith(configPath(), {
      host: "gateway.local",
      port: 18789,
    });
    expect(
      editor.querySelector('.cfg-structured-draft__error [role="alert"]')?.textContent,
    ).toContain("draft is still here");
    expect(getField(editor, "Host").value).toBe("gateway.local");
  });
  it("navigates authored sections without hiding settings and omits the rail for flat schemas", async () => {
    const { editor, model, update } = await mount();
    const links = [...editor.querySelectorAll<HTMLAnchorElement>(".plugin-editor__nav a")];
    expect(links.map((link) => link.textContent?.trim())).toEqual([
      "Data storage",
      "Capture",
      "Other",
    ]);
    const target = findElement(editor, links[1]!.getAttribute("href")!);
    const scroll = vi.spyOn(target, "scrollIntoView");
    links[1]!.click();
    expect(scroll).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(target);
    expect(editor.querySelectorAll("[data-setting]")).toHaveLength(4);
    expect(editor.querySelector("h1")).toBeNull();
    expect(textContents(editor, "h2")).toEqual(["Data storage", "Capture", "Other"]);
    const back = findElement<HTMLAnchorElement>(editor, ".plugins-settings-breadcrumb__parent");
    expect(back.getAttribute("href")).toBe("/settings/plugins/fixture");
    back.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(model.onBack).toHaveBeenCalledOnce();
    expect(editor.querySelector('[aria-current="page"]')?.textContent?.trim()).toBe("Settings");
    expect(editor.textContent).not.toContain(prefix);
    expect(editor.textContent).not.toMatch(/\d+ settings/);
    await update({ model: { ...model, configHints: {} } });
    expect(editor.querySelector(".plugin-editor__nav")).toBeNull();
  });
  it.each<{
    name: string;
    overrides: Partial<PluginSettingsEditorModel>;
    fields: { label: string; value: string; placeholder?: string }[];
  }>([
    {
      name: "an automatic numeric placeholder",
      overrides: {
        configHints: { [`${prefix}.timeout`]: { placeholder: "Automatic" } },
        configSchema: {
          type: "object",
          properties: { timeout: { type: "integer", title: "Timeout" } },
        },
      },
      fields: [{ label: "Timeout", value: "", placeholder: "Automatic" }],
    },
    {
      name: "inherited string and numeric defaults",
      overrides: {},
      fields: [
        { label: "Storage: Path", value: "original" },
        { label: "Timeout", value: "30" },
      ],
    },
  ])(
    "does not persist $name when an unchanged field loses focus",
    async ({ overrides, fields }) => {
      const { editor, model } = await mount(overrides);
      for (const { label, value, placeholder } of fields) {
        const input = getField(editor, label);
        expect(input.value).toBe(value);
        if (placeholder !== undefined) {
          expect(input.placeholder).toBe(placeholder);
        }
        input.focus();
        input.blur();
      }
      expect(model.onConfigPatch).not.toHaveBeenCalled();
    },
  );
  it.each<{
    name: string;
    overrides: Partial<PluginSettingsEditorModel>;
    selector: string;
    index?: number;
    initial?: string;
    replacement?: string;
    path: string[];
    value: unknown;
    search?: string;
    array?: boolean;
    flat?: boolean;
  }>([
    {
      name: "an inherited nested value without losing its sibling",
      overrides: {},
      selector: 'input[aria-label="Storage: Path"]',
      path: ["storage"],
      value: { path: "changed", mode: "keep" },
    },
    {
      name: "a searched descendant inside a retained object",
      overrides: {
        configHints: {},
        configValue: configValue({ storage: { path: "original" } }),
        configSchema: objectSchema({
          storage: {
            type: "object",
            title: "Storage",
            properties: { path: { type: "string", title: "Directory" } },
          },
        }),
      },
      selector: 'input[aria-label="Directory"]',
      search: "directory",
      path: ["storage", "path"],
      value: "changed",
    },
    {
      name: "an inherited array item without losing its sibling",
      overrides: {
        configHints: {},
        configValue: configValue({}),
        configSchema: objectSchema({
          tags: {
            type: "array",
            title: "Tags",
            default: ["alpha", "beta"],
            items: { type: "string" },
          },
        }),
      },
      selector: '[data-setting="tags"] input',
      index: 1,
      initial: "beta",
      replacement: "edited",
      array: true,
      path: ["tags"],
      value: ["alpha", "edited"],
    },
    {
      name: "a literal dotted property without splitting its identity",
      overrides: {
        configHints: {},
        configValue: configValue({ "model.name": "first" }),
        configSchema: objectSchema({
          "model.name": { type: "string", title: "Model name" },
          empty: { type: "integer" },
        }),
      },
      selector: 'input[aria-label="Model name"]',
      initial: "first",
      replacement: "second",
      flat: true,
      path: ["model.name"],
      value: "second",
    },
  ])("edits $name on blur", async (entry) => {
    const { editor, model } = await mount(entry.overrides);
    if (entry.search) {
      await searchSettings(editor, entry.search);
    }
    if (entry.array) {
      const row = findElement(editor, '[data-setting="tags"]');
      expect(
        [...row.querySelectorAll<HTMLInputElement>("input")].map((input) => input.value),
      ).toEqual(["alpha", "beta"]);
      expect(row.textContent).not.toContain("2 items");
    }
    if (entry.flat) {
      expect(editor.querySelectorAll("[data-setting]")).toHaveLength(2);
      expect(editor.querySelectorAll("h2")).toHaveLength(0);
    }
    const input = editor.querySelectorAll<HTMLInputElement>(entry.selector).item(entry.index ?? 0)!;
    expect(input).not.toBeNull();
    expect(input.value).toBe(entry.initial ?? "original");
    input.focus();
    typeInto(input, entry.replacement ?? "changed");
    expect(model.onConfigPatch).not.toHaveBeenCalled();
    input.blur();
    expect(model.onConfigPatch).toHaveBeenCalledExactlyOnceWith(
      configPath(...entry.path),
      entry.value,
    );
  });
  it("keeps object array inputs aligned beside removal and finds their descendants", async () => {
    const { editor, model } = await mount({
      configHints: {},
      configValue: configValue({ targets: [{ path: "first", mode: "keep" }] }),
      configSchema: objectSchema({
        targets: {
          type: "array",
          items: objectSchema({
            path: { type: "string", title: "Directory" },
            mode: { type: "string", title: "Mode" },
          }),
        },
      }),
    });
    editor.style.width = "1000px";
    const inputs = [...editor.querySelectorAll<HTMLInputElement>(".cfg-array__item input")];
    expect(inputs).toHaveLength(2);
    const bounds = inputs.map((input) => input.getBoundingClientRect());
    const remove = findElement<HTMLButtonElement>(editor, 'button[aria-label="Remove item"]');
    const removeBounds = remove.getBoundingClientRect();
    expect(bounds[0]!.left).toBe(bounds[1]!.left);
    expect(bounds[1]!.top).toBeGreaterThan(bounds[0]!.bottom);
    expect(removeBounds.left).toBeGreaterThanOrEqual(bounds[0]!.right);
    expect(removeBounds.top).toBeLessThan(bounds[0]!.bottom);
    await searchSettings(editor, "directory");
    expect(editor.querySelectorAll(".cfg-array__item input")).toHaveLength(2);
    remove.click();
    expect(model.onConfigPatch).toHaveBeenCalledExactlyOnceWith(configPath("targets"), []);
  });
  it.each([
    { schema: { type: "string" }, value: REDACTED_SENTINEL, replacement: "replacement-key" },
    {
      schema: objectSchema({
        source: { type: "string" },
        provider: { type: "string" },
        id: { type: "string" },
      }),
      value: { source: "env", provider: "default", id: "SEARCH_API_KEY" },
      replacement: { source: "file", provider: "team", id: "/key" },
    },
  ])(
    "keeps a configured nested $schema.type credential as one specialized editor",
    async ({ schema, value, replacement }) => {
      const { editor, model, update } = await mount({
        configHints: { [`${prefix}.search.apiKey`]: { sensitive: true } },
        configValue: configValue({ search: { apiKey: value, mode: "web" } }),
        configSchema: objectSchema({
          search: objectSchema({
            apiKey: { ...schema, title: "API key" },
            mode: { type: "string", title: "Mode" },
          }),
        }),
      });
      const scope = {
        client: {
          request: vi.fn().mockResolvedValue({
            baseHash: "revision",
            credential:
              typeof value === "string"
                ? { kind: "literal" }
                : { kind: "reference", ref: value, unresolved: false },
          }),
        },
        epoch: 1,
      };
      const gateway = {
        epoch: 1,
        connected: true,
        capture: () => scope,
        isCurrent: (candidate: unknown) => candidate === scope,
      } as unknown as GatewayPageBinding;
      await update({
        resolveCredential: (field) =>
          field.path.at(-1) === "apiKey"
            ? {
                field,
                descriptor: { path: field.path, label: field.label, envVars: [] },
                context: {
                  pluginId: "fixture",
                  baseHash: "revision",
                  gateway,
                  canInspect: true,
                  onCommit: async (path, next) => {
                    field.onPatch(path, next);
                    return true;
                  },
                  onDiscard: async () => true,
                },
              }
            : undefined,
      });
      await vi.waitFor(() => expect(editor.textContent).not.toContain("Loading"));
      const credential = findElement(editor, "openclaw-plugin-credential-editor");
      expect(credential).not.toBeNull();
      expect(editor.textContent).not.toContain(REDACTED_SENTINEL);
      expect(editor.querySelector('input[aria-label="Search: Mode"]')).not.toBeNull();
      if (typeof replacement === "string") {
        const input = findElement<HTMLInputElement>(credential, "input");
        typeInto(input, replacement);
        flush();
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      } else {
        findElement<HTMLButtonElement>(credential, "button").click();
        await settle();
        const select = findElement<HTMLSelectElement>(credential, "select");
        select.value = replacement.source;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        flush();
        const inputs = credential.querySelectorAll<HTMLInputElement>(
          ".plugin-credential__dialog input",
        );
        for (const [index, next] of [replacement.provider, replacement.id].entries()) {
          typeInto(inputs[index]!, next);
          flush();
        }
        [...credential.querySelectorAll("button")]
          .find((button) => button.textContent?.trim() === "Save")!
          .click();
      }
      expect(model.onConfigPatch).toHaveBeenCalledExactlyOnceWith(
        configPath("search", "apiKey"),
        replacement,
      );
    },
  );
  it.each(["row", "input"])(
    "toggles from the checkbox %s once and ignores non-editing clicks",
    async (target) => {
      const { editor, model, update } = await mount();
      const row = findElement(editor, '[data-setting="enabled"]');
      const input = findElement<HTMLInputElement>(row, 'input[type="checkbox"]');
      expect(row).not.toBeNull();
      expect(input).not.toBeNull();
      const range = document.createRange();
      range.selectNodeContents(row.querySelector(".plugin-editor__title")!);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
      expect(getSelection()!.toString()).toBe("Enabled");
      row.click();
      expect(model.onConfigPatch).not.toHaveBeenCalled();
      getSelection()!.removeAllRanges();
      findElement<HTMLButtonElement>(row, 'button[aria-haspopup="menu"]').click();
      expect(model.onConfigPatch).not.toHaveBeenCalled();
      await settle();
      const menu = findElement(row, '[role="menu"]');
      expect(menu.matches(":popover-open")).toBe(true);
      menu.click();
      expect(model.onConfigPatch).not.toHaveBeenCalled();
      (target === "row" ? row : input).click();
      expect(model.onConfigPatch).toHaveBeenCalledExactlyOnceWith(configPath("enabled"), false);
      vi.mocked(model.onConfigPatch).mockClear();
      await update({ model: { ...model, canEditConfig: false } });
      row.click();
      expect(model.onConfigPatch).not.toHaveBeenCalled();
    },
  );
  it("retains empty object fields instead of silently dropping them", async () => {
    const { editor } = await mount({
      configHints: {},
      configSchema: objectSchema({ empty: { ...objectSchema({}), title: "Empty object" } }),
    });
    expect(editor.querySelectorAll("[data-setting]")).toHaveLength(1);
    expect(editor.textContent).toContain("Empty object");
  });
});

describe("grouped editor field discovery", () => {
  it("associates visible field instructions with native controls", async () => {
    const { editor } = await mount({
      configHints: {
        [`${prefix}.enabled`]: { help: "Capture messages for this plugin." },
        [`${prefix}.timeout`]: { help: "Wait this many seconds." },
        [`${prefix}.storage.path`]: { help: "Choose a local directory." },
      },
    });
    for (const name of ["Enabled", "Timeout", "Storage: Path"]) {
      const input = getField(editor, name);
      const ids = input.getAttribute("aria-describedby")?.trim().split(/\s+/u) ?? [];
      const instructions = input
        .closest(".plugin-editor__row")
        ?.querySelector(".plugin-editor__copy p");
      expect(instructions?.textContent?.trim()).toBeTruthy();
      expect(ids).toContain(instructions?.id);
      const descriptions = ids.map((id) => document.getElementById(id));
      expect(descriptions).toContain(instructions);
      expect(descriptions).not.toContain(null);
    }
  });

  it.each<{
    name: string;
    overrides: Partial<PluginSettingsEditorModel>;
    query: string;
  }>([
    { name: "authored groups", overrides: {}, query: "data storage" },
    {
      name: "dynamic root",
      overrides: {
        configSchema: { type: "object", properties: {}, additionalProperties: { type: "string" } },
        configHints: {},
        configValue: configValue({ alpha: "first", beta: "second" }),
      },
      query: "alpha",
    },
  ])("filters $name settings and shows unmatched searches", async ({ name, overrides, query }) => {
    const { editor } = await mount(overrides);
    await searchSettings(editor, query);
    if (name === "authored groups") {
      expect(editor.querySelectorAll("[data-setting]")).toHaveLength(2);
      expect(editor.textContent).toContain("Storage: Path");
      expect(editor.textContent).not.toContain("Timeout");
    } else {
      expect(
        editor.querySelector(".cfg-map > .settings-row .settings-row__title")?.textContent?.trim(),
      ).toBe("Custom entries");
      expect(editor.querySelector('input[aria-label="Key: alpha"]')).not.toBeNull();
      expect(editor.querySelector('input[aria-label="Key: beta"]')).toBeNull();
    }
    await searchSettings(editor, "does-not-match");
    expect(editor.querySelector(".cfg-map")).toBeNull();
    expect(editor.querySelector(".plugin-editor__empty")?.textContent).toContain(
      "No matching settings.",
    );
  });
});

describe("plugin map layout", () => {
  it.each([1728, 390])("keeps map labels, keys, and values usable at %s pixels", async (width) => {
    await page.viewport(width, 913);
    const { editor, model } = await mount({
      configHints: {},
      configValue: configValue({ populated: { first: 15 } }),
      configSchema: objectSchema({
        empty: {
          type: "object",
          title: "Empty overrides",
          additionalProperties: { type: "number" },
        },
        populated: {
          type: "object",
          title: "Populated overrides",
          additionalProperties: { type: "number" },
        },
      }),
    });
    editor.style.width = width > 768 ? "880px" : "100%";
    try {
      expect(textContents(editor, ".plugin-editor__title")).toEqual([
        "Empty overrides",
        "Populated overrides",
      ]);
      expect(editor.querySelector(".cfg-map > .settings-row .settings-row__title")).toBeNull();
      for (const add of editor.querySelectorAll<HTMLButtonElement>(
        ".cfg-map > .settings-row button",
      )) {
        const bounds = add.getBoundingClientRect();
        const mapBounds = add.closest(".cfg-map")!.getBoundingClientRect();
        expect(bounds.width).toBeGreaterThan(60);
        expect(bounds.height).toBeLessThan(48);
        expect(bounds.right).toBeLessThanOrEqual(mapBounds.right);
      }
      const key = getField(editor, "Key: first");
      expect(key.getBoundingClientRect().width).toBeGreaterThan(100);
      const value = findElement<HTMLInputElement>(
        editor,
        '[data-setting="populated"] input[type="number"]',
      );
      expect(value.getBoundingClientRect().width).toBeGreaterThan(100);
      expect(editor.scrollWidth).toBeLessThanOrEqual(editor.clientWidth);
      findElement<HTMLButtonElement>(
        editor,
        '[data-setting="populated"] button[aria-label="Remove entry"]',
      ).click();
      expect(model.onConfigPatch).toHaveBeenCalledExactlyOnceWith(configPath("populated"), {});
    } finally {
      await page.viewport(800, 600);
    }
  });
});
