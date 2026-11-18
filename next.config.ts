import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The runtime and the A2UI compiler are server-only; keep them out of the bundler.
  serverExternalPackages: ["@copilotkit/runtime", "@a2ui/agent"],
  devIndicators: false,
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // The whole point of the app is the microphone, so allow it for this origin only.
          { key: "Permissions-Policy", value: "microphone=(self), camera=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
