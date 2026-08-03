// lib/db.ts
//
// تخزين الكليكات على Postgres.
//
// **لماذا تُرك SQLite:** لم يكن اختياراً بين قاعدتين، بل عطلاً فعلياً على
// بيئة النشر. نظام ملفّات Vercel للدوالّ عابر - ملفّ `tracker.db` كان
// يُنشأ فارغاً مع كلّ استدعاء بارد ويختفي بعده، فأيّ كليك يُسجَّل في
// طلب لا يوجد في الطلب التالي. أي أنّ ربط رسالة واتساب بكليكها -
// وهو **جوهر المنتج كلّه** - كان مستحيلاً في الإنتاج لا بطيئاً.
//
// نستخدم `pg` مباشرةً لا Prisma: الجدول واحد وأربع دوالّ، فإضافة Prisma
// ومولّده إلى مشروع ثانٍ كلفة بلا مقابل هنا.

import { Pool } from "pg";

// عالمي عبر عمليات إعادة التحميل الساخن: كلّ Pool جديد يفتح اتصالات
// جديدة، وطرف Neon المجمَّع له سقف - التطوير وحده كان سيستنفده.
const globalForPool = globalThis as unknown as { waTrackerPool?: Pool };

function getPool(): Pool {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL غير مضبوط - تتبّع الكليكات لا يعمل بدونه. اضبطه بنفس قيمة مشروع adloop-saas."
    );
  }
  if (!globalForPool.waTrackerPool) {
    globalForPool.waTrackerPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 3, // دوالّ serverless: اتصالات قليلة لكلّ نسخة، والسقف على الطرف المجمَّع
      idleTimeoutMillis: 30_000,
    });
  }
  return globalForPool.waTrackerPool;
}

// ==================== تهيئة المخطَّط ====================
//
// تُنفَّذ مرّة واحدة لكلّ نسخة عند أوّل استعلام، لا عند الاستيراد: تنفيذها
// وقت الاستيراد كان يجعل كلّ بدء بارد ينتظر رحلة إلى قاعدة البيانات حتى
// في المسارات التي لا تلمسها.
let schemaReady: Promise<void> | null = null;

function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      const pool = getPool();
      // اسم الجدول مسبوق بـ`wa_` لأنّه يشارك قاعدة بيانات adloop-saas
      // نفسها، فيبقى واضحاً أيّ مشروع يملكه.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS wa_clicks (
          code              TEXT PRIMARY KEY,
          gclid             TEXT NOT NULL,
          platform          TEXT NOT NULL DEFAULT 'GOOGLE_ADS',
          site_source_name  TEXT,
          client_id         TEXT NOT NULL,
          campaign_id       TEXT,
          created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
          matched           BOOLEAN NOT NULL DEFAULT false,
          matched_at        TIMESTAMPTZ,
          phone_number      TEXT,
          sent_to_google    BOOLEAN NOT NULL DEFAULT false,
          ip_address        TEXT,
          visitor_id        TEXT,
          user_agent        TEXT
        );
      `);
      // البحث الفعلي يجري بالزائر وبالعميل، لا بالمفتاح وحده.
      await pool.query(
        `CREATE INDEX IF NOT EXISTS wa_clicks_visitor_idx ON wa_clicks (visitor_id);`
      );
      await pool.query(
        `CREATE INDEX IF NOT EXISTS wa_clicks_client_created_idx ON wa_clicks (client_id, created_at DESC);`
      );
    })().catch((err) => {
      // لا نُبقي وعداً مرفوضاً مخزَّناً: الطلب التالي يستحقّ محاولة جديدة
      // بدل أن يرث فشلاً عابراً في الشبكة إلى الأبد.
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

export interface ClickRecord {
  code: string;
  /** الاسم قديم للتوافق، لكنه يحمل معرّف الكليك من أيّ منصّة (fbclid/ttclid/sc_click_id أيضاً) */
  gclid: string;
  platform: string;
  site_source_name?: string | null;
  client_id: string;
  campaign_id?: string | null;
  created_at: Date;
  matched: boolean;
  matched_at?: Date | null;
  phone_number?: string | null;
  sent_to_google: boolean;
  ip_address?: string | null;
  visitor_id?: string | null;
  user_agent?: string | null;
}

export async function saveClick(params: {
  code: string;
  gclid: string;
  platform: string;
  site_source_name?: string;
  client_id: string;
  campaign_id?: string;
  ip_address?: string;
  visitor_id?: string;
  user_agent?: string;
}): Promise<void> {
  await ensureSchema();
  await getPool().query(
    `INSERT INTO wa_clicks
       (code, gclid, platform, site_source_name, client_id, campaign_id, ip_address, visitor_id, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (code) DO NOTHING`,
    [
      params.code,
      params.gclid,
      params.platform,
      params.site_source_name ?? null,
      params.client_id,
      params.campaign_id ?? null,
      params.ip_address ?? null,
      params.visitor_id ?? null,
      params.user_agent ?? null,
    ]
  );
}

export async function findClickByCode(code: string): Promise<ClickRecord | undefined> {
  await ensureSchema();
  const res = await getPool().query<ClickRecord>(
    `SELECT * FROM wa_clicks WHERE code = $1`,
    [code]
  );
  return res.rows[0];
}

export async function markMatched(code: string, phoneNumber: string): Promise<void> {
  await ensureSchema();
  await getPool().query(
    `UPDATE wa_clicks SET matched = true, matched_at = now(), phone_number = $2 WHERE code = $1`,
    [code, phoneNumber]
  );
}

export async function markSentToGoogle(code: string): Promise<void> {
  await ensureSchema();
  await getPool().query(
    `UPDATE wa_clicks SET sent_to_google = true WHERE code = $1`,
    [code]
  );
}
