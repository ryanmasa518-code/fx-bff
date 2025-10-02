export const metadata = {
  title: "FX BFF",
  description: "Indicators BFF on Vercel",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
