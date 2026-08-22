/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  // Keep native / heavy document-conversion packages out of the server bundle so
  // they're required from node_modules at runtime. Bundling `sharp` (a native
  // addon) breaks its binary resolution in the serverless runtime, which threw
  // at module import and 500'd the NQAi upload route for EVERY file — including
  // valid JPEGs that never actually need conversion.
  serverExternalPackages: ["sharp", "mammoth", "word-extractor"],
  // Server Actions validate the request Origin against the forwarded Host.
  // Behind custom domains and the apex -> www redirect (mcc-btp.app -> www.mcc-btp.app),
  // those can differ from the deployment URL, which makes Next reject the action
  // (e.g. the activity "email log" Server Action silently fails on mcc-btp.app).
  // Allow every production/preview host the app is served from.
  experimental: {
    serverActions: {
      allowedOrigins: [
        "mcc-btp.app",
        "www.mcc-btp.app",
        "mcc-btp.ipostrad.app",
        "*.ipostrad.app",
        "*.vercel.app",
      ],
    },
  },
  // Legacy notification hrefs: older notifications persisted in the DB point at
  // routes that never existed (they 404'd when clicked from the bell). Redirect
  // each stale path to the real page so historic notifications keep working.
  async redirects() {
    return [
      { source: "/dashboard/yield", destination: "/dashboard/ppp", permanent: true },
      { source: "/dashboard/monetization", destination: "/dashboard/instruments", permanent: true },
      { source: "/dashboard/commodities", destination: "/dashboard/commodity", permanent: true },
      { source: "/dashboard/download-of-funds", destination: "/dashboard/institutional", permanent: true },
    ]
  },
}

export default nextConfig
