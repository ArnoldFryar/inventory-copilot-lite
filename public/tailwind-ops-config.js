// Tailwind Play CDN theme config for ops.html (marketing landing page).
// Must be loaded AFTER cdn.tailwindcss.com so the `tailwind` global exists.
tailwind.config = {
  theme: {
    extend: {
      fontFamily: { sans: ['Inter', 'system-ui', 'sans-serif'] },
      colors: {
        brand: {
          50:  '#eef2ff',
          100: '#e0e7ff',
          400: '#818cf8',
          500: '#6366f1',
          600: '#4f46e5',
          700: '#4338ca',
        },
        surface: {
          DEFAULT: '#0f1117',
          2:       '#161822',
          3:       '#1e2030',
          4:       '#262940',
        },
        ink: {
          300: '#94a3b8',
          400: '#64748b',
          500: '#475569',
        },
      },
    },
  },
};
