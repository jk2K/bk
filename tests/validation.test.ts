import { test } from "node:test";
import assert from "node:assert/strict";
import { validateMarkdown } from "../src/validation/index.js";
test("Mermaid parser accepts valid diagrams and rejects broken syntax", async () => {
  await validateMarkdown(
    "```mermaid\nflowchart TD\n A[Order] --> B[Payment]\n```",
  );
  await assert.rejects(() =>
    validateMarkdown("```mermaid\nflowchart TD\n A[broken\n```"),
  );
});
test("Markdown cannot embed script or interactive Mermaid directives", async () => {
  await assert.rejects(
    () => validateMarkdown("[run](javascript:alert(1))"),
    /Unsafe/,
  );
  await assert.rejects(
    () =>
      validateMarkdown(
        '```mermaid\nflowchart TD\nclick A "https://evil.example"\n```',
      ),
    /Unsafe/,
  );
});
