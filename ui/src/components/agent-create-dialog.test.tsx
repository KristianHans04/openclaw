import { flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
import { createApplicationGateway } from "../test-helpers/application-context.ts";
import { mountSolid } from "../test-helpers/solid-render.tsx";
import { AgentCreateDialog } from "./agent-create-dialog.tsx";

const picker = vi.hoisted(() => ({ select: null as ((avatar: string) => void) | null }));
const selectedAvatar = "data:image/webp;base64,Ym90";
// mock-isolation: exercise the dialog's name and selection contract without mounting the avatar generator.
vi.mock("../pages/agents/avatar-picker.tsx", () => ({
  AvatarPicker: (props: { onSelect: (avatar: string) => void }) => {
    picker.select = props.onSelect;
    return <div data-testid="choose-avatar" />;
  },
}));

afterEach(() => document.body.replaceChildren());

function dialogContext(): ApplicationContext {
  const { gateway } = createApplicationGateway();
  // The picker is mocked; these interactions only read the Gateway and agent roster.
  return { gateway, agents: { state: { agentsList: null } } } as ApplicationContext;
}

it("requires a display name and submits the selected Blobster identity", () => {
  const onCancel = vi.fn();
  const onCreate = vi.fn();
  const view = mountSolid(AgentCreateDialog, { context: dialogContext(), onCancel, onCreate });
  document.body.append(view.container);

  const name = view.container.querySelector<HTMLInputElement>('input[name="name"]')!;
  const create = view.container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  expect(view.container.querySelector("h2")?.textContent).toBe("Create New Agent");
  expect(name.placeholder).toBe("Name your agent");
  expect(
    view.container.querySelector(".agent-create-dialog__ghost .lobster-pet__svg"),
  ).not.toBeNull();
  expect(create.disabled).toBe(true);
  name.value = "  Scout  ";
  name.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
  expect(create.disabled).toBe(false);
  picker.select!(selectedAvatar);
  flush();
  expect(view.container.querySelector(".agent-create-dialog__ghost")).toBeNull();
  expect(
    view.container.querySelector(".agent-create-dialog__preview .identity-avatar--agent"),
  ).not.toBeNull();
  create.click();

  expect(onCreate).toHaveBeenCalledExactlyOnceWith({ name: "Scout", avatar: selectedAvatar });
  expect(onCancel).not.toHaveBeenCalled();
  view.dispose();
});

it("cancels without creating an agent", () => {
  const onCancel = vi.fn();
  const onCreate = vi.fn();
  const view = mountSolid(AgentCreateDialog, { context: dialogContext(), onCancel, onCreate });
  document.body.append(view.container);

  view.container.querySelector<HTMLButtonElement>('[data-action="cancel"]')!.click();

  expect(onCancel).toHaveBeenCalledOnce();
  expect(onCreate).not.toHaveBeenCalled();
  view.dispose();
});
