import type { Metadata } from 'next'
import { inter, outfit } from './fonts'
import './globals.css'

export const metadata: Metadata = {
  title: 'OpenLance - The Future of Freelancing',
  description: 'A transparent, secure, and modern marketplace for freelancers and clients.',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en">
      <body className={`${inter.variable} ${outfit.variable} font-sans antialiased bg-slate-950 text-slate-100`}>
        {children}
      </body>
    </html>
  )
}
