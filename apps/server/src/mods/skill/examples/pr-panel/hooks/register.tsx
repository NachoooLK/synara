import { Badge, Box, Button, Code, Markdown, Row, Section, Text, type Register } from "synara";

import { PULL_REQUESTS } from "./data";

export const register: Register = (on) => {
  on("mod.start", async ($) => {
    await $.ui.view({ id: "prs", site: "dock", title: "Pull requests", icon: "pull-request" });
    await $.ui.view({ id: "open-prs", site: "header", title: "Open pull requests" });
  });

  // Header views are small: a button or two. The header hides them on an empty thread.
  on("ui.render", { view: "open-prs" }, ($) => (
    <Button icon="pull-request" onPress={() => $.ui.openDockView("prs")}>
      PRs
    </Button>
  ));

  on("ui.render", { view: "prs" }, async ($) => {
    const selected = await $.state.get<number>("selected");
    const pr = PULL_REQUESTS.find((item) => item.id === selected);
    if (pr) {
      return (
        <Box gap={3}>
          <Box direction="row" align="center" gap={2}>
            <Button
              icon="arrow-left"
              label="Back"
              onPress={() => $.state.set("selected", undefined)}
            />
            <Text weight="semibold" truncate>{`#${pr.id} ${pr.title}`}</Text>
            <Badge tone={pr.state === "OPEN" ? "success" : "secondary"}>{pr.state}</Badge>
          </Box>
          <Markdown text={pr.description} />
          <Code text={pr.diff} />
        </Box>
      );
    }
    return (
      <Section title="Pull requests">
        {PULL_REQUESTS.map((item) => (
          <Row
            key={item.id}
            icon="pull-request"
            meta={item.author}
            onPress={() => $.state.set("selected", item.id)}
          >
            {`#${item.id} ${item.title}`}
          </Row>
        ))}
      </Section>
    );
  });
};
