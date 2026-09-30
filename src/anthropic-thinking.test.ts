import { describe, expect, it } from "vite-plus/test";

import { fitAnthropicBodyToModel } from "./anthropic-thinking";

/** A body as Claude Code writes it for a current model (Claude Code 2.1.2xx). */
function claudeCodeBody(model: string): Record<string, unknown> {
  return {
    model,
    max_tokens: 32000,
    system: [{ type: "text", text: "You are Claude Code." }],
    thinking: { type: "adaptive", display: "omitted" },
    output_config: { effort: "medium" },
    context_management: {
      edits: [{ type: "clear_thinking_20251015" }, { type: "clear_tool_uses_20250919" }],
    },
    messages: [
      { role: "user", content: "hi" },
      { role: "system", content: [{ type: "text", text: "# Environment\ncwd: /repo" }] },
    ],
  };
}

describe("fitAnthropicBodyToModel", () => {
  it("strips what Haiku 4.5 rejects and keeps the system context", () => {
    const out = fitAnthropicBodyToModel(claudeCodeBody("claude-haiku-4-5"));
    expect(out.thinking).toBeUndefined();
    expect(out.output_config).toBeUndefined();
    expect(out.context_management).toEqual({ edits: [{ type: "clear_tool_uses_20250919" }] });
    expect(out.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(out.system).toEqual([
      { type: "text", text: "You are Claude Code." },
      { type: "text", text: "# Environment\ncwd: /repo" },
    ]);
    expect(out.max_tokens).toBe(32000);
  });

  it("drops context_management when only thinking edits were left", () => {
    const body = claudeCodeBody("claude-haiku-4-5");
    body.context_management = { edits: [{ type: "clear_thinking_20251015" }] };
    expect(fitAnthropicBodyToModel(body).context_management).toBeUndefined();
  });

  it("turns a string system prompt into blocks when it has to append", () => {
    const body = claudeCodeBody("claude-haiku-4-5");
    body.system = "Be brief.";
    expect(fitAnthropicBodyToModel(body).system).toEqual([
      { type: "text", text: "Be brief." },
      { type: "text", text: "# Environment\ncwd: /repo" },
    ]);
  });

  it("leaves current models untouched", () => {
    for (const model of ["claude-opus-5-5", "claude-sonnet-5"]) {
      const body = claudeCodeBody(model);
      expect(fitAnthropicBodyToModel(body)).toBe(body);
    }
  });
});
