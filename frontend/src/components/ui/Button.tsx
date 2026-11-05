"use client";
import { Loader2 } from "lucide-react";
import Link from "next/link";
import type { ButtonHTMLAttributes, ComponentProps, ReactNode } from "react";
import { cn } from "./cn";

export type ButtonTone = "primary" | "secondary" | "ghost" | "up" | "down" | "danger" | "accent";
export type ButtonSize = "sm" | "md" | "lg";

const tones: Record<ButtonTone, string> = {
  primary: "bg-primary text-on-primary hover:bg-primary-strong",
  accent: "bg-accent text-on-accent hover:brightness-95",
  secondary: "bg-surface-2 text-text border border-line hover:border-line-strong hover:bg-surface-3",
  ghost: "text-text-2 hover:text-text hover:bg-surface-2",
  up: "bg-up text-[#04140d] hover:brightness-105",
  down: "bg-down text-[#1b0606] hover:brightness-105",
  danger: "bg-down-soft text-down border border-[color:var(--down-soft)] hover:bg-down hover:text-[#1b0606]",
};
const sizes: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-[13px] gap-1.5 rounded-[10px]",
  md: "h-10 px-4 text-sm gap-2 rounded-xl",
  lg: "h-12 px-5 text-[15px] gap-2 rounded-2xl",
};

export const buttonClass = (tone: ButtonTone = "primary", size: ButtonSize = "md", block = false) =>
  cn(
    "inline-flex select-none items-center justify-center whitespace-nowrap font-strong transition-[background-color,border-color,color,filter,transform] duration-150 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-45",
    tones[tone],
    sizes[size],
    block && "w-full",
  );

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: ButtonTone;
  size?: ButtonSize;
  block?: boolean;
  loading?: boolean;
  icon?: ReactNode;
}

export function Button({ tone = "primary", size = "md", block, loading, icon, className, children, disabled, type = "button", ...rest }: Props) {
  return (
    <button type={type} className={cn(buttonClass(tone, size, block), className)} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
}

export function ButtonLink({ tone = "primary", size = "md", block, className, ...rest }: ComponentProps<typeof Link> & { tone?: ButtonTone; size?: ButtonSize; block?: boolean }) {
  return <Link className={cn(buttonClass(tone, size, block), className)} {...rest} />;
}
