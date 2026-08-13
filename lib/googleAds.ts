// lib/googleAds.ts
//
// مسؤول عن إرسال الـ offline conversion لجوجل بعد ما نتأكد إن فيه رسالة واتساب
// حقيقية اترسلت. بيستخدم مكتبة google-ads-api (غير رسمية لكن الأكثر استخداماً
// وموثقة كويس: https://github.com/Opteo/google-ads-api).
//
// لازم تجهز الحاجات دي الأول من Google Ads API Center:
// - Developer token
// - OAuth2 client id / secret / refresh token (لحساب الـ Manager أو الحساب مباشرة)
// أمّا Customer ID فلكلّ مشترك على حدة، ويُقرأ من `Workspace.googleAdsCustomerId`
// عبر `tenantByWorkspaceId` - لا من متغيّر بيئة باسم عميل، وإلّا لاحتاج كلّ
// مشترك جديد نشراً جديداً للمنصّة كلّها.

import { GoogleAdsApi, enums, services } from "google-ads-api";
import { hashPhoneE164, normalizeWhatsappPhoneToE164 } from "./enhancedConversions";
import { tenantByWorkspaceId } from "@/lib/tenants";

const client = new GoogleAdsApi({
  client_id: process.env.GOOGLE_ADS_CLIENT_ID!,
  client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET!,
  developer_token: process.env.GOOGLE_ADS_DEVELOPER_TOKEN!,
});

export async function sendOfflineConversion(params: {
  gclid: string;
  conversionAction: string;
  clientId: string;
  waPhone?: string; // رقم واتساب اللي بعت الرسالة - لو موجود، بيترفع كـ Enhanced Conversion مشفّر
}) {
  // حساب جوجل يُقرأ من إعدادات مساحة العمل، لا من متغيّر بيئة باسم
  // العميل: ذاك كان يجعل كلّ مشترك جديد يحتاج نشراً.
  const tenant = await tenantByWorkspaceId(params.clientId).catch(() => null);
  const customerId = tenant?.googleAdsCustomerId;
  if (!customerId) {
    console.error(
      `لا يوجد حساب Google Ads مضبوط لمساحة العمل ${params.clientId} - تُخطّى عملية رفع التحويل.`
    );
    return;
  }

  const customer = client.Customer({
    customer_id: customerId,
    refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN!,
  });

  // Enhanced Conversions for Leads - بيانات أولى مشفّرة تحسّن دقة المطابقة
  // فعلياً (مؤكد من توثيق جوجل)، مش تحسين شكلي. أي خطأ تطبيع (زي رقم مش
  // بصيغة E.164) بنمسكه هنا ونكمل بدونها بدل ما نوقف التحويل الأساسي كله
  let userIdentifiers: any[] = [];
  if (params.waPhone) {
    try {
      const e164Phone = normalizeWhatsappPhoneToE164(params.waPhone);
      const hashedPhone = hashPhoneE164(e164Phone);
      userIdentifiers = [
        {
          hashed_phone_number: hashedPhone,
          user_identifier_source: enums.UserIdentifierSource.FIRST_PARTY,
        },
      ];
    } catch (err) {
      console.error("فشل تطبيع/تشفير رقم الهاتف لـ Enhanced Conversions - هتترفع التحويلة من غيرها:", err);
    }
  }

  try {
    const request = new services.UploadClickConversionsRequest({
      customer_id: customerId,
      conversions: [
        {
          gclid: params.gclid,
          conversion_action: params.conversionAction, // resource name للـ conversion action
          conversion_date_time: formatGoogleAdsDate(new Date()),
          // user_identifiers فاضية = تحويل عادي، متعبّية = Enhanced Conversion
          user_identifiers: userIdentifiers,
        },
      ],
      partial_failure: true,
      validate_only: false, // false = إرسال فعلي. true بيتستخدم بس للتجربة من غير إرسال حقيقي
    });

    await customer.conversionUploads.uploadClickConversions(request);
    console.log(`تم إرسال conversion بنجاح للعميل ${params.clientId}${userIdentifiers.length > 0 ? " (مع Enhanced Conversions)" : ""}`);
  } catch (err) {
    console.error("فشل إرسال الـ conversion لجوجل:", err);
  }
}

// جوجل بتحتاج التاريخ بصيغة معينة: "yyyy-MM-dd HH:mm:ss+00:00"
function formatGoogleAdsDate(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ") + "+00:00";
}
