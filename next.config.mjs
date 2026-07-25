/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // PDF parsing and page rasterization are Node-only and ship prebuilt native
  // bindings — leave them to require() at runtime instead of bundling them.
  serverExternalPackages: ["pdf-parse", "pdfjs-dist", "@napi-rs/canvas"],
};

export default nextConfig;
