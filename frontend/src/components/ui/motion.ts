import type { HTMLMotionProps } from "framer-motion";

/**
 * Motion presets. A list item settles in from just below, leaves by fading, and the rest of its
 * list glides into the gap (inside <AnimatePresence initial={false} mode="popLayout">). Under
 * ~250ms, ease-out, never from zero scale; reduced motion keeps only the fades.
 */
const EASE_OUT = [0.25, 1, 0.5, 1] as const;

export const listItem = {
  layout: "position",
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.22, ease: EASE_OUT } },
  exit: { opacity: 0, transition: { duration: 0.14, ease: "easeIn" } },
  transition: { layout: { duration: 0.26, ease: EASE_OUT } },
} satisfies HTMLMotionProps<"li">;
