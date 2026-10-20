import { createSignal, flush } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { page } from "vitest/browser";
import { REDACTED_SENTINEL, type JsonSchema } from "../../lib/config-form-utils.ts";
import { GatewayPageBinding } from "../../lib/gateway-page-binding.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { pageFixture } from "./plugins-page.lifecycle-test-support.ts";
import { createClient, createGateway } from "./plugins-page.test-support.ts";
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
const configValue = (config: Record<string, unknown>) => ({
  plugins: { entries: { fixture: { config } } },
});
const objectSchema = (properties: Record<string, JsonSchema>): JsonSchema => ({
  type: "object",
  additionalProperties: false,
  properties,
});
const mountConfig = (value: Record<string, unknown>, properties: Record<string, JsonSchema>) =>
  mount({
    configHints: {},
    configValue: configValue(value),
    configSchema: objectSchema(properties),
  });
const textSchema = (title: string): JsonSchema => ({ type: "string", title });
function makeModel(overrides: Partial<PluginSettingsEditorModel> = {}): PluginSettingsEditorModel {
  return {
    pluginId: "fixture",
    result: null,
    connected: true,
    configValue: configValue({ enabled: true }),
    configSchema: objectSchema({
      enabled: { type: "boolean", title: "Enabled", default: false },
      storage: {
        ...objectSchema({ path: textSchema("Path"), mode: textSchema("Mode") }),
        default: { path: "original", mode: "keep" },
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
}
async function mount(overrides: Partial<PluginSettingsEditorModel> = {}) {
  const model = makeModel(overrides);
  const [props, setProps] = createSignal<PluginSettingsEditorProps>({ model });
  const { container: host } = mountSolid(() => <PluginSettingsEditor {...props()} />);
  const editor = host.querySelector<HTMLElement>("openclaw-plugin-settings-editor")!;
  const update = async (next: Partial<PluginSettingsEditorProps>) => {
    setProps((current) => ({ ...current, ...next }));
    await settle();
  };
  await settle();
  return { editor, model, update };
}
async function searchSettings(editor: HTMLElement, search: string) {
  const input = editor.querySelector<HTMLInputElement>('input[type="search"]')!;
  expect(input).not.toBeNull();
  typeInto(input, search);
  await settle();
}
async function settle() {
  flush();
  await Promise.resolve();
  flush();
}
function editField(
  model: PluginSettingsEditorModel,
  input: HTMLInputElement,
  before: string,
  after: string,
  path: string[],
  value: unknown,
) {
  expect(input).not.toBeNull();
  expect(input.value).toBe(before);
  input.focus();
  typeInto(input, after);
  expect(model.onConfigPatch).not.toHaveBeenCalled();
  input.blur();
  expect(model.onConfigPatch).toHaveBeenCalledExactlyOnceWith(configPath(...path), value);
}
it("keeps typing and focus in Advanced settings when configuration updates", async () => {
  const [value, setValue] = createSignal({ plugins: { label: "" } });
  const schema = objectSchema({ label: textSchema("Label") });
  const onPatch = vi.fn((_path: Array<string | number>, next: unknown) => {
    setValue({ plugins: { label: String(next) } });
  });
  const { context } = pageFixture({});
  const provider = createSolidApplicationContextProvider(context);
  const model = makeModel({ configHints: {} });
  const mounted = mountSolid(
    () => (
      <PluginSettingsInventory
        {...model}
        tab="advanced"
        query=""
        loading={false}
        error={null}
        busy={{}}
        messages={{}}
        iconUrls={{}}
        canMutate
        mutationBlockedReason={null}
        configValue={value()}
        advancedSchema={schema}
        onConfigPatch={onPatch}
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
  const target = editor.querySelector<HTMLElement>(links[1]!.getAttribute("href")!)!;
  const scroll = vi.spyOn(target, "scrollIntoView");
  links[1]!.click();
  expect(scroll).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(target);
  expect(editor.querySelectorAll("[data-setting]")).toHaveLength(4);
  expect(editor.querySelector("h1")).toBeNull();
  expect(textContents(editor, "h2")).toEqual(["Data storage", "Capture", "Other"]);
  const back = editor.querySelector<HTMLAnchorElement>(".plugins-settings-breadcrumb__parent")!;
  expect(back.getAttribute("href")).toBe("/settings/plugins/fixture");
  back.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  expect(model.onBack).toHaveBeenCalledOnce();
  expect(editor.querySelector('[aria-current="page"]')?.textContent?.trim()).toBe("Settings");
  expect(editor.textContent).not.toContain(prefix);
  expect(editor.textContent).not.toMatch(/\d+ settings/);
  await update({ model: { ...model, configHints: {} } });
  expect(editor.querySelector(".plugin-editor__nav")).toBeNull();
});
it("does not persist an automatic numeric placeholder on blur", async () => {
  const { editor, model } = await mount({
    configHints: { [`${prefix}.timeout`]: { placeholder: "Automatic" } },
    configSchema: {
      type: "object",
      properties: { timeout: { type: "integer", title: "Timeout" } },
    },
  });
  const input = getField(editor, "Timeout");
  expect(input).toMatchObject({ value: "", placeholder: "Automatic" });
  input.focus();
  input.blur();
  expect(model.onConfigPatch).not.toHaveBeenCalled();
});
it("persists inherited defaults only after editing, without losing siblings", async () => {
  const { editor, model } = await mount();
  for (const [label, value] of [
    ["Storage: Path", "original"],
    ["Timeout", "30"],
  ]) {
    const input = getField(editor, label!);
    expect(input.value).toBe(value);
    input.focus();
    input.blur();
  }
  expect(model.onConfigPatch).not.toHaveBeenCalled();
  editField(model, getField(editor, "Storage: Path"), "original", "changed", ["storage"], {
    path: "changed",
    mode: "keep",
  });
});
it("edits a searched descendant inside a retained object on blur", async () => {
  const { editor, model } = await mountConfig(
    { storage: { path: "original" } },
    {
      storage: {
        type: "object",
        title: "Storage",
        properties: { path: textSchema("Directory") },
      },
    },
  );
  await searchSettings(editor, "directory");
  const input = getField(editor, "Directory");
  editField(model, input, "original", "changed", ["storage", "path"], "changed");
});
it("edits inherited array items on blur without losing siblings", async () => {
  const { editor, model } = await mountConfig(
    {},
    {
      tags: {
        type: "array",
        title: "Tags",
        default: ["alpha", "beta"],
        items: { type: "string" },
      },
    },
  );
  const row = editor.querySelector<HTMLElement>('[data-setting="tags"]')!;
  const inputs = row.querySelectorAll<HTMLInputElement>("input");
  expect([...inputs].map((input) => input.value)).toEqual(["alpha", "beta"]);
  expect(row.textContent).not.toContain("2 items");
  editField(model, inputs[1]!, "beta", "edited", ["tags"], ["alpha", "edited"]);
});
it("keeps dotted and empty-object fields intact while editing on blur", async () => {
  const { editor, model } = await mountConfig(
    { "model.name": "first" },
    {
      "model.name": textSchema("Model name"),
      empty: { ...objectSchema({}), title: "Empty object" },
    },
  );
  expect(editor.querySelectorAll("[data-setting]")).toHaveLength(2);
  expect(editor.querySelectorAll("h2")).toHaveLength(0);
  expect(editor.textContent).toContain("Empty object");
  editField(model, getField(editor, "Model name"), "first", "second", ["model.name"], "second");
});
it("keeps object array inputs aligned beside removal and finds their descendants", async () => {
  const { editor, model } = await mountConfig(
    { targets: [{ path: "first", mode: "keep" }] },
    {
      targets: {
        type: "array",
        items: objectSchema({
          path: textSchema("Directory"),
          mode: textSchema("Mode"),
        }),
      },
    },
  );
  editor.style.width = "1000px";
  const inputs = [...editor.querySelectorAll<HTMLInputElement>(".cfg-array__item input")];
  expect(inputs).toHaveLength(2);
  const bounds = inputs.map((input) => input.getBoundingClientRect());
  const remove = editor.querySelector<HTMLButtonElement>('button[aria-label="Remove item"]')!;
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
    const { client } = createClient(async () => ({
      baseHash: "revision",
      credential:
        typeof value === "string"
          ? { kind: "literal" }
          : { kind: "reference", ref: value, unresolved: false },
    }));
    const application = createGateway(client).gateway;
    const gateway = new GatewayPageBinding(vi.fn(), { getGateway: () => application });
    gateway.connect();
    onTestFinished(() => gateway.dispose());
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
    const credential = editor.querySelector<HTMLElement>("openclaw-plugin-credential-editor")!;
    expect(credential).not.toBeNull();
    expect(editor.textContent).not.toContain(REDACTED_SENTINEL);
    expect(editor.querySelector('input[aria-label="Search: Mode"]')).not.toBeNull();
    if (typeof replacement === "string") {
      const input = credential.querySelector<HTMLInputElement>("input")!;
      typeInto(input, replacement);
      flush();
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    } else {
      credential.querySelector<HTMLButtonElement>("button")!.click();
      await settle();
      const select = credential.querySelector<HTMLSelectElement>("select")!;
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
    const row = editor.querySelector<HTMLElement>('[data-setting="enabled"]')!;
    const input = row.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
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
    row.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!.click();
    expect(model.onConfigPatch).not.toHaveBeenCalled();
    await settle();
    const menu = row.querySelector<HTMLElement>('[role="menu"]')!;
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
it.each([1728, 390])("keeps map labels, keys, and values usable at %s pixels", async (width) => {
  await page.viewport(width, 913);
  const { editor, model } = await mountConfig(
    { populated: { first: 15 } },
    {
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
    },
  );
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
    const value = editor.querySelector<HTMLInputElement>(
      '[data-setting="populated"] input[type="number"]',
    )!;
    expect(value.getBoundingClientRect().width).toBeGreaterThan(100);
    expect(editor.scrollWidth).toBeLessThanOrEqual(editor.clientWidth);
    editor
      .querySelector<HTMLButtonElement>(
        '[data-setting="populated"] button[aria-label="Remove entry"]',
      )!
      .click();
    expect(model.onConfigPatch).toHaveBeenCalledExactlyOnceWith(configPath("populated"), {});
  } finally {
    await page.viewport(800, 600);
  }
});
