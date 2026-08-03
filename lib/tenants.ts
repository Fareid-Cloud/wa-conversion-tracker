// lib/tenants.ts
//
// من صاحب هذه الرسالة؟ من صاحب هذه النقرة؟
//
// **ما كان قبل هذا:** ثلاث خرائط مكتوبة في الكود (`tamkeen`, `thawabet`)
// تربط سلاج عميل بمساحة عمله وبحساب جوجل الخاصّ به. أي مشترك جديد في
// AdLoop كان يتطلّب تعديل الكود ونشراً جديداً - أي أنّ المتتبّع، وهو
// **جوهر ميزة التحقّق**، كان مستحيل الاستخدام كمنتج يشترك فيه الناس.
//
// **ما صار:** الهويّة تُقرأ من قاعدة البيانات المشتركة مع adloop-saas.
// مفتاح الربط هو `phone_number_id` - المعرّف الوحيد الذي يرسله ويب هوك
// واتساب مع كلّ رسالة واردة، فلا خيار في استخدامه.
//
// **لماذا قراءة مباشرة لا نداء HTTP:** المشروعان يتشاركان القاعدة نفسها
// بالفعل، والويب هوك على المسار الساخن - رحلة شبكة إضافية لكلّ رسالة
// واردة كلفة بلا مقابل. القراءة هنا **للقراءة فقط**؛ الكتابة في جداول
// adloop-saas تبقى ملكاً له وحده عبر واجهته.

import { Pool } from "pg";

const globalForTenantPool = globalThis as unknown as { waTenantPool?: Pool };

function pool(): Pool {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL غير مضبوط - لا يمكن تحديد صاحب الرسالة بدونه. اضبطه بنفس قيمة مشروع adloop-saas."
    );
  }
  if (!globalForTenantPool.waTenantPool) {
    globalForTenantPool.waTenantPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 3,
      idleTimeoutMillis: 30_000,
    });
  }
  return globalForTenantPool.waTenantPool;
}

export interface Tenant {
  workspaceId: string;
  /** رقم واتساب المعروض للزوّار (دولي بلا +) - إليه يُحوَّل الزائر */
  businessPhone: string | null;
  /** حساب Google Ads الذي تُرفع إليه التحويلات غير المتّصلة */
  googleAdsCustomerId: string | null;
  /** معرّف إجراء التحويل في جوجل - بدونه يُرفض الرفع كاملاً */
  googleConversionActionId: string | null;
}

const SELECT = `
  SELECT id                        AS "workspaceId",
         "whatsappBusinessPhone"   AS "businessPhone",
         "googleAdsCustomerId",
         "googleConversionActionId"
  FROM "Workspace"
`;

/** من رقم واتساب الوارد (ويب هوك Meta) إلى مساحة العمل. */
export async function tenantByPhoneNumberId(phoneNumberId: string): Promise<Tenant | null> {
  if (!phoneNumberId) return null;
  const res = await pool().query<Tenant>(
    `${SELECT} WHERE "whatsappPhoneNumberId" = $1 LIMIT 1`,
    [phoneNumberId]
  );
  return res.rows[0] ?? null;
}

/** من معرّف مساحة العمل في رابط الإعلان إلى بياناتها. */
export async function tenantByWorkspaceId(workspaceId: string): Promise<Tenant | null> {
  if (!workspaceId) return null;
  const res = await pool().query<Tenant>(`${SELECT} WHERE id = $1 LIMIT 1`, [workspaceId]);
  return res.rows[0] ?? null;
}
