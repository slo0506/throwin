import { describe, expect, it } from "vitest";
import { findProductImage, isPublicHttps, metaImage } from "../src/product-image.js";

describe("isPublicHttps", () => {
  it("allows public https hosts only", () => {
    expect(isPublicHttps("https://www.ebay.com/itm/123")).toBe(true);
    for (const bad of [
      "http://www.ebay.com/itm/123",
      "https://127.0.0.1/x",
      "https://[::1]/x",
      "https://localhost/x",
      "https://matcher.railway.internal/v1",
      "https://router.local/admin",
      "https://intranet/x",
      "https://user:pass@shop.example.com/x",
      "not a url",
    ]) {
      expect(isPublicHttps(bad), bad).toBe(false);
    }
  });
});

describe("metaImage", () => {
  it("reads og:image or twitter:image in either attribute order, resolving relative URLs", () => {
    expect(
      metaImage(
        '<meta property="og:image" content="https://cdn.shop.com/a.jpg?w=1&amp;h=1">',
        "https://shop.com/p",
      ),
    ).toBe("https://cdn.shop.com/a.jpg?w=1&h=1");
    expect(
      metaImage("<meta content='/img/b.png' name='twitter:image'>", "https://shop.com/p/1"),
    ).toBe("https://shop.com/img/b.png");
    expect(metaImage('<meta property="og:title" content="Nope">', "https://shop.com")).toBeNull();
  });
});

function fakeWeb(pages: Record<string, { type: string; body?: string; status?: number }>) {
  const fetched: string[] = [];
  const fetchImpl = (async (input: string | URL) => {
    const url = String(input);
    fetched.push(url);
    const page = pages[url];
    if (!page) return new Response("missing", { status: 404 });
    return new Response(page.body ?? "", {
      status: page.status ?? 200,
      headers: { "content-type": page.type },
    });
  }) as typeof fetch;
  return { fetchImpl, fetched };
}

describe("findProductImage", () => {
  it("returns the first page's verified og:image, skipping unsafe and broken pages", async () => {
    const web = fakeWeb({
      "https://blocked.example.com/p": { type: "text/html", status: 403 },
      "https://cards.example.com/luka": {
        type: "text/html; charset=utf-8",
        body: '<html><head><meta property="og:image" content="https://img.example.com/luka.jpg"></head>',
      },
      "https://img.example.com/luka.jpg": { type: "image/jpeg" },
    });
    const image = await findProductImage(
      [
        "http://insecure.example.com/p",
        "https://10.0.0.5/p",
        "https://blocked.example.com/p",
        "https://cards.example.com/luka",
        "https://cards.example.com/luka",
      ],
      web.fetchImpl,
    );
    expect(image).toBe("https://img.example.com/luka.jpg");
    // Unsafe URLs are never fetched; the duplicate isn't fetched twice.
    expect(web.fetched).toEqual([
      "https://blocked.example.com/p",
      "https://cards.example.com/luka",
      "https://img.example.com/luka.jpg",
    ]);
  });

  it("rejects an og:image that isn't really an image, and never throws", async () => {
    const web = fakeWeb({
      "https://shop.example.com/p": {
        type: "text/html",
        body: '<meta property="og:image" content="https://shop.example.com/not-an-image">',
      },
      "https://shop.example.com/not-an-image": { type: "text/html" },
    });
    expect(await findProductImage(["https://shop.example.com/p"], web.fetchImpl)).toBeNull();
    const failing = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await findProductImage(["https://shop.example.com/p"], failing)).toBeNull();
  });
});
