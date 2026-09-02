// lib/attributionSync.ts
//
// بيوصّل wa-conversion-tracker بمحرك الإسناد في adloop-saas عبر HTTP.
// كل النداءات "best-effort" - لو adloop-saas واقعة، ميوقفش تدفق الواتساب
// الأساسي (رفع التحويل لجوجل يفضل شغال حتى لو المزامنة دي فشلت).
//
// 🔴 **"best-effort" كانت بتتحوّل لـ"مبتتبعتش أصلاً".**
//
// النداءات كانت `void callAdLoopApi(...)` - وعد متسايب من غير انتظار.
// وده على Vercel مش "بيكمّل في الخلفية": اللحظة اللي الرد بيترجع فيها،
// الـruntime بيتجمّد أو يتقفل، والـfetch اللي لسه في الطريق بيموت من غير
// ما ينفّذ ومن غير ما يسجّل سطر واحد. يعني: كليك متسجّلش، تحقّق ماوصلش،
// وعمود verifiedConversions - وهو دعوى المنتج نفسها - بينقص بصمت.
//
// **الإصلاح `after()` من `next/server`:** بتسجّل الشغل في سياق الطلب،
// فالمنصّة بتفضل مستنية خلوصه **بعد** ما الرد يمشي. فلا الرد بيتأخّر
// ولا النداء بيضيع - وهما الاتنين اللي كنا مضطرين نختار بينهم قبل كده.
//
// والمهلة (`ADLOOP_TIMEOUT_MS`) لازمة معاها: `after()` بيمدّ عمر الدالة
// لحد `maxDuration`، فـadloop معلّقة كانت هتحجز الدالة للآخر من غير مهلة.

import { after } from "next/server";

// `clientId` هنا **هو** معرّف مساحة العمل مباشرةً. كانت خريطة سلاجات
// مكتوبة في الكود تترجمه، فكان كلّ مشترك جديد يتطلّب متغيّر بيئة ونشراً.
const ADLOOP_API_BASE = process.env.ADLOOP_API_BASE ?? "";

/** أطول من كده مش استبطاء - ده طرف تاني واقع، والانتظار بيحجز الدالة. */
const ADLOOP_TIMEOUT_MS = 8_000;

