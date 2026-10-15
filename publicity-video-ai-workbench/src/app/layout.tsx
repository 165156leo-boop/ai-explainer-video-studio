import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI 科普动画生产工作台",
  description: "从审定脚本到分镜、画面和动画视频候选的人机协作工作台",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
