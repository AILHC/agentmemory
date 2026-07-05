import { describe, expect, it } from "vitest";

import { parseFactResponse } from "../src/prompts/facts.js";

describe("parseFactResponse", () => {
  it("parses semantic facts with confidence attributes", () => {
    expect(
      parseFactResponse('<facts><fact confidence="0.9">事实</fact></facts>'),
    ).toEqual([{ fact: "事实", confidence: 0.9 }]);
  });

  it("returns an empty array for empty facts", () => {
    expect(parseFactResponse("<facts></facts>")).toEqual([]);
  });

  it("returns an empty array for malformed text", () => {
    expect(parseFactResponse("not xml <fact>missing close")).toEqual([]);
  });
});
