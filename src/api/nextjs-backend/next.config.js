/** @type {import('next').NextConfig} */
const nextConfig = {
  // External packages for server components (moved from experimental in Next 15)
  serverExternalPackages: ["prisma", "@prisma/client"],

  // Webpack configuration for dependency injection
  webpack: (config, { isServer }) => {
    // Enable decorators and metadata for dependency injection
    if (isServer) {
      config.externals.push("reflect-metadata");
    }

    return config;
  },

  // API routes configuration
  async rewrites() {
    return [
      {
        source: "/api/v1/:path*",
        destination: "/api/:path*",
      },
    ];
  },

  // Static security headers.
  //
  // CORS is intentionally NOT set here. A static header block cannot vary
  // `Access-Control-Allow-Origin` per request, and emitting the raw
  // comma-separated ALLOWED_ORIGINS value produces an invalid ACAO header that
  // browsers reject. Origin-reflection CORS lives in src/middleware.ts instead.
  async headers() {
    return [
      {
        source: "/api/:path*",
        headers: [
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
          {
            key: "X-Frame-Options",
            value: "DENY",
          },
          {
            // OWASP guidance: the legacy XSS auditor can introduce
            // vulnerabilities; disable it and rely on CSP instead.
            key: "X-XSS-Protection",
            value: "0",
          },
          {
            key: "Referrer-Policy",
            value: "no-referrer",
          },
        ],
      },
    ];
  },

  // NOTE: DATABASE_URL and JWT_SECRET are deliberately NOT exposed via the
  // `env` key. Values placed there are inlined into the JavaScript bundle at
  // build time (including client bundles) — a secret-leak. Server code reads
  // them directly from process.env in route handlers / server components.

  // Logging configuration
  logging: {
    fetches: {
      fullUrl: process.env.NODE_ENV === "development",
    },
  },

  // Performance optimizations
  compress: true,
  poweredByHeader: false,

  // TypeScript configuration
  typescript: {
    ignoreBuildErrors: false,
  },

  // ESLint configuration
  eslint: {
    ignoreDuringBuilds: false,
  },
};

module.exports = nextConfig;
