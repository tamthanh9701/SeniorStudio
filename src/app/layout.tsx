export const metadata = {
  title: "SeniorStudio",
  description: "MCP-first AI Image Studio",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
