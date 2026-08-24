/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // Single calm accent on an otherwise white/grey UI.
        brand: {
          DEFAULT: '#2563eb',
          dark: '#1d4ed8',
          light: '#eff6ff'
        }
      },
      maxWidth: {
        app: '520px'
      }
    }
  },
  plugins: []
}
