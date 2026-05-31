// SPDX-License-Identifier: AGPL-3.0-only
//
// Postcss pipeline for admin-web. Tailwind v4 is the only plugin —
// it includes its own autoprefixer-equivalent under the hood.

export default {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};
