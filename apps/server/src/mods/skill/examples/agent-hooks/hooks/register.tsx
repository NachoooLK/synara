import type { Register } from "synara";

const RULES = "Team rules: write a test for every fix, and never commit to main.";

export const register: Register = (on) => {
  on("mod.start", async ($) => {
    // Needs "tools" in mod.json. Agents see it as mod_agent_hooks_team_rules.
    await $.tool.register({
      name: "team_rules",
      description: "Returns this team's working rules. Call it before planning a change.",
      inputSchema: { type: "object", properties: {} },
    });
  });

  // Needs "tools". What the hook returns is the tool's result.
  on("tool.call", { tool: "team_rules" }, () => ({ rules: RULES }));

  // Needs "prompts". The thread keeps the message as the person wrote it.
  on("prompt.submit", async ($, e) => {
    if (/\bsk-[A-Za-z0-9]{20,}\b/u.test(e.text)) {
      return { block: "The message seems to hold an API key. Remove it and send again." };
    }
    if ((await $.store.get<boolean>("rulesOff")) === true) return;
    return { text: `${e.text}\n\n${RULES}` };
  });

  // Needs "approvals". A mod can deny, never approve; the person may answer first.
  on("approval.requested", { kind: "command" }, (_$, e) => {
    if (e.detail && /\bgit\s+push\b.*(--force|-f)\b/u.test(e.detail)) {
      return { deny: "Force pushes are not allowed in this team." };
    }
  });

  // Watching needs no permission and changes nothing.
  on("turn.completed", async ($, e) => {
    if (e.state !== "completed") return;
    const turns = ((await $.store.get<number>("turns")) ?? 0) + 1;
    await $.store.set("turns", turns);
    await $.ui.status(`${turns} turns finished`);
  });
};
