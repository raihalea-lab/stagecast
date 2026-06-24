import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

/**
 * stagecast 共通 Tailwind preset (ADR 0013)
 *
 * 各 app の tailwind.config.ts は `presets: [stagecastPreset]` で読み込み、
 * `content` だけ自分のソースを指定する。 色やフォントの直値はここに書かず、
 * すべて var(--*) で tokens.css を参照する。
 */
export const stagecastPreset = {
  darkMode: ["class", '[data-theme="dark"]'],
  content: [],
  theme: {
    extend: {
      colors: {
        surface: {
          0: "var(--surface-0)",
          1: "var(--surface-1)",
          2: "var(--surface-2)",
          3: "var(--surface-3)",
          4: "var(--surface-4)",
        },
        text: {
          primary: "var(--text-primary)",
          secondary: "var(--text-secondary)",
          tertiary: "var(--text-tertiary)",
          disabled: "var(--text-disabled)",
        },
        line: {
          1: "var(--line-1)",
          2: "var(--line-2)",
          3: "var(--line-3)",
        },
        tally: {
          50: "var(--tally-50)",
          500: "var(--tally-500)",
          600: "var(--tally-600)",
          700: "var(--tally-700)",
        },
        preview: {
          500: "var(--preview-500)",
        },
        success: "var(--success)",
        warning: "var(--warning)",
        error: "var(--error)",
        info: "var(--info)",
      },
      fontFamily: {
        sans: ['"InterVariable"', "system-ui", "-apple-system", '"Segoe UI"', "sans-serif"],
        mono: ['"JetBrains MonoVariable"', "ui-monospace", '"SF Mono"', "Menlo", "monospace"],
      },
      borderRadius: {
        sm: "var(--radius-sm)",
        md: "var(--radius-md)",
        lg: "var(--radius-lg)",
        xl: "var(--radius-xl)",
      },
      boxShadow: {
        overlay: "var(--shadow-overlay)",
        tally: "var(--tally-glow)",
        preview: "var(--preview-glow)",
      },
      transitionTimingFunction: {
        standard: "var(--ease-standard)",
        decel: "var(--ease-decel)",
        accel: "var(--ease-accel)",
      },
      transitionDuration: {
        fast: "120ms",
        base: "200ms",
        slow: "320ms",
      },
      keyframes: {
        "tally-pulse": {
          "0%, 100%": { boxShadow: "var(--tally-glow)" },
          "50%": {
            boxShadow:
              "0 0 0 1px rgba(220,38,38,0.55), 0 0 18px 2px rgba(220,38,38,0.45), inset 0 0 0 1px rgba(220,38,38,0.75)",
          },
        },
      },
      animation: {
        "tally-pulse": "tally-pulse 1600ms ease-in-out infinite",
      },
    },
  },
  plugins: [animate],
} satisfies Config;

export default stagecastPreset;
