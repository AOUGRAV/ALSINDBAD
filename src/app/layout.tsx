import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: 'السندباد | ALSINDBAD',
  description: 'إدارة حسابات ومشتريات وعمليات فرع جدة',
  robots: { index: false, follow: false },
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ar" dir="rtl"><body>{children}</body></html>;
}
