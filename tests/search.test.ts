import { describe, expect, it } from "vitest";
import { InternalSearchAdapter, InternetSearchAdapter, parseOpenRouterSearchMessage } from "../src/magi/search";

describe("InternalSearchAdapter", () => {
  it("returns transparent read-only search results with request metadata", async () => {
    const adapter = new InternalSearchAdapter();
    const results = await adapter.search("consensus", "melchior", 2);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toMatchObject({
      query: "consensus",
      requestedBy: "melchior",
      round: 2
    });
  });
});

describe("InternetSearchAdapter", () => {
  it("parses OpenRouter web citations into transparent search results", () => {
    const results = parseOpenRouterSearchMessage(
      {
        content: "A concise search answer.",
        annotations: [
          {
            type: "url_citation",
            url_citation: {
              title: "Example Result",
              url: "https://example.com/article?x=1",
              content: "A useful web result snippet."
            }
          }
        ]
      },
      "example query",
      "system",
      0
    );

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      query: "example query",
      title: "Example Result",
      snippet: "A useful web result snippet.",
      source: "https://example.com/article?x=1",
      requestedBy: "system",
      round: 0
    });
  });

  it("returns empty results instead of dummy local results when OpenRouter search fails", async () => {
    const failingFetch = async () => {
      throw new Error("network down");
    };
    const adapter = new InternetSearchAdapter({ fetchImpl: failingFetch as typeof fetch, apiKey: "test-key" });

    const results = await adapter.search("consensus", "casper", 3);

    expect(results).toEqual([]);
  });

  it("calls OpenRouter chat completions with the web plugin", async () => {
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: "perplexity/sonar-pro-search",
        plugins: [{ id: "web", max_results: 5 }]
      });
      return {
        ok: true,
        json: async () => ({
          model: "perplexity/sonar-pro-search",
          choices: [
            {
              message: {
                content: "Answer",
                annotations: [
                  {
                    type: "url_citation",
                    url_citation: {
                      title: "Source",
                      url: "https://example.com",
                      content: "Snippet"
                    }
                  }
                ]
              }
            }
          ]
        })
      } as Response;
    };
    const adapter = new InternetSearchAdapter({ fetchImpl: fetchImpl as typeof fetch, apiKey: "test-key" });

    const results = await adapter.search("consensus", "casper", 0);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ requestedBy: "casper", round: 0, source: "https://example.com" });
  });
});
