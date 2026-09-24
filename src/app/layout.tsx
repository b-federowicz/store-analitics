import type { Metadata } from "next";
import { Montserrat } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "@/components/theme/theme-provider";
import { StoreProvider } from "@/stores/provider";
import { AppChrome } from "@/components/app-chrome";

const montserrat = Montserrat({
  variable: "--font-geist-montserrat",
  subsets: ["latin"],
});


export const metadata: Metadata = {
  title: "E-commerce Analytics",
  description: "Gives information about profit of the store",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${montserrat.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col">
        <StoreProvider> 
          <ThemeProvider
            attribute="class"
            defaultTheme="dark"
            enableSystem
          >
            <AppChrome>{children}</AppChrome>
          </ThemeProvider>
        </StoreProvider>
      </body>
    </html>
  );
}
