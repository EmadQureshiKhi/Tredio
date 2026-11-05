"use client";
import { LazyMotion, MotionConfig } from "framer-motion";
import type { ReactNode } from "react";

/**
 * Motion for the whole app: `m.*` components only (strict), with the animation and layout
 * features fetched after the first paint, and every transform and layout animation dropped for
 * people who ask the system for reduced motion.
 */
const features = () => import("./features").then((mod) => mod.default);

export function MotionProvider({ children }: { children: ReactNode }) {
  return (
    <LazyMotion features={features} strict>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </LazyMotion>
  );
}