async function callAdLoopApi(path: string, body: unknown) {
  if (!ADLOOP_API_BASE || !process.env.INTERNAL_SERVICE_SECRET) {
    console.warn(`ADLOOP_API_BASE أو INTERNAL_SERVICE_SECRET غير مضبوطين - تخطينا مزامنة الإسناد (${path})`);
    return;
  }

  try {
    const res = await fetch(`${ADLOOP_API_BASE}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.INTERNAL_SERVICE_SECRET}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ADLOOP_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`فشلت مزامنة الإسناد (${path}): ${res.status}`);
    }
  } catch (err) {
    console.error(`فشل الاتصال بـ adloop-saas للإسناد (${path}):`, err);
  }
}

/**
 * بيسلّم النداء لـ`after()` فيتنفّذ بعد ما الرد يمشي، من غير ما يتأخّر
 * الرد ومن غير ما يضيع النداء.
 *
 * و`after()` بترمي لو اتنادت بره سياق طلب (سكربت أو اختبار). هناك بس
 * بنرجع للتنفيذ المتسايب: العملية في السكربت بتفضل عايشة لحد ما الشغل
 * يخلص، فالسبب اللي خلّى `void` غلط في الـroute مش موجود أصلاً.
 */
function deliver(path: string, body: unknown) {
  try {
    after(() => callAdLoopApi(path, body));
  } catch {
    void callAdLoopApi(path, body);
  }
}

export function syncClickToAttribution(params: {
  clientId: string;
  platform: string;
  code: string;
  gclid?: string;
  phoneHint?: string;
  ipAddress?: string;
  userAgent?: string;
  clickedAt: Date;
}) {
  const workspaceId = params.clientId;
  if (!workspaceId) return;

  deliver("/api/attribution/sync-click", {
    workspaceId,
    platform: params.platform,
    code: params.code,
    gclid: params.gclid,
    phoneHint: params.phoneHint,
    ipAddress: params.ipAddress,
    userAgent: params.userAgent,
    clickedAt: params.clickedAt.toISOString(),
  });
}

export function markMatchedInAttribution(params: {
  clientId: string;
  code: string;
  conversationId: string;
  receivedAt: Date;
  platform: string;
  campaignId?: string;
}) {
  const workspaceId = params.clientId;
  if (!workspaceId) return;

  deliver("/api/attribution/mark-matched", {
    workspaceId,
    code: params.code,
    conversationId: params.conversationId,
    receivedAt: params.receivedAt.toISOString(),
    platform: params.platform,
    campaignId: params.campaignId,
  });
}

// ==================== طبقة اللمسات (Multi-Touch) ====================
//
// دي **إضافة فوق** محرك الإسناد الأصلي مش بديل عنه: الأصلي (sync-click /
// mark-matched / unattributed) بيجاوب "المحادثة دي جت منين؟" بيقين أو
// باحتمال. الطبقة دي بتجاوب سؤال تاني مختلف تماماً: "الرحلة كاملة عدّت
// على إيه قبل ما تتحوّل؟". الاتنين شغالين مع بعض على نفس الكليك - مفيش
// حاجة اتلغت.

export function recordTouchpoint(params: {
  clientId: string;
  visitorId: string;
  kind: "AD_CLICK" | "AD_VIEW" | "SITE_VISIT" | "CRM_EVENT" | "MESSAGE";
  platform?: string;
  campaignId?: string;
  clickId?: string;
  source?: string;
  medium?: string;
  referrer?: string;
  landingPath?: string;
  occurredAt?: Date;
}) {
  const workspaceId = params.clientId;
  if (!workspaceId) return;

  deliver("/api/attribution/touchpoint", {
    workspaceId,
    visitorId: params.visitorId,
    kind: params.kind,
    platform: params.platform,
    campaignId: params.campaignId,
    clickId: params.clickId,
    source: params.source,
    medium: params.medium,
    referrer: params.referrer,
    landingPath: params.landingPath,
    occurredAt: (params.occurredAt ?? new Date()).toISOString(),
  });
}

/**
 * حدث تحويل حقيقي. الرقم بيتبعت نصاً صريحاً هنا وبيتهشّم SHA-256 على
 * خادم adloop-saas **قبل** ما يتكتب في قاعدة البيانات - مبيتخزّنش صريح
 * في أي مكان. الاتصال نفسه بين المشروعين HTTPS بتوكن داخلي.
 *
 * ده كمان اللي بيقفل الـTODO القديم بتاع sendMetaConversion/
 * sendTikTokConversion: بدل ما كل منصة تتبني هنا لوحدها، الحدث بيتسجّل
 * مرة واحدة وadloop-saas بيرفعه للتلاتة من مكان واحد (lib/conversionSync.ts).
 */
export function recordConversion(params: {
  clientId: string;
  externalId: string;
  eventName: string;
  visitorId?: string;
  phone?: string;
  value?: number;
  verified: boolean;
  gclid?: string;
  fbclid?: string;
  ttclid?: string;
  ipAddress?: string;
  userAgent?: string;
  occurredAt?: Date;
  /** `"whatsapp"` | `"messenger"` | `"website"` - بيحدّد `action_source` عند ميتا */
  sourceKind?: string;
  /** `referral.ctwa_clid` من أول رسالة - الرابط بين المحادثة والإعلان */
  ctwaClid?: string;
}) {
  const workspaceId = params.clientId;
  if (!workspaceId) return;

  deliver("/api/attribution/conversion", {
    workspaceId,
    externalId: params.externalId,
    eventName: params.eventName,
    visitorId: params.visitorId,
    phone: params.phone,
    value: params.value ?? 0,
    verified: params.verified,
    gclid: params.gclid,
    fbclid: params.fbclid,
    ttclid: params.ttclid,
    ipAddress: params.ipAddress,
    userAgent: params.userAgent,
    occurredAt: (params.occurredAt ?? new Date()).toISOString(),
    sourceKind: params.sourceKind,
    ctwaClid: params.ctwaClid,
  });
}

export async function processUnattributedConversation(params: {
  clientId: string;
  conversationId: string;
  receivedAt: Date;
  phoneNumber?: string;
}) {
  const workspaceId = params.clientId;
  if (!workspaceId) return;

  await callAdLoopApi("/api/attribution/unattributed", {
    workspaceId,
    conversationId: params.conversationId,
    receivedAt: params.receivedAt.toISOString(),
    phoneNumber: params.phoneNumber,
  });
}
