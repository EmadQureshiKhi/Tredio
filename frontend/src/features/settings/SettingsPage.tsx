"use client";
import { Segmented } from "@/components/ui";
import { type ThemeChoice, useTheme } from "@/lib/theme";
import { PageHeader } from "@/features/autopilot/shared/kit";
import { AccountSection } from "./AccountSection";
import { AlertsSection } from "./AlertsSection";
import { IdentitySection } from "./IdentitySection";
import { NotesSection } from "./NotesSection";
import { NotificationsSection } from "./NotificationsSection";
import { Section } from "./Section";

const NAV = [
  { id: "account", label: "Account" },
  { id: "identity", label: "Caller identity" },
  { id: "notes", label: "Private notes" },
  { id: "notifications", label: "Notifications" },
  { id: "alerts", label: "Attention alerts" },
  { id: "appearance", label: "Appearance" },
] as const;

/** /settings: the account, caller identity, private notes, notifications, attention alerts and theme. */
export default function SettingsPage() {
  return (
    <div className="flex flex-col gap-6 [font-feature-settings:'calt'_0]">
      <PageHeader title="Settings" description="Your NEAR account and its sessions, the identity you post calls with, notes only you can read, and how Tredio reaches you." />
      <div className="grid items-start gap-6 lg:grid-cols-[200px_minmax(0,1fr)]">
        <nav aria-label="Settings sections" className="no-scrollbar -mx-4 flex gap-1.5 overflow-x-auto px-4 sm:mx-0 sm:px-0 lg:sticky lg:top-24 lg:flex-col lg:gap-0.5">
          {NAV.map((n) => (
            <a key={n.id} href={`#${n.id}`} className="h-8 shrink-0 rounded-full border border-line bg-surface px-3.5 font-strong text-[13px] leading-[30px] text-text-2 transition-colors hover:text-text lg:h-9 lg:rounded-xl lg:border-0 lg:bg-transparent lg:px-3 lg:leading-9 lg:hover:bg-surface">
              {n.label}
            </a>
          ))}
        </nav>
        <div className="flex min-w-0 flex-col gap-5">
          <AccountSection />
          <IdentitySection />
          <NotesSection />
          <NotificationsSection />
          <AlertsSection />
          <AppearanceSection />
        </div>
      </div>
    </div>
  );
}

const THEMES: Array<{ value: ThemeChoice; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

function AppearanceSection() {
  const { choice, setChoice } = useTheme();
  return (
    <Section id="appearance" title="Appearance" description="System follows your device's light or dark setting.">
      <Segmented label="Theme" value={choice} onChange={setChoice} options={THEMES} className="max-w-sm" />
    </Section>
  );
}
