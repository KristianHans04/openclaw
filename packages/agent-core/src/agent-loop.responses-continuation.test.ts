import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { streamOpenAICodexResponses } from "../../ai/src/providers/openai-chatgpt-responses.js";
import {
  captureAgentLoop,
  config,
  makeTool,
  model as baseModel,
  user,
} from "./agent-loop.test-support.js";
import type { Model } from "./llm.js";

function textItem(id: string, text: string) {
  return {
    type: "message",
    id,
    role: "assistant",
    status: "completed",
    phase: "final_answer",
    content: [{ type: "output_text", text, annotations: [] }],
  };
}

describe("Responses turn continuation", () => {
  it("continues end_turn:false text through a tool result to the final answer", async () => {
    const requests: ResponseCreateParamsStreaming[] = [];
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    server.on("connection", (socket) => {
      socket.on("message", (data) => {
        const bytes = Buffer.isBuffer(data)
          ? data
          : Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.from(data);
        requests.push(JSON.parse(bytes.toString("utf8")) as ResponseCreateParamsStreaming);
        const index = requests.length;
        const output =
          index === 1
            ? [textItem("msg_progress", "I am checking the result.")]
            : index === 2
              ? [
                  {
                    type: "function_call",
                    id: "fc_check",
                    call_id: "call_check",
                    name: "check",
                    arguments: "{}",
                    status: "completed",
                  },
                ]
              : [textItem("msg_final", "The check passed.")];
        socket.send(
          JSON.stringify({
            type: "response.completed",
            response: {
              id: `resp_${index}`,
              status: "completed",
              end_turn: index === 3,
              output,
              usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
            },
          }),
        );
      });
    });
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const model: Model<"openai-chatgpt-responses"> = {
      ...baseModel,
      name: "Test model",
      provider: "openai",
      api: "openai-chatgpt-responses",
      baseUrl: `http://127.0.0.1:${port}/backend-api`,
      reasoning: true,
      contextWindow: 8192,
      maxTokens: 256,
    };
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const apiKey = `${encode({ alg: "none", typ: "JWT" })}.${encode({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-loopback" } })}.signature`;
    const execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "checked" }],
      details: {},
    }));
    const tool = {
      ...makeTool("check"),
      label: "Check",
      description: "Check the result",
      parameters: Type.Object({}),
      execute,
    };
    try {
      const run = captureAgentLoop(
        [user("Check the result and report it.")],
        { systemPrompt: "", messages: [], tools: [tool] },
        { ...config, model },
        undefined,
        (_model, context, options) =>
          streamOpenAICodexResponses(model, context, {
            ...options,
            apiKey,
            transport: "websocket",
          }),
      );
      const result = await run.result;
      expect(requests).toHaveLength(3);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(run.events.filter((event) => event.type === "agent_end")).toHaveLength(1);
      const assistants = result
        .filter((message) => message.role === "assistant")
        .filter((message) => message.responseId !== undefined);
      expect(assistants).toHaveLength(3);
      for (const [index, assistant] of assistants.entries()) {
        expect(assistant.diagnostics).toEqual([
          {
            type: "openai_responses_terminal",
            timestamp: expect.any(Number),
            details: {
              eventType: "response.completed",
              stopReason: "stop",
              endTurn: index === 2,
            },
          },
        ]);
      }
      expect(JSON.stringify(requests)).not.toContain("openai_responses_terminal");
      expect(result.at(-1)).toMatchObject({
        role: "assistant",
        content: [expect.objectContaining({ text: "The check passed." })],
      });
      const expectInput = (index: number, item: object) =>
        expect(requests[index]?.input).toEqual(
          expect.arrayContaining([expect.objectContaining(item)]),
        );
      expectInput(1, {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [expect.objectContaining({ text: "I am checking the result." })],
      });
      expectInput(2, { type: "function_call_output", call_id: "call_check", output: "checked" });
    } finally {
      for (const socket of server.clients) {
        socket.terminate();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
