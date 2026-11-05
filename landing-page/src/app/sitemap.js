import { SITE_URL } from "@/config/links";
import { LAST_UPDATED_ISO } from "@/config/legal";

export default function sitemap() {
  return [
    { url: `${SITE_URL}/`, changeFrequency: "weekly", priority: 1 },
    { url: `${SITE_URL}/terms`, lastModified: LAST_UPDATED_ISO, changeFrequency: "yearly", priority: 0.3 },
    { url: `${SITE_URL}/privacy`, lastModified: LAST_UPDATED_ISO, changeFrequency: "yearly", priority: 0.3 },
    { url: `${SITE_URL}/cookies`, lastModified: LAST_UPDATED_ISO, changeFrequency: "yearly", priority: 0.3 },
  ];
}
