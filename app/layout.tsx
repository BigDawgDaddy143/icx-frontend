import "./globals.css";

export const metadata = {
  title: "ICX — H100 GPU Price Index",
  description: "Live H100 GPU pricing across cloud providers",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
