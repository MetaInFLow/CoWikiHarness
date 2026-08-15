import { describe, expect, it } from "vitest";

import { KnowledgeOperations } from "../src/operations.js";

const runPostgres = process.env.OPENLIFEWIKI_POSTGRES_TEST === "1";
const describePostgres = runPostgres ? describe : describe.skip;

describePostgres("typed cloud knowledge operations", () => {
  it("exposes registry operations without a model dependency", () => {
    expect(KnowledgeOperations).toBeDefined();
  });
});
