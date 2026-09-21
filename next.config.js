/** @type {import('next').NextConfig} */
// Thumbnails come from Supabase Storage signed URLs, so the image optimizer
// needs the project host. Read from the environment and fail loudly at build
// time when it is missing: a silent skip would turn every thumbnail into a
// runtime 400 from next/image.
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
if (!supabaseUrl) {
  throw new Error("NEXT_PUBLIC_SUPABASE_URL must be set for next/image remotePatterns");
}
// The scheme is read from the URL rather than assumed: a project reached over
// plain http (a local stack) must not be forced into an https connect-src, and a
// websocket upgrade follows the same scheme.
const supabase = new URL(supabaseUrl);
const supabaseSocketOrigin = `${supabase.protocol === "https:" ? "wss" : "ws"}://${supabase.host}`;
// A project reached over a private address (a local stack) is the only case where
// the image optimizer would refuse to fetch its signed URLs as an SSRF risk. The
// escape hatch is enabled for that host alone, so a hosted deployment keeps the
// default protection.
const supabaseIsPrivate =
  /^(127\.0\.0\.1|localhost|::1|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(supabase.hostname);

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
      // Only the configured Supabase origin, at whatever scheme it is served on.
      `connect-src 'self' ${supabase.origin} ${supabaseSocketOrigin} https://jultee.jp.auth0.com https://vitals.vercel-insights.com`,
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
    ...(supabaseIsPrivate ? { dangerouslyAllowLocalIP: true } : {}),
    remotePatterns: [
      {
        protocol: supabase.protocol === "https:" ? "https" : "http",
        hostname: supabase.hostname,
        port: supabase.port,
        pathname: "/storage/v1/object/sign/**",
      },
    ],
  },
  // The Vercel Node runtime this project deploys to is glibc; sharp's musl build is
  // never loaded, but the default trace ships both x64 and musl libvips (~36 MiB
  // unzipped) into every lambda — and the Vercel Function Storage meter counts that
  // per route. Excluding the unused musl binaries keeps only the glibc build, with no
  // runtime behavior change.
  outputFileTracingExcludes: {
    "/**": [
      "./node_modules/@img/sharp-libvips-linuxmusl-x64/**",
      "./node_modules/@img/sharp-linuxmusl-x64/**",
    ],
  },
  outputFileTracingRoot: __dirname,
};

module.exports = nextConfig;
