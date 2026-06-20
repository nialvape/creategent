import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'

const inter = Inter({ subsets: ['latin'], variable: '--font-sans' })

export const metadata: Metadata = {
  title: 'CreateGent — AI Content Creation',
  description: 'Transform your ideas into ready-to-publish social media content packages with multi-agent AI',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} dark h-full`}>
      <body className="min-h-full bg-background text-foreground antialiased" suppressHydrationWarning>{children}</body>
    </html>
  )
}
