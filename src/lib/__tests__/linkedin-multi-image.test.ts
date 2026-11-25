import { afterEach, describe, expect, it, vi } from "vitest";

import { LinkedInProvider } from "../providers/linkedin";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch() {
  const calls: { url: string; method: string; body: unknown }[] = [];
  let n = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      let body: unknown = init?.body;
      if (typeof body === "string") {
        try {
          body = JSON.parse(body);
        } catch {
          /* keep raw */
        }
      }
      calls.push({ url, method, body });
      if (url.includes("action=initializeUpload")) {
        n += 1;
        return json({ value: { uploadUrl: `https://upload.example/${n}`, image: `urn:li:image:${n}` } });
      }
      if (url.startsWith("https://cdn.example/")) {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      }
      if (url.startsWith("https://upload.example/")) {
        return new Response(null, { status: 201 });
      }
      if (url.endsWith("/rest/posts")) {
        return new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:99" } });
      }
      return json({});
    })
  );
  return calls;
}

function json(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("LinkedIn multi-image publishing", () => {
  it("uploads every slide and creates one multiImage post", async () => {
    const calls = stubFetch();
    const provider = new LinkedInProvider({ clientId: "id", clientSecret: "secret" });

    const result = await provider.publishPost("token", {
      text: "Caption",
      mediaUrls: ["https://cdn.example/1.jpg", "https://cdn.example/2.jpg", "https://cdn.example/3.jpg"],
      postType: "carousel",
      extra: { author: "urn:li:organization:1" },
    });

    expect(calls.filter((c) => c.url.includes("action=initializeUpload"))).toHaveLength(3);
    const post = calls.find((c) => c.url.endsWith("/rest/posts"));
    expect(post?.body).toMatchObject({
      author: "urn:li:organization:1",
      content: {
        multiImage: {
          images: [{ id: "urn:li:image:1" }, { id: "urn:li:image:2" }, { id: "urn:li:image:3" }],
        },
      },
    });
    expect(result.platformPostId).toBe("urn:li:share:99");
  });

  it("keeps single-image posts on content.media", async () => {
    const calls = stubFetch();
    const provider = new LinkedInProvider({ clientId: "id", clientSecret: "secret" });

    await provider.publishPost("token", {
      text: "Caption",
      mediaUrls: ["https://cdn.example/1.jpg"],
      postType: "image",
      extra: { author: "urn:li:organization:1" },
    });

    const post = calls.find((c) => c.url.endsWith("/rest/posts"));
    expect(post?.body).toMatchObject({ content: { media: { id: "urn:li:image:1" } } });
  });
});
