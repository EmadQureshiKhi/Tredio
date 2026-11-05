import Contact from "@/components/contact/Contact";
import { legalMetadata } from "@/config/legal";

export const metadata = legalMetadata({
  path: "/contact",
  title: "Contact",
  description: "Write to Tredio at contact@tredio.bid: help with the app, partners and press, security reports and data requests.",
});

export default function ContactPage() {
  return <Contact />;
}
