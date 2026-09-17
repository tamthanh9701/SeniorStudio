/** @type {import('next').NextConfig} */
// Thumbnails come from Supabase Storage signed URLs, so the image optimizer
// needs the project host. Read from the environment and fail loudly at build
// time when it is missing: a silent skip would turn every thumbnail into a
// runtime 400 from next/image.
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
if (!supabaseUrl) {
  throw new Error("NEXT_PUBLIC_SUPABASE_URL must be set for next/image remotePatterns");
}

/** Headers every response carries; the CSP is production-only so `next dev` keeps working. */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      // The theme bootstrap and Next's bootstrap scripts are inline.
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      `connect-src 'self' https://${new URL(supabaseUrl).hostname} wss://${new URL(supabaseUrl).hostname} https://jultee.jp.auth0.com https://vitals.vercel-insights.com`,
      "frame-ancestors 'none'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  },
];

const nextConfig = {
  serverExternalPackages: ["sharp"],
  async headers() {
    const csp = securityHeaders.filter((header) => process.env.NODE_ENV === "production" || header.key !== "Content-Security-Policy");
    return [
      {
        source: "/:path*",
        headers: csp,
      },
    ];
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: new URL(supabaseUrl).hostname,
        pathname: "/storage/v1/object/sign/**",
      },
    ],
  },
};

module.exports = nextConfig;
