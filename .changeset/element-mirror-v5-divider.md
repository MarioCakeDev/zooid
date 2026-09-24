---
'@zooid/transport-matrix': patch
---

Mirror blocks: rule between tool input and output, and between tool calls

Each tool section now renders its compact `⚙` params and its `↳` output as two
visually distinct halves, and consecutive tool sections are separated so a group
with several tools reads as blocks rather than one run of lines.

- A horizontal rule sits between a tool's `⚙` params and its `↳` output when both
  are present (Option 3). A blank line plus a rule separates consecutive tool
  sections, regardless of entry count. A tool with only params or only output
  gets no rule.
- The rule is one literal `────────────────` line in the plain `body` and `<hr>`
  in the `formatted_body`, so Element X (which ignores `<details>` and shows the
  plain body) and Element Web read the same.
- The 8 KB escaped-body budget now charges each entry for the separator, so the
  added rules can never push a group over the cap.
- Everything else is unchanged: the `<details>`/`<summary>` group, the 200-char
  params/output caps, `… K more`, the `dev.zooid.mirror` marker, the thread
  relation, the edit shape, and HTML escaping.
