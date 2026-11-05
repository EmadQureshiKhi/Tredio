/** @type {import('next').NextConfig} */
const nextConfig = {
  // A second build (a check beside the running site) writes its own directory.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
};

export default nextConfig;
