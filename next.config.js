/** @type {import('next').NextConfig} */
const nextConfig = {
  async redirects() {
    // The dashboard is the product; keep old /live links working.
    return [{ source: "/live", destination: "/", permanent: true }];
  },
};
module.exports = nextConfig;
