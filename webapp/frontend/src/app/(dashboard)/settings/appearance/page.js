"use client";

import { Sun, Moon, Check } from "lucide-react";
import { useTheme } from "@/components/providers/ThemeProvider";
import { cn } from "@/lib/utils";
import { LOCALES, useLocale, useT } from "@/lib/i18n";

// Language names are shown in their own language so the switch is findable
// whatever the current UI language is.
const LANGUAGE_NAMES = { en: "English", de: "Deutsch" };

const OPTIONS = [
  { value: "light", labelKey: "settings.appearance.light", icon: Sun },
  { value: "dark", labelKey: "settings.appearance.dark", icon: Moon },
];

export default function AppearancePage() {
  const { theme, setTheme } = useTheme();
  const { locale, setLocale } = useLocale();
  const t = useT();

  return (
    <div>
      <h1 className="text-2xl font-bold">{t("settings.appearance.title")}</h1>
      <p className="mt-2 text-muted-foreground">
        {t("settings.appearance.subtitle")}
      </p>

      <div className="mt-6 max-w-lg space-y-6">
        <div className="rounded-xl border border-border/60 bg-card shadow-card p-6">
          <h2 className="text-lg font-semibold mb-1">{t("settings.appearance.heading")}</h2>
          <p className="text-sm text-muted-foreground mb-4">
            {t("settings.appearance.description")}
          </p>
          <div className="grid grid-cols-2 gap-3">
            {OPTIONS.map((opt) => {
              const Icon = opt.icon;
              const isActive = theme === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setTheme(opt.value)}
                  className={cn(
                    "flex items-center gap-3 rounded-lg border p-4 text-left transition-colors",
                    isActive
                      ? "border-primary bg-primary/5"
                      : "border-border/60 hover:bg-foreground/5"
                  )}
                >
                  <Icon className="size-5 text-muted-foreground" strokeWidth={1.75} />
                  <span className="flex-1 text-sm font-medium">{t(opt.labelKey)}</span>
                  {isActive && (
                    <Check className="size-4 text-primary" strokeWidth={2} />
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div className="rounded-xl border border-border/60 bg-card shadow-card p-6">
          <label htmlFor="ui-language" className="text-lg font-semibold mb-1 block">
            Language · Sprache
          </label>
          <p className="text-sm text-muted-foreground mb-4">
            {t("settings.appearance.languageDescription")}
          </p>
          <select
            id="ui-language"
            value={locale}
            onChange={(event) => setLocale(event.target.value)}
            className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
          >
            {LOCALES.map((value) => (
              <option key={value} value={value}>{LANGUAGE_NAMES[value]}</option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}
