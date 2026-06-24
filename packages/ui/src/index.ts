/**
 * @stagecast/ui
 *
 * 各 app は `import { Button } from "@stagecast/ui"` のように使う。
 * CSS は別途 `import "@stagecast/ui/styles.css"`。
 * Tailwind preset は `import preset from "@stagecast/ui/tailwind-preset"`。
 */

// lib
export { cn } from "./lib/cn.js";

// primitives
export * from "./primitives/button.js";
export * from "./primitives/input.js";
export * from "./primitives/label.js";
export * from "./primitives/card.js";
export * from "./primitives/separator.js";
export * from "./primitives/skeleton.js";
export * from "./primitives/tabs.js";
export * from "./primitives/tooltip.js";
export * from "./primitives/dialog.js";
export * from "./primitives/alert-dialog.js";
export * from "./primitives/sheet.js";
export * from "./primitives/dropdown-menu.js";
export * from "./primitives/select.js";
export * from "./primitives/toast.js";
