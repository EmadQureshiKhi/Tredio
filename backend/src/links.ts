import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { type Fetch, fetchJson } from "./sources/http";

/**
 * Resolves a pasted link to what it is about: a title, author and text the trend radar can
 * assess. Social platforms answer through their public oEmbed endpoints; any other page is read
 * for its title and description, but only from public HTTPS hosts: every hop is resolved and
 * refused if it points at a private, loopback, link-local or otherwise internal address, so a
 * link can never reach services inside the backend's network.
 */

export interface LinkInfo {
  url: string;
  platform: string;
  title: string;
  author: string | null;
  text: string | null;
}

export class LinkError extends Error {}

const MAX_BYTES = 512 * 1024;
const MAX_REDIRECTS = 3;

interface OEmbedProvider {
  platform: string;
  hosts: RegExp;
  endpoint: (url: string) => string;
}

const OEMBED: OEmbedProvider[] = [
  { platform: "x", hosts: /^(www\.|mobile\.)?(x|twitter)\.com$/, endpoint: (u) => `https://publish.twitter.com/oembed?omit_script=true&url=${encodeURIComponent(u)}` },
  { platform: "youtube", hosts: /^(www\.|m\.)?(youtube\.com|youtu\.be)$/, endpoint: (u) => `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(u)}` },
  { platform: "tiktok", hosts: /^(www\.|m\.)?tiktok\.com$/, endpoint: (u) => `https://www.tiktok.com/oembed?url=${encodeURIComponent(u)}` },
  { platform: "reddit", hosts: /^(www\.|old\.)?reddit\.com$/, endpoint: (u) => `https://www.reddit.com/oembed?url=${encodeURIComponent(u)}` },
];

/** True for addresses outside the public internet. */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a = 0, b = 0] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x === "::" || x === "::1") return true;
    const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return /^(fc|fd|fe8|fe9|fea|feb|ff|64:ff9b|100::|2001:db8|2001:0?:)/.test(x);
  }
  return true;
}

/** Parses and checks a pasted URL: https, default port, a DNS name, no credentials. */
export function parseLink(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new LinkError("not a valid URL");
  }
  if (url.protocol !== "https:") throw new LinkError("only https links are accepted");
  if (url.username || url.password) throw new LinkError("links with credentials are not accepted");
  if (url.port && url.port !== "443") throw new LinkError("links must use the default port");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) || !host.includes(".") || /\.(local|internal|localhost|lan|home|corp)$/i.test(host)) {
    throw new LinkError("links must point at a public website");
  }
  url.hash = "";
  return url;
}

async function assertPublicHost(host: string): Promise<void> {
  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new LinkError("the link's host does not resolve");
  }
  if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new LinkError("links must point at a public website");
  }
}

/** Fetches a public page, checking every redirect hop, and returns at most MAX_BYTES of it. */
async function fetchPublic(fetchImpl: Fetch, start: URL, resolveHost: (host: string) => Promise<void>): Promise<{ url: URL; html: string }> {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await resolveHost(url.hostname);
    const res = await fetchImpl(url.toString(), {
      redirect: "manual",
      signal: AbortSignal.timeout(8_000),
      headers: { accept: "text/html,application/xhtml+xml", "user-agent": "Mozilla/5.0 (compatible; TredioLinkPreview/1.0)" },
    });
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get("location");
      if (!next) throw new LinkError("the link redirects nowhere");
      url = parseLink(new URL(next, url).toString());
      continue;
    }
    if (!res.ok) throw new LinkError(`the page answered HTTP ${res.status}`);
    const type = res.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xhtml/i.test(type)) throw new LinkError("the link is not a web page");
    const reader = res.body?.getReader();
    if (!reader) throw new LinkError("the page is empty");
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (size < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
    await reader.cancel().catch(() => {});
    return { url, html: new TextDecoder().decode(Buffer.concat(chunks).subarray(0, MAX_BYTES)) };
  }
  throw new LinkError("the link redirects too many times");
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " };

export function decodeEntities(s: string): string {
  return s
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, e: string) => ENTITIES[e] ?? "")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(Number.parseInt(n, 16)));
}

const clean = (s: string | null | undefined, max: number) => (s ? decodeEntities(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim().slice(0, max) : "") || null;

function meta(html: string, name: string): string | null {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*>`, "i");
  const tag = html.match(re)?.[0];
  return tag?.match(/content=["']([^"']*)["']/i)?.[1] ?? null;
}

/** Title, site and description of an HTML page. */
export function readPage(html: string): { title: string | null; site: string | null; text: string | null } {
  return {
    title: clean(meta(html, "og:title") ?? html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1], 200),
    site: clean(meta(html, "og:site_name"), 80),
    text: clean(meta(html, "og:description") ?? meta(html, "description"), 500),
  };
}

export async function resolveLink(raw: string, fetchImpl: Fetch = fetch, resolveHost: (host: string) => Promise<void> = assertPublicHost): Promise<LinkInfo> {
  const url = parseLink(raw);
  const host = url.hostname.toLowerCase();

  const provider = OEMBED.find((p) => p.hosts.test(host));
  if (provider) {
    const json = await fetchJson<{ title?: string; author_name?: string; html?: string }>(fetchImpl, provider.platform, provider.endpoint(url.toString()), {
      headers: { accept: "application/json" },
    }).catch(() => {
      throw new LinkError(`${provider.platform} could not read that link`);
    });
    // X returns the post as HTML; its text is the first paragraph.
    const text = clean(json.html?.match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1], 500);
    const title = clean(json.title, 200) ?? text;
    if (!title) throw new LinkError(`${provider.platform} returned nothing to assess`);
    return { url: url.toString(), platform: provider.platform, title, author: clean(json.author_name, 80), text: text === title ? null : text };
  }

  if (/(^|\.)wikipedia\.org$/.test(host)) {
    const title = decodeURIComponent(url.pathname.replace(/^\/wiki\//, ""));
    if (!title || title.includes("/")) throw new LinkError("not a Wikipedia article link");
    const lang = host.split(".")[0] ?? "en";
    const json = await fetchJson<{ title?: string; extract?: string }>(
      fetchImpl,
      "wikipedia",
      `https://${lang === "www" ? "en" : lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}?redirect=true`,
      { headers: { accept: "application/json" } },
    ).catch(() => {
      throw new LinkError("Wikipedia has no such article");
    });
    return { url: url.toString(), platform: "wikipedia", title: json.title ?? title.replace(/_/g, " "), author: null, text: clean(json.extract, 500) };
  }

  const page = await fetchPublic(fetchImpl, url, resolveHost);
  const info = readPage(page.html);
  if (!info.title) throw new LinkError("the page has no title to assess");
  return { url: page.url.toString(), platform: info.site ?? host.replace(/^www\./, ""), title: info.title, author: null, text: info.text };
}
