// app/api/track-click/route.ts
//
// الرابط ده هو اللي بيتحط في الإعلان بدل رابط الواتساب المباشر - ولازم
// يشتغل مع أي منصة إعلانية، مش جوجل بس (كان قافل على gclid لوحده، وده
// كان معناه إن أي كليك من ميتا/تيك توك/سناب شات بيتحوّل للواتساب من غير
// أي تتبع خالص - إصلاح جوهري، مش تحسين تجميلي).
//
// كل منصة بتضيف معرف الكليك بتاعها في رابط الإعلان تلقائياً بباراميتر
// مختلف: جوجل = {gclid}, ميتا = {fbclid}, تيك توك = {ttclid}, سناب شات = {sc_click_id}
// **الهويّة:** `ws` = معرّف مساحة العمل في AdLoop. كان الرابط يحمل سلاج
// عميل (`client=<اسم عميل>`) مقروءاً من خريطة مكتوبة في الكود، فكان كلّ
// مشترك جديد يتطلّب تعديلاً ونشراً. الآن يُقرأ من قاعدة البيانات، ورقم
// الواتساب يأتي من إعدادات المساحة نفسها فلا يكتبه المعلن في الرابط.
//
// مثال: https://yourdomain.com/api/track-click?gclid={gclid}&ws=cms1uh...
// أو:   https://yourdomain.com/api/track-click?fbclid={fbclid}&ws=cms1uh...

import { NextRequest, NextResponse } from "next/server";
import { customAlphabet } from "nanoid";
import { saveClick } from "@/lib/db";
import { syncClickToAttribution, recordTouchpoint } from "@/lib/attributionSync";
import { tenantByWorkspaceId } from "@/lib/tenants";

// كود قصير وسهل القراءة (أحرف كبيرة + أرقام، من غير حروف ملبسة زي 0/O أو 1/I)
const generateCode = customAlphabet("ABCDEFGHJKMNPQRSTUVWXYZ23456789", 6);

// معرف الزائر: أطول وأعشوائي أكتر من كود الـRef، لأن ده مش مقروء ببني آدم
// ولا بيتكتب في رسالة - وظيفته الوحيدة إنه يفضل فريد عبر ملايين الزوار
const generateVisitorId = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 20);

const VISITOR_COOKIE = "adloop_vid";
// سنتان - أطول من أي نافذة إسناد نستخدمها (٩٠ يوم)، فالكوكي مش هو القيد
const VISITOR_COOKIE_MAX_AGE = 60 * 60 * 24 * 730;

