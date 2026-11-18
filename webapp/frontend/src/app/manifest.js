// Static export: the manifest is generated as a file at build time.
export const dynamic = "force-static";

export default function manifest() {
  return {
    id: "/",
    name: "Foriq Maschinenüberwachung",
    short_name: "Foriq",
    description: "Maschinen überwachen und Stillstände sofort erkennen.",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    theme_color: "#cc0000",
    lang: "de-DE",
    categories: ["business", "productivity"],
    icons: [
      {
        src: "/foriq-icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/foriq-icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/foriq-icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
    ],
  };
}
