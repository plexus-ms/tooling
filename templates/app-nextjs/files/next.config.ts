import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

// The workspace root, two levels up from this app; under `plx umbrella` it is the umbrella's,
// where the dependencies are then installed.
const root = process.env.PLX_UMBRELLA_ROOT || fileURLToPath(new URL('../../', import.meta.url));

const nextConfig: NextConfig = {
  output: 'standalone',
  // BUILD_HASH comes from the image build; without it Next draws a random ID, as in development.
  generateBuildId: () => process.env.BUILD_HASH || null,
  outputFileTracingRoot: root,
  turbopack: { root },
};

export default nextConfig;
