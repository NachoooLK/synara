import type { Register } from "synara";

export const register: Register = (on) => {
  on("mod.start", async ($) => {
    await $.command.register({
      name: "count-threads",
      title: "Count my threads",
      description: "Says how many threads and projects you have.",
    });
    await $.ui.status("Ready");
  });

  on("command.run", { command: "count-threads" }, async ($) => {
    const threads = await $.threads.list({ includeArchived: true, limit: 1000 });
    const projects = (await $.projects.list()).filter((project) => project.kind === "project");
    const runs = ((await $.store.get<number>("runs")) ?? 0) + 1;
    await $.store.set("runs", runs);
    console.log(`count-threads ran ${runs} times`);
    // The returned text becomes a toast in the window that ran the command.
    return { text: `${threads.length} threads in ${projects.length} projects.` };
  });
};
