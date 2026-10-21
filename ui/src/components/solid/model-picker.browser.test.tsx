import { createSignal, type Component } from "solid-js";
import { expect, it, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { choosePickerValue, openPicker, updatePickers } from "../../test-helpers/select-picker.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import type { SelectPicker } from "../select-picker.ts";
import { DecisionModelPicker, type DecisionModelPickerParams } from "./decision-model-picker.tsx";
import { ModelPicker, type ModelPickerParams } from "./model-picker.tsx";

async function mountPicker<P extends object>(View: Component<P>, initial: P) {
  const [params, setParams] = createSignal(initial);
  const { container } = mountSolid(() => <View {...params()} />);
  const query = <T extends Element>(selector: string) => container.querySelector<T>(selector)!;
  const update = async (patch: Partial<P>) => {
    setParams((current) => ({ ...current, ...patch }));
    flush();
    await updatePickers(container);
  };
  await updatePickers(container);
  const picker = query<SelectPicker>("openclaw-select-picker");
  const expectUpdated = (label: string) => {
    expect(query("openclaw-select-picker")).toBe(picker);
    expect(query<HTMLButtonElement>(".picker-select__trigger").disabled).toBe(true);
    expect(picker.textContent).toContain(label);
  };
  return { picker, query, update, expectUpdated };
}

it("renders provider details and keeps the picker owner through updates", async () => {
  const onChange = vi.fn();
  const { picker, query, update, expectUpdated } = await mountPicker<ModelPickerParams>(
    ModelPicker,
    {
      label: "Model",
      value: "openai/selected",
      groupByProvider: true,
      showSelectedDetail: true,
      options: [
        { value: "", label: "Automatic" },
        { value: "openai/selected", label: "Selected", provider: "openai", detail: "API" },
      ],
      onChange,
    },
  );
  const trigger = query<HTMLButtonElement>(".picker-select__trigger");
  expect(trigger.textContent).toContain("Selected");
  expect(trigger.textContent).toContain("API");
  expect(trigger.querySelector('[data-provider-icon="codex"]')).not.toBeNull();
  await openPicker(picker);
  const group = query('[role="group"][aria-label="OpenAI"]');
  expect(group.querySelector('[data-provider-icon="codex"]')).not.toBeNull();
  await choosePickerValue(picker, "");
  expect(onChange).toHaveBeenCalledExactlyOnceWith("");
  await update({
    value: "openai/new",
    disabled: true,
    options: [{ value: "openai/new", label: "New model", provider: "openai" }],
  });
  expectUpdated("New model");
});

it("keeps custom sentinels private and commits only on the configured event", async () => {
  const onChange = vi.fn();
  const sentinel = "__openclaw_custom_model__";
  const { picker, query } = await mountPicker<ModelPickerParams>(ModelPicker, {
    label: "Model",
    value: "vendor/current",
    options: [{ value: sentinel, label: "Real model" }],
    custom: { label: "Custom model", commit: "change" },
    onChange,
  });
  const input = query<HTMLInputElement>(".model-picker__custom");
  await openPicker(picker);
  const custom = [...picker.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (row) => row.textContent?.trim() === "Custom model",
  )!;
  await choosePickerValue(picker, sentinel);
  expect(input.hidden).toBe(true);
  expect(onChange).toHaveBeenCalledExactlyOnceWith(sentinel);
  onChange.mockClear();
  await choosePickerValue(picker, custom.dataset.value!);
  expect(input.hidden).toBe(false);
  expect(document.activeElement).toBe(input);
  expect(onChange).not.toHaveBeenCalled();
  input.value = "vendor/custom model";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  expect(onChange).not.toHaveBeenCalled();
  input.dispatchEvent(new Event("change", { bubbles: true }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith("vendor/custom model");
});

it("retains the decision picker owner across catalog and disabled-state updates", async () => {
  const { update, expectUpdated } = await mountPicker<DecisionModelPickerParams>(
    DecisionModelPicker,
    {
      id: "decision",
      models: [{ id: "old", name: "Old", provider: "x", pluginId: "x" }],
      value: null,
      inherit: { model: "x/old" },
      disabled: false,
      onChange: vi.fn(),
    },
  );
  await update({
    models: [{ id: "new", name: "New", provider: "x", pluginId: "x" }],
    value: "x/new",
    disabled: true,
  });
  expectUpdated("New");
});
