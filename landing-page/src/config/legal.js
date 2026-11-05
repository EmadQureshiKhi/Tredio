import { CONTACT_EMAIL as EMAIL } from "./links";

// Date shown on every legal page and in the sitemap. Change it whenever a policy changes.
export const LAST_UPDATED = "5 November 2026";
export const LAST_UPDATED_ISO = "2026-11-05";

// Who operates Tredio, where, and how to reach them; used across the legal pages.
export const COMPANY = "Emad Qureshi, trading as Tredio";
export const JURISDICTION = "Karachi, Pakistan";
export const GOVERNING_LAW = "Pakistan";
export const CONTACT_EMAIL = EMAIL;

// Page metadata for a legal page. A page that sets openGraph or twitter replaces the root one, file
// based images (src/app/opengraph-image.jpg, twitter-image.jpg) included, so the shared fields are
// repeated here and the images point at the routes Next serves those files from.
export function legalMetadata({ path, title, description }) {
  const fullTitle = `${title} | Tredio`;
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: {
      type: "website",
      siteName: "Tredio",
      locale: "en_US",
      url: path,
      title: fullTitle,
      description,
      images: [{ url: "/opengraph-image.jpg", width: 1200, height: 630, type: "image/jpeg" }],
    },
    twitter: {
      card: "summary_large_image",
      title: fullTitle,
      description,
      images: [{ url: "/twitter-image.jpg", width: 1200, height: 630, type: "image/jpeg" }],
    },
  };
}
