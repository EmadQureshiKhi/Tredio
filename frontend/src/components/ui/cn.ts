/** Joins class names, skipping falsy ones. */
export const cn = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");
