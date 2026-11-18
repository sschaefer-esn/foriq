// Production: static export to out/, served by the backend (FORIQ_FRONTEND_DIR)
// on the same origin as the API. Development (`next dev`): /api/* is forwarded
// to the local backend – rewrites do not exist in a static export.
const isDev = process.env.NODE_ENV === "development";
const DEV_BACKEND = process.env.FORIQ_DEV_BACKEND || "http://localhost:8005";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // trailingSlash: false → /devices becomes out/devices.html; the backend resolves
  // deep links via <path>.html or <path>/index.html.
  trailingSlash: false,
  images: { unoptimized: true },
  ...(isDev
    ? {
        // Without compression the dev server passes the SSE stream through unbuffered.
        compress: false,
        async rewrites() {
          return [{ source: "/api/:path*", destination: `${DEV_BACKEND}/api/:path*` }];
        },
      }
    : { output: "export" }),
};

export default nextConfig;
