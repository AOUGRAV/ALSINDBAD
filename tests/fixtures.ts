import { type Dataset, type Entry, today } from '../src/lib/domain';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export function sampleData(): Dataset {
  const date = today(), created_at = new Date().toISOString();
  const product = (n: number, name: string, category: string, unit: string) => ({ id: id(n), name, category, unit, expiry: null, created_at });
  const e = (n: number, input: Partial<Entry>): Entry => ({
    id: id(n), date, created_at, kind: 'expense', party: 'جهة تجريبية', description: 'عملية تجريبية', category: 'تشغيل',
    scope: 'business', currency: 'SAR', amount: 10000, paid: 10000, rate: 1, method: 'bank',
    product_id: null, quantity: 0, settles_id: null, receipt_path: null, container_id: null, opening: false, revision: 1, voided_at: null, ...input,
  });
  return {
    products: [product(1, 'زيت زيتون · كرتون 12 عبوة', 'مواد غذائية', 'كرتون'), product(2, 'عطر عود · عبوة 100 مل', 'عطور', 'كرتون'), product(3, 'فحم طبيعي · كيس 10 كجم', 'فحم', 'كيس')],
    containers: [{ id: id(4), name: 'JED–001', destination: 'المملكة المتحدة', booking: 'BK-DEMO-01', status: 'preparing', created_at, manifest_revision: 0, gbp_rate: null }],
    entries: [
      e(11, { kind: 'funding', party: 'المالك (تجريبي)', description: 'تمويل عمليات جدة', amount: 15000000, paid: 15000000, category: 'رأس المال' }),
      e(12, { kind: 'borrow', party: 'مموّل تجريبي', description: 'تمويل مؤقت لشراء البضائع', currency: 'USD', rate: 3.75, amount: 1000000, paid: 1000000, category: 'تمويل مؤقت' }),
      e(13, { kind: 'purchase', party: 'مورد الأغذية (تجريبي)', description: 'شراء زيت زيتون للحاوية الأولى', product_id: id(1), quantity: 120, amount: 2880000, paid: 2000000, category: 'مواد غذائية' }),
      e(14, { kind: 'purchase', party: 'مورد العطور (تجريبي)', description: 'تجهيز طلبية العطور', product_id: id(2), quantity: 40, amount: 1840000, paid: 1840000, category: 'عطور' }),
      e(15, { kind: 'purchase', party: 'مورد الفحم (تجريبي)', description: 'شراء فحم طبيعي', product_id: id(3), quantity: 200, amount: 1300000, paid: 1300000, category: 'فحم' }),
      e(16, { party: 'مكتب التأجير (تجريبي)', description: 'إيجار سيارة لعمليات الفرع', category: 'إيجار سيارة', amount: 280000, paid: 280000 }),
      e(17, { party: 'مطعم (تجريبي)', description: 'وجبة غداء', scope: 'personal', category: 'أكل وشرب', amount: 8500, paid: 8500, method: 'cash' }),
      e(18, { kind: 'lend', party: 'صديق تجريبي', description: 'سلفة شخصية مستردة', scope: 'personal', amount: 500000, paid: 500000, category: 'سلف شخصية' }),
    ],
    loads: [{ id: id(20), product_id: id(1), container_id: id(4), quantity: 80, cost_sar: 1920000, created_at }, { id: id(21), product_id: id(3), container_id: id(4), quantity: 150, cost_sar: 975000, created_at }],
    invoice_loads: [],
    history: [],
  };
}
