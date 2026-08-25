import type { NextConfig } from 'next';

/**
 * Static export, served in production over the custom `app://` scheme.
 *
 * Do NOT set `assetPrefix` — `app://` is registered as a standard scheme, so
 * Next's absolute `/_next/...` URLs resolve correctly at any route depth.
 * The `assetPrefix: './'` trick only works for a single flat page and breaks
 * everything below the root.
 */
const config: NextConfig = {
  output: 'export',
  trailingSlash: true,
  reactStrictMode: true,
  // Mandatory with `output: 'export'` — there is no image optimizer.
  // We use inline SVG throughout and never import `next/image`.
  images: { unoptimized: true },
};

export default config;
