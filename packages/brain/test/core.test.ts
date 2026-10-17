import { describe, expect, it } from "vitest";
import { splitText } from "../src/brain/chunk.ts";
import { AccountMatcher, accountId, mergeEntities, personId, slug } from "../src/brain/entities.ts";
import { rrf } from "../src/brain/search.ts";
import { inferColumns, termFqn } from "../src/om/catalog.ts";
import { CONCEPTS, RELATION_TYPES, STATEMENTS } from "../src/om/ontology.ts";
import { ERA_OBJECTS } from "../src/om/schemas.ts";

describe("splitText", () => {
  it("keeps short text whole", () => {
    expect(splitText("hello world")).toEqual(["hello world"]);
  });
  it("splits long text under the limit with overlap", () => {
    const para = "Sentence about settlement timeouts. ".repeat(40);
    const chunks = splitText(`${para}\n\n${para}\n\n${para}`, 500, 80);
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(500);
  });
  it("drops empty input", () => {
    expect(splitText("  \n\n ")).toEqual([]);
  });
});

describe("entities", () => {
  it("normalizes company names across systems", () => {
    expect(slug("Acacia Partners, Inc.")).toBe("acacia-partners");
    expect(accountId("Acacia Partners LLC")).toBe(accountId("acacia partners"));
    expect(personId("Jane.Doe@Wisteria.com")).toBe("person:jane.doe@wisteria.com");
  });
  it("finds account mentions in free text, longest match first", () => {
    const m = new AccountMatcher([
      { _id: "account:acacia", name: "Acacia" },
      { _id: "account:acacia-partners", name: "Acacia Partners" },
      { _id: "account:absolis", name: "Absolis" },
    ]);
    expect(m.match("QBR prep for Acacia Partners and absolis next week").sort()).toEqual(["account:absolis", "account:acacia-partners"]);
  });
  it("merges fragments from different sources", () => {
    const [e] = mergeEntities([
      { _id: "account:x", type: "account", name: "X", aliases: [], attrs: { industry: "Banking" }, links: [{ to: "person:a", rel: "contact_of", source: "salesforce" }], sources: ["salesforce"] },
      { _id: "account:x", type: "account", name: "X Corp", aliases: [], attrs: { slackChannels: ["x"] }, links: [{ to: "person:a", rel: "contact_of", source: "salesforce" }], sources: ["slack"] },
    ]);
    expect(e.sources.sort()).toEqual(["salesforce", "slack"]);
    expect(e.links).toHaveLength(1);
    expect(e.aliases).toContain("X Corp");
    expect(e.attrs).toMatchObject({ industry: "Banking", slackChannels: ["x"] });
  });
});

describe("rrf", () => {
  it("rewards items ranked well in both lists", () => {
    const fused = rrf([[{ _id: "a" }, { _id: "b" }, { _id: "c" }], [{ _id: "b" }, { _id: "d" }]]);
    expect(fused[0]._id).toBe("b");
    expect(fused.map((f) => f._id).sort()).toEqual(["a", "b", "c", "d"]);
  });
});

describe("inferColumns", () => {
  const spec = ERA_OBJECTS.find((o) => o.object === "Opportunity")!.columns;
  it("maps sample types and adds concepts, descriptions and PII from the spec", () => {
    const cols = inferColumns([{ Amount: 1200.5, StageName: "Closed Won", Email: "a@b.com", CloseDate: "2026-12-01T00:00:00Z", Tags: ["x"] }], spec);
    const by = Object.fromEntries(cols.map((c) => [c.name, c]));
    expect(by.Amount.dataType).toBe("DOUBLE");
    expect(by.CloseDate.dataType).toBe("TIMESTAMP");
    expect(by.Tags).toMatchObject({ dataType: "ARRAY", arrayDataType: "STRING" });
    expect(by.Email.tags.map((t: any) => t.tagFQN)).toContain("PII.Sensitive");
    expect(by.Amount.tags.map((t: any) => t.tagFQN)).toContain("WisteriaGlossary.Pipeline");
    expect(by.StageName.tags.map((t: any) => t.tagFQN)).toContain("WisteriaGlossary.Pipeline");
    expect(by.Amount.description).toBe("Deal value (USD)");
  });
  it("falls back to the vendor spec when there are no records yet", () => {
    const cols = inferColumns([], spec);
    expect(cols.map((c) => c.name)).toContain("AccountId");
    expect(cols.find((c) => c.name === "Type")!.tags.map((t: any) => t.tagFQN)).toContain("WisteriaGlossary.Opportunity.Renewal");
  });
});

describe("ontology", () => {
  it("builds hierarchical term FQNs", () => {
    expect(termFqn("Customer")).toBe("WisteriaGlossary.Organization.Customer");
    expect(termFqn("AccountOwner")).toBe("WisteriaGlossary.Person.Employee.AccountOwner");
    expect(termFqn("QBR")).toBe("WisteriaGlossary.Interaction.CustomerCall.QBR");
  });
  it("only states relations between known concepts with known relation types", () => {
    const names = new Set(CONCEPTS.map((c) => c.name));
    const builtIn = ["relatedTo", "synonym", "antonym", "broader", "narrower", "partOf", "hasPart", "calculatedFrom", "usedToCalculate", "seeAlso"];
    const rels = new Set([...builtIn, ...RELATION_TYPES.flatMap((r) => [r.name, r.inverse])]);
    for (const [s, r, o] of STATEMENTS) {
      expect(names.has(s), s).toBe(true);
      expect(names.has(o), o).toBe(true);
      expect(rels.has(r), r).toBe(true);
    }
  });
  it("every Era object maps to a concept and its foreign keys point at known objects", () => {
    for (const o of ERA_OBJECTS) {
      expect(() => termFqn(o.concept)).not.toThrow();
      for (const [col, refObj] of o.fks ?? []) {
        expect(o.columns.some((c) => c.name === col), `${o.object}.${col}`).toBe(true);
        expect(ERA_OBJECTS.some((x) => x.source === o.source && x.object === refObj), `${o.object} → ${refObj}`).toBe(true);
      }
    }
  });
});
