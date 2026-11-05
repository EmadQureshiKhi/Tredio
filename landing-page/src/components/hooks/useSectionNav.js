"use client";
import { useRouter } from "next/navigation";
import { useLenis } from "lenis/react";

// Scrolls to a home page section with Lenis, or opens the home page at that section when the
// current page does not have it (legal pages, 404).
export default function useSectionNav() {
  const lenis = useLenis();
  const router = useRouter();
  return (selector, options = {}) => {
    if (document.querySelector(selector)) {
      lenis?.scrollTo(selector, { duration: 1.2, ...options });
    } else {
      router.push(`/${selector}`);
    }
  };
}
