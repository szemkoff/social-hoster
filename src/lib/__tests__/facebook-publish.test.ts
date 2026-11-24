import { afterEach, describe, expect, it, vi } from "vitest";

import { FacebookProvider } from "../providers/facebook";

function stubFetch() {
  const calls: { url: string; body: unknown }[] = [];
  let n = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const raw = init?.body;
    let body: unknown = raw;
    if (typeof raw === "string") {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    calls.push({ url, body });
    n += 1;
    const payload = url.includes("/photos") ? { id: `photo-${n}` } : { id: "page_post-1" };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

describe("Facebook multi-image publishing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("publishes a carousel as one multi-photo feed post", async () => {
    const calls = stubFetch();
    const provider = new FacebookProvider({ clientId: "id", clientSecret: "secret" });

    const result = await provider.publishPost("token", {
      text: "Caption",
      mediaUrls: ["https://cdn.example/1.jpg", "https://cdn.example/2.jpg"],
      postType: "carousel",
      extra: { page_id: "123" },
    });

    const photoCalls = calls.filter((c) => c.url.includes("/123/photos"));
    const feedCalls = calls.filter((c) => c.url.includes("/123/feed"));
    expect(photoCalls).toHaveLength(2);
    expect(feedCalls).toHaveLength(1);
    expect(JSON.stringify(feedCalls[0].body)).toContain("media_fbid");
    expect(result.platformPostId).toBe("page_post-1");
  });

  it("posts the first comment as the Page after publishing", async () => {
    const calls = stubFetch();
    const provider = new FacebookProvider({ clientId: "id", clientSecret: "secret" });

    const result = await provider.publishPost("token", {
      text: "Caption",
      mediaUrls: [],
      postType: "text",
      firstComment: "Details: https://azureyachtgroup.com",
      extra: { page_id: "123" },
    });

    const commentCall = calls.find((c) => c.url.includes("/page_post-1/comments"));
    expect(commentCall).toBeDefined();
    expect(JSON.stringify(commentCall?.body)).toContain("azureyachtgroup.com");
    expect(result.platformPostId).toBe("page_post-1");
  });

  it("keeps the post when the first comment fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/comments")) {
          return new Response(JSON.stringify({ error: { message: "no permission" } }), {
            status: 403,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ id: "page_post-9" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      })
    );
    const provider = new FacebookProvider({ clientId: "id", clientSecret: "secret" });

    const result = await provider.publishPost("token", {
      text: "Caption",
      mediaUrls: [],
      postType: "text",
      firstComment: "Hello",
      extra: { page_id: "123" },
    });

    expect(result.platformPostId).toBe("page_post-9");
    expect(result.extra?.firstCommentError).toBeTruthy();
  });
});
