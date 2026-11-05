import { describe, expect, test } from "bun:test";
import { isPrivateAddress, LinkError, parseLink, readPage, resolveLink } from "../src/links";
import { fakeFetch, json } from "./helpers";

const publicHost = async () => {};
const html = (body: string, status = 200, headers: Record<string, string> = {}) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", ...headers } });

describe("parseLink", () => {
  test("accepts public https links and strips the fragment", () => {
    expect(parseLink(" https://example.com/a?b=1#c ").toString()).toBe("https://example.com/a?b=1");
  });
  test.each([
    ["http://example.com", "only https"],
    ["https://user:pw@example.com", "credentials"],
    ["https://example.com:8443/", "default port"],
    ["https://127.0.0.1/", "public website"],
    ["https://[::1]/", "public website"],
    ["https://localhost/", "public website"],
    ["https://api.svc.internal/", "public website"],
    ["https://printer.local/", "public website"],
    ["javascript:alert(1)", "only https"],
    ["not a url", "valid URL"],
  ])("refuses %s", (url, reason) => {
    expect(() => parseLink(url)).toThrow(reason);
  });
});

describe("isPrivateAddress", () => {
  test.each(["10.0.0.1", "127.0.0.1", "169.254.169.254", "172.16.5.4", "192.168.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fd12::1", "fe80::1", "::ffff:10.0.0.1", "2001:db8::1"])(
    "%s is private",
    (ip) => expect(isPrivateAddress(ip)).toBe(true),
  );
  test.each(["8.8.8.8", "104.16.0.1", "2606:4700::1111", "::ffff:8.8.8.8"])("%s is public", (ip) => expect(isPrivateAddress(ip)).toBe(false));
});

describe("resolveLink", () => {
  test("reads an X post through oEmbed", async () => {
    const f = fakeFetch([
      [/publish\.twitter\.com\/oembed/, () => json({ author_name: "Example", html: '<blockquote><p lang="en">Mainnet &amp; more <a href="#">link</a></p></blockquote>' })],
    ]);
    const info = await resolveLink("https://x.com/example/status/1", f.impl, publicHost);
    expect(info).toEqual({ url: "https://x.com/example/status/1", platform: "x", title: "Mainnet & more link", author: "Example", text: null });
  });

  test("reads a Wikipedia article through its summary", async () => {
    const f = fakeFetch([[/en\.wikipedia\.org\/api\/rest_v1\/page\/summary\/Starlink/, () => json({ title: "Starlink", extract: "Satellite internet." })]]);
    expect(await resolveLink("https://en.wikipedia.org/wiki/Starlink", f.impl, publicHost)).toMatchObject({ platform: "wikipedia", title: "Starlink", text: "Satellite internet." });
  });

  test("reads a news page's title and description", async () => {
    const page = '<html><head><meta property="og:site_name" content="Example News"><meta property="og:title" content="Big &quot;story&quot;"><meta name="description" content="What happened."><title>ignored</title></head></html>';
    const f = fakeFetch([[/news\.example\.com/, () => html(page)]]);
    expect(await resolveLink("https://news.example.com/a", f.impl, publicHost)).toEqual({
      url: "https://news.example.com/a",
      platform: "Example News",
      title: 'Big "story"',
      author: null,
      text: "What happened.",
    });
  });

  test("checks every redirect hop and refuses one into a private network", async () => {
    const checked: string[] = [];
    const resolver = async (host: string) => {
      checked.push(host);
      if (host === "internal.example.com") throw new LinkError("links must point at a public website");
    };
    const f = fakeFetch([[/short\.example\.com/, () => new Response(null, { status: 302, headers: { location: "https://internal.example.com/admin" } })]]);
    await expect(resolveLink("https://short.example.com/x", f.impl, resolver)).rejects.toThrow("public website");
    expect(checked).toEqual(["short.example.com", "internal.example.com"]);
    expect(f.calls).toHaveLength(1);
  });

  test("refuses redirects to plain http and non-pages", async () => {
    const f = fakeFetch([
      [/a\.example\.com/, () => new Response(null, { status: 301, headers: { location: "http://b.example.com/" } })],
      [/c\.example\.com/, () => new Response("{}", { headers: { "content-type": "application/json" } })],
    ]);
    await expect(resolveLink("https://a.example.com/", f.impl, publicHost)).rejects.toThrow("only https");
    await expect(resolveLink("https://c.example.com/", f.impl, publicHost)).rejects.toThrow("not a web page");
  });

  test("resolves real hosts before fetching", async () => {
    const f = fakeFetch([]);
    await expect(resolveLink("https://does-not-exist.invalid/", f.impl)).rejects.toThrow("does not resolve");
    expect(f.calls).toHaveLength(0);
  });
});

describe("readPage", () => {
  test("falls back to <title> and decodes entities", () => {
    expect(readPage("<title>A &amp; B &#8211; C</title>")).toEqual({ title: "A & B – C", site: null, text: null });
  });
});
