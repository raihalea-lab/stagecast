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
      // 色はトークン (bg-surface-2 等) で追従するが、sonner 内蔵のアイコン色は theme で決まる。
      // ダーク固定だとライトテーマの画面で浮くので、アプリが自分のテーマを渡す。
      theme="system"
      position="bottom-right"
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-surface-2 group-[.toaster]:text-text-primary group-[.toaster]:border group-[.toaster]:border-line-2 group-[.toaster]:shadow-overlay",
          description: "group-[.toast]:text-text-secondary",
          actionButton: "group-[.toast]:bg-brand-600 group-[.toast]:text-white",
          cancelButton: "group-[.toast]:bg-surface-3 group-[.toast]:text-text-secondary",
        },
      }}
      {...props}
    />
  );
}

export { toast };
