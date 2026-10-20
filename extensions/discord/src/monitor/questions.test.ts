import { InteractionResponseType, MessageFlags } from "discord-api-types/v10";
import { describe, expect, it, vi } from "vitest";
import {
  createInteraction as createDiscordInteraction,
  type BaseComponentInteraction,
} from "../internal/discord.js";
import {
  attachRestMock,
  createInternalComponentInteractionPayload,
  createInternalTestClient,
} from "../internal/test-builders.test-support.js";
import { createDiscordQuestionButton } from "./questions.js";

const answer = { status: "answered" as const, questionId: "target", optionValue: "Production" };
const data = { id: "ask_0123456789abcdef0123456789abcdef", i: "1" };
const callbackPath = "/interactions/interaction-1/interaction-token/callback";
type ButtonParams = Parameters<typeof createDiscordQuestionButton>[0];
function createButton(overrides: Partial<ButtonParams> = {}) {
  return createDiscordQuestionButton({
    cfg: {} as never,
    accountId: "default",
    authorizeQuestion: vi.fn(async () => true),
    resolveQuestion: vi.fn(async () => answer),
    ...overrides,
  });
}

function createInteraction() {
  const acknowledge = vi.fn();
  const followUp = vi.fn();
  const interaction = {
    userId: "user-1",
    reply: vi.fn(),
    acknowledge,
    followUp,
  } as unknown as BaseComponentInteraction;
  return { interaction, acknowledge, followUp };
}

describe("Discord question button", () => {
  it("does not resolve unauthorized clicks", async () => {
    const { interaction, acknowledge } = createInteraction();
    const resolveQuestion = vi.fn();
    const button = createButton({ authorizeQuestion: vi.fn(async () => false), resolveQuestion });

    await button.run(interaction, data);

    expect(resolveQuestion).not.toHaveBeenCalled();
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it("does not turn a committed answer into an error when feedback fails", async () => {
    const { interaction, followUp } = createInteraction();
    followUp.mockRejectedValue(new Error("receipt failed"));
    await expect(createButton().run(interaction, data)).resolves.toBeUndefined();
    expect(followUp).toHaveBeenCalledOnce();
    expect(followUp).toHaveBeenCalledWith({ content: "Answer submitted.", ephemeral: true });
  });

  it.each([
    {
      name: "submitted answer",
      acknowledged: false,
      result: answer,
      expectedText: "Answer submitted.",
    },
    {
      name: "already answered question",
      acknowledged: true,
      result: { status: "already-terminal" as const, reason: "already-terminal" as const },
      expectedText: "This question was already answered.",
    },
    {
      name: "question resolution failure",
      acknowledged: true,
      error: new Error("question service unavailable"),
      expectedText: "Could not submit this answer.",
    },
  ])("delivers $name feedback when acknowledgement is $acknowledged", async (testCase) => {
    const client = createInternalTestClient();
    const post = vi.fn(async () => undefined);
    if (!testCase.acknowledged) {
      post.mockRejectedValueOnce(new Error("temporary connection reset"));
    }
    attachRestMock(client, { post });
    const interaction = createDiscordInteraction(
      client,
      createInternalComponentInteractionPayload({
        id: "interaction-1",
        token: "interaction-token",
        user: {
          id: "user-1",
          username: "Alice",
          discriminator: "0",
          avatar: null,
          global_name: null,
        },
      }),
    ) as BaseComponentInteraction;
    const resolveQuestion = vi.fn(async () => {
      if (testCase.error) {
        throw testCase.error;
      }
      return testCase.result;
    });
    await createButton({ resolveQuestion: resolveQuestion as never }).run(interaction, data);

    expect(resolveQuestion).toHaveBeenCalledOnce();
    expect(post).toHaveBeenNthCalledWith(1, callbackPath, {
      body: { type: InteractionResponseType.DeferredMessageUpdate },
    });
    if (testCase.acknowledged) {
      expect(post).toHaveBeenNthCalledWith(
        2,
        "/webhooks/app1/interaction-token",
        { body: { content: testCase.expectedText, flags: MessageFlags.Ephemeral } },
        undefined,
      );
      expect(interaction.responseState).toBe("deferred-update");
    } else {
      expect(post).toHaveBeenNthCalledWith(2, callbackPath, {
        body: {
          type: InteractionResponseType.ChannelMessageWithSource,
          data: { content: testCase.expectedText, flags: MessageFlags.Ephemeral },
        },
      });
      expect(interaction.responseState).toBe("replied");
    }
  });
});
