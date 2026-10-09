import { Box, Button, Input, Text, type Register } from "synara";

export const register: Register = (on) => {
  on("mod.start", async ($) => {
    await $.ui.view({ id: "note", site: "band", title: "Thread note" });
  });

  on("ui.render", { view: "note" }, async ($, e) => {
    // Bands draw for the open thread; return null to draw nothing.
    if (!e.context.threadId) return null;
    const key = `note:${e.context.threadId}`;
    const note = await $.store.get<string>(key);
    return (
      <Box direction="row" align="center" gap={2}>
        <Text size="sm" tone="muted">
          Note:
        </Text>
        {note ? (
          <>
            <Text size="sm" truncate>
              {note}
            </Text>
            <Button
              icon="trash-can"
              label="Delete note"
              variant="ghost"
              onPress={async () => {
                await $.store.delete(key);
                await $.ui.invalidate("note");
              }}
            />
          </>
        ) : (
          <Input
            placeholder="Write a note and press Enter"
            onSubmit={async (value) => {
              await $.store.set(key, value);
              await $.ui.invalidate("note");
            }}
          />
        )}
      </Box>
    );
  });
};
