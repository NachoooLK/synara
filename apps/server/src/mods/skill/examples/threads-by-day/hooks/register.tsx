import { Box, Empty, Row, Section, Switch, Text, type ModThread, type Register } from "synara";

const day = (iso: string): string => iso.slice(0, 10);

export const register: Register = (on) => {
  on("mod.start", async ($) => {
    await $.ui.view({
      id: "by-day",
      site: "sidebar",
      title: "Threads by day",
      icon: "calendar-1",
      // Redraws by itself when threads change.
      refreshOn: ["threads"],
    });
  });

  on("ui.render", { view: "by-day" }, async ($, e) => {
    const threads = await $.threads.list({ limit: 200 });
    const onlyPinned = (await $.state.get<boolean>("onlyPinned")) ?? false;
    const visible = onlyPinned ? threads.filter((thread) => thread.isPinned) : threads;
    const groups = new Map<string, ModThread[]>();
    for (const thread of visible) {
      const key = day(thread.updatedAt);
      groups.set(key, [...(groups.get(key) ?? []), thread]);
    }
    return (
      <Box gap={2}>
        <Box paddingX={2}>
          <Switch
            label="Pinned only"
            checked={onlyPinned}
            // $.state.set redraws the mod's views.
            onChange={(checked) => $.state.set("onlyPinned", checked)}
          />
        </Box>
        {visible.length === 0 ? (
          <Empty title="No threads" description="New threads show up here." />
        ) : null}
        {[...groups].map(([date, items]) => (
          <Section key={date} title={date}>
            {items.map((thread) => (
              <Row
                key={thread.id}
                icon={thread.isPinned ? "pin" : "bubble-text"}
                active={thread.id === e.context.threadId}
                meta={thread.provider}
                onPress={() => $.ui.openThread(thread.id)}
              >
                {thread.title}
              </Row>
            ))}
          </Section>
        ))}
        <Box paddingX={2}>
          <Text size="xs" tone="muted">{`${visible.length} threads`}</Text>
        </Box>
      </Box>
    );
  });
};