// أي باراميتر من دول يتحدد بيه المنصة تلقائياً - أول واحد موجود في
// الرابط بيكسب، عشان مفيش رابط هيحتوي أكتر من واحد فعلياً في نفس الوقت
const CLICK_ID_PARAMS: Array<{ param: string; platform: string }> = [
  { param: "gclid", platform: "GOOGLE_ADS" },
  { param: "fbclid", platform: "META_ADS" },
  { param: "ttclid", platform: "TIKTOK_ADS" },
  { param: "sc_click_id", platform: "SNAPCHAT_ADS" },
];

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);

  let clickId: string | null = null;
  let platform: string | null = null;

  for (const { param, platform: p } of CLICK_ID_PARAMS) {
    const value = searchParams.get(param);
    if (value) {
      clickId = value;
      platform = p;
      break;
    }
  }

  // `ws` هو المعرّف الوحيد المطلوب. `client` مقبول كمرادف قديم حتى لا
  // تنكسر روابط إعلانات تعمل بالفعل، لكنه لم يعد يعني سلاجاً بل معرّف
  // مساحة عمل أيضاً.
  const workspaceId = searchParams.get("ws") ?? searchParams.get("client");
  const campaignId = searchParams.get("campaign") ?? undefined;

  // رقم الواتساب من إعدادات المساحة لا من الرابط: كتابته في كلّ إعلان
  // كانت تعني أنّ تغيير الرقم يتطلّب تعديل كلّ إعلان قائم. يبقى
  // `phone` مقبولاً كتجاوز صريح لمن يريد رقماً مختلفاً لحملة بعينها.
  const tenant = workspaceId ? await tenantByWorkspaceId(workspaceId).catch(() => null) : null;
  const businessPhone = searchParams.get("phone") ?? tenant?.businessPhone ?? null;
  const clientId = tenant?.workspaceId ?? null;

  // بتتملى بس لو صاحب الحساب ضاف {{site_source_name}} في حقل "URL
  // Parameters" بتاع الإعلان في Meta Ads Manager - ميتا بتستبدلها بالقيمة
  // الحقيقية (facebook/instagram/audience_network/messenger) وقت الكليك
  // الفعلي. من غيرها، مش هنعرف المكان الأصلي للكليك خالص (موثّق في
  // activation-checklist.md قسم 4ج)
  const siteSourceName = searchParams.get("site_source_name") ?? undefined;

  // لو الكليك جاي من غير أي معرف كليك معروف (مثلاً حد فتح الرابط يدوي)،
  // أو المساحة غير معروفة أو بلا رقم واتساب مضبوط - نحوّله للواتساب عادي
  // من غير تتبّع. الزائر لا يجوز أن يقع في صفحة خطأ بسبب إعداد ناقص.
  if (!clickId || !platform || !clientId || !businessPhone) {
    return NextResponse.redirect(
      businessPhone ? `https://wa.me/${businessPhone}` : "https://wa.me/"
    );
  }

  const code = generateCode();

  // معرف الزائر الثابت: نقرأه لو الزائر جه قبل كده، وننشئه لو أول مرة.
  // ده بالظبط اللي بيحوّل "كليكات منفصلة" لـ"رحلة عميل واحدة" - من غيره
  // مفيش أي نموذج إسناد غير آخر لمسة يقدر يشتغل.
  const existingVisitorId = req.cookies.get(VISITOR_COOKIE)?.value;
  const visitorId = existingVisitorId ?? generateVisitorId();

  // بنمسك الـ IP من الـ headers - x-forwarded-for بيبقى موجود لو المشروع خلف
  // proxy زي Vercel (وده الوضع العادي في الإنتاج)
  const ipAddress =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    null;
  // طبقة كشف تانية - الـUser-Agent بييجي مجاناً مع أي طلب، مفيش سكريبت
  // تتبع إضافي محتاج نضيفه على صفحة الهبوط
  const userAgent = req.headers.get("user-agent") ?? null;

  await saveClick({
    code,
    gclid: clickId,
    platform,
    site_source_name: siteSourceName,
    client_id: clientId,
    campaign_id: campaignId,
    ip_address: ipAddress ?? undefined,
    visitor_id: visitorId,
    user_agent: userAgent ?? undefined,
  });

  // بنبعت الكليك ده لمحرك الإسناد في adloop-saas - يبقى "مرشح" جاهز لو
  // العميل بعت واتساب بعدين من غير الكود (مسح النص الجاهز مثلاً)
  syncClickToAttribution({
    clientId,
    platform,
    code,
    gclid: clickId,
    ipAddress: ipAddress ?? undefined,
    userAgent: userAgent ?? undefined,
    clickedAt: new Date(),
  });

  // نفس الكليك بيتسجّل كمان كـ"لمسة" في طبقة الإسناد متعدد اللمسات.
  // مش تكرار: النداء اللي فوق بيسجّله كـ"مرشّح" لمطابقة محادثة واحدة،
  // وده بيسجّله كخطوة في رحلة الزائر الكاملة. الاتنين بيجاوبوا سؤالين
  // مختلفين وبيشتغلوا مع بعض.
  recordTouchpoint({
    clientId,
    visitorId,
    kind: "AD_CLICK",
    platform,
    campaignId,
    clickId,
    // مصدر ميتا التفصيلي لما يكون متاح - نفس القيمة اللي بتفرّق
    // فيسبوك عن إنستجرام
    source: siteSourceName,
    referrer: req.headers.get("referer") ?? undefined,
    landingPath: "/api/track-click",
    occurredAt: new Date(),
  });

  // نص الرسالة الجاهزة اللي هتتفتح في واتساب، والكود متضمن فيها بشكل طبيعي
  const message = `مرحباً، أنا مهتم بمعرفة المزيد عن خدماتكم. (Ref: ${code})`;

  const waLink = `https://wa.me/${businessPhone}?text=${encodeURIComponent(
    message
  )}`;

  const response = NextResponse.redirect(waLink);

  // الكوكي بيتكتب على رد التحويل نفسه - المتصفح بيحفظه قبل ما يروح
  // لواتساب، فالزيارة الجاية من نفس الجهاز تتربط بدي تلقائياً.
  // كوكي طرف أول: مش بيتأثر بحظر كوكيز الطرف التالت ولا بقيود iOS.
  response.cookies.set(VISITOR_COOKIE, visitorId, {
    maxAge: VISITOR_COOKIE_MAX_AGE,
    httpOnly: true, // مفيش جافاسكريبت محتاجه - إقفاله بيمنع سرقته بـXSS
    sameSite: "lax", // lax مش strict: الزائر جاي من دومين إعلاني خارجي
    secure: process.env.NODE_ENV === "production",
    path: "/",
  });

  return response;
}
