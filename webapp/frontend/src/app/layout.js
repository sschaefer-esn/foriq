import fs from "node:fs";
import path from "node:path";
import localFont from "next/font/local";
import { preload } from "react-dom";
import AuthProvider from "@/components/providers/AuthProvider";
import { ThemeProvider } from "@/components/providers/ThemeProvider";
import { LocaleProvider } from "@/lib/i18n";
import "./globals.css";

// Inter (SIL OFL 1.1, see public/fonts/Inter-OFL.txt), variable wght 100–900 + opsz.
const inter = localFont({
  src: "../../public/fonts/Inter-Variable.ttf",
  variable: "--font-inter",
  weight: "100 900",
  display: "swap",
});

// Optional display font Clash Grotesk: its license forbids redistribution, so the
// file is git-ignored. Used only if present at build time (static export), else Inter.
const CLASH_FILE = "public/fonts/ClashGrotesk-Variable.ttf";
const hasClash = fs.existsSync(path.join(process.cwd(), CLASH_FILE));
const clashFontFace = `@font-face {
  font-family: "Clash Grotesk";
  src: url("/fonts/ClashGrotesk-Variable.ttf") format("truetype");
  font-weight: 200 700;
  font-style: normal;
  font-display: swap;
}`;
const fontStack = `${hasClash ? '"Clash Grotesk", ' : ""}var(--font-inter), ui-sans-serif, system-ui, sans-serif`;

export const metadata = {
  title: {
    default: "Foriq",
    template: "%s · Foriq",
  },
  description: "Stückzahlzähler und Maschinenüberwachung für die Industrie",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "Foriq",
    statusBarStyle: "default",
  },
  icons: {
    icon: [
      { url: "/foriq-icon.svg", type: "image/svg+xml" },
      { url: "/foriq-icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    shortcut: "/foriq-icon.svg",
    apple: { url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
  },
};

const themeBootstrap = `
  try {
    var t = localStorage.getItem('foriq-theme');
    if (t === 'dark') document.documentElement.classList.add('dark');
    if (localStorage.getItem('foriq-locale') === 'en') document.documentElement.lang = 'en';
  } catch (e) {}
`;

export default function RootLayout({ children }) {
  if (hasClash) preload("/fonts/ClashGrotesk-Variable.ttf", { as: "font", type: "font/ttf", crossOrigin: "anonymous" });
  return (
    <html lang="de" data-font={hasClash ? "clash" : "inter"} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
        {hasClash && <style dangerouslySetInnerHTML={{ __html: clashFontFace }} />}
      </head>
      <body className={`${inter.variable} font-sans antialiased`} style={{ "--font-sans": fontStack }}>
        <ThemeProvider>
          <LocaleProvider>
            <AuthProvider>{children}</AuthProvider>
          </LocaleProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
