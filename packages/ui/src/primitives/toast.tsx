/**
 * Toast は sonner を薄くラップする (shadcn 最新流儀)。
 * 使い方:
 *   import { Toaster, toast } from "@stagecast/ui";
 *   <Toaster /> をアプリのルートに置き、 toast("配信を開始しました") で呼ぶ。
 */
import * as React from "react";
import { Toaster as SonnerToaster, toast } from "sonner";

export type ToasterProps = React.ComponentProps<typeof SonnerToaster>;

export function Toaster(props: ToasterProps) {
  return (
    <SonnerToaster
      theme="dark"
      position="bottom-right"
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-surface-2 group-[.toaster]:text-text-primary group-[.toaster]:border group-[.toaster]:border-line-2 group-[.toaster]:shadow-overlay",
          description: "group-[.toast]:text-text-secondary",
          actionButton: "group-[.toast]:bg-tally-500 group-[.toast]:text-white",
          cancelButton: "group-[.toast]:bg-surface-3 group-[.toast]:text-text-secondary",
        },
      }}
      {...props}
    />
  );
}

export { toast };
