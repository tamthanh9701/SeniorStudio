/** @type {import('next').NextConfig} */
// Thumbnails come from Supabase Storage signed URLs, so the image optimizer
// needs the project host. Read from the environment and fail loudly at build
// time when it is missing: a silent skip would turn every thumbnail into a
// runtime 400 from next/image.
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
if (!supabaseUrl) {
  throw new Error("NEXT_PUBLIC_SUPABASE_URL must be set for next/image remotePatterns");
}

const nextConfig = {
  serverExternalPackages: ["sharp"],
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
