import { defineConfig } from '@vite-pwa/assets-generator/config';

// Our source (public/app-icon.svg) is already a full-bleed branded icon
// (edge-to-edge gradient with the cloud centered in the maskable safe zone).
// So we generate every variant with padding: 0 — the icon fills the whole
// square. This stops Android/Samsung from wrapping a padded square in a white
// rounded box; the launcher masks the full-bleed gradient into its squircle
// shape with no border. The cloud sits within the central safe zone, so the
// mask never clips it.
export default defineConfig({
  images: ['public/app-icon.svg'],
  preset: {
    transparent: {
      sizes: [64, 192, 512],
      favicons: [[48, 'favicon.ico']],
      padding: 0,
    },
    maskable: {
      sizes: [512],
      padding: 0,
    },
    apple: {
      sizes: [180],
      padding: 0,
      // iOS doesn't mask — give it the brand color behind any transparency.
      resizeOptions: { background: '#4f46e5' },
    },
  },
});
