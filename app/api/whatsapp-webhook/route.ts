// app/api/whatsapp-webhook/route.ts
//
// ده الـ webhook اللي هتسجله في إعدادات WhatsApp Business Platform (Meta).
// الرابط اللي هتحطه في Meta: https://yourdomain.com/api/whatsapp-webhook
//
// خطوتين مطلوبين من Meta:
// 1) GET: للتحقق من الـ webhook وقت الإعداد (verification)
// 2) POST: بتوصلك فيها الرسائل الحقيقية لحظة بلحظة
//
// أمان: ميتا بتوقّع كل طلب POST بـ HMAC-SHA256 على الـ body الخام، في هيدر
// X-Hub-Signature-256. من غير التحقق ده، أي حد يعرف الرابط يقدر يبعت
// رسائل واتساب وهمية تتسجل كـ "verified conversion" حقيقية - وده بالظبط
// يضرب مصداقية البيانات اللي المنتج كله مبني عليها.

import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { findClickByCode, markMatched, markSentToGoogle } from "@/lib/db";
import { tenantByPhoneNumberId } from "@/lib/tenants";
import { sendOfflineConversion } from "@/lib/googleAds";
import {
  markMatchedInAttribution,
  processUnattributedConversation,
  recordTouchpoint,
  recordConversion,
} from "@/lib/attributionSync";

// رقم واتساب المستقبل (`phone_number_id` من ميتا) هو الهويّة الوحيدة
// المتاحة حين لا تحمل الرسالة كود Ref - فلا شيء آخر يدلّنا على صاحبها.
// كان يُترجَم عبر خريطة عملاء مكتوبة في الكود؛ صار يُقرأ من قاعدة
// البيانات عبر `tenantByPhoneNumberId`، فيعمل لأيّ مشترك دون تعديل كود.

function verifyMetaSignature(rawBody: string, signatureHeader: string | null): boolean {
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (!signatureHeader || !appSecret) return false;

  const receivedHash = signatureHeader.replace("sha256=", "");
  const computedHash = crypto
    .createHmac("sha256", appSecret)
    .update(rawBody)
    .digest("hex");

  if (computedHash.length !== receivedHash.length) return false;

  return crypto.timingSafeEqual(
    Buffer.from(computedHash),
    Buffer.from(receivedHash)
  );
}

// ==== 1) التحقق من الـ Webhook (بتعمله Meta مرة واحدة وقت الربط) ====
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return new NextResponse(challenge, { status: 200 });
  }
  return new NextResponse("Forbidden", { status: 403 });
}

// ==== 2) استقبال الرسائل الحقيقية ====
export async function POST(req: NextRequest) {
  // لازم ناخد الـ body كنص خام قبل أي تحليل - نفس مبدأ webhook سلة بالظبط
  const rawBody = await req.text();

  const signature = req.headers.get("x-hub-signature-256");
  if (!verifyMetaSignature(rawBody, signature)) {
    console.warn("توقيع Meta غير صحيح - الطلب مرفوض");
    return new NextResponse("Forbidden", { status: 403 });
  }

  const body = JSON.parse(rawBody);

  // 🔴 **كانت الرسالة الأولى وحدها تُعالَج، والباقي يُبتلع بردّ 200.**
  //
  // ميتا تُجمّع: `entry` مصفوفة، و`changes` مصفوفة، و`messages` مصفوفة -
  // وتحت أيّ حِمل تصل عدّةُ رسائل في التسليم الواحد. وكلُّ رسالةٍ بعد
  // الأولى كانت تُفقد نهائياً: تحويلٌ متحقَّقٌ لا يصل إلى الأرقام، ولا
  // خطأ في أيّ سجلّ لأنّ الردّ 200 يُقنع ميتا أنّ التسليم نجح.
  //
  // وهذا في قلب دعوى المنتج: التحقّق من التحويل. تُقرأ كلُّ الرسائل الآن،
  // وكلٌّ منها في `try` خاصّ بها - رسالةٌ تفشل لا تُسقط أخواتها معها،
  // وهو ما كان يحدث حتى لو عولجت الدفعةُ كلُّها في `try` واحد.
  try {
    let processed = 0;
    for (const entry of body.entry ?? []) {
      for (const change of entry?.changes ?? []) {
        const value = change?.value;
        for (const message of value?.messages ?? []) {
          try {
            await handleMessage(value, message);
            processed++;
          } catch (err) {
            // معرّفُ الرسالة يُطبَع: بلا معرّفٍ لا تُعاد معالجةُ ما فشل يدوياً
            console.error("Webhook message failed:", message?.id, err);
          }
        }
      }
    }

    if (processed === 0) {
      // إشعارات status (delivered/read) بتوصل هنا كمان، بنتجاهلها
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ ok: true, processed });
  } catch (err) {
    console.error("Webhook error:", err);
    // نرجع 200 دايماً لـ Meta حتى لو حصل خطأ داخلي، عشان متوقفش إعادة المحاولة اللانهائية
    return NextResponse.json({ ok: true });
  }
}

/** معالجةُ رسالةٍ واحدة - مستخرَجةٌ كي تُنادى لكلّ رسالةٍ في الدفعة. */
async function handleMessage(value: any, message: any) {
  {
    const text: string = message.text?.body ?? "";
    const fromPhone: string = message.from ?? "";

    // بندور على الكود بالشكل: Ref: XXXXXX
    const match = text.match(/Ref:\s*([A-Z0-9]{6})/i);

    if (match) {
      const code = match[1].toUpperCase();
      const click = await findClickByCode(code);

      if (click && !click.matched) {
        await markMatched(code, fromPhone);

        // إسناد مؤكد 100% - الكود نفسه هو الدليل، مفيش داعي لمحرك التوزيع الاحتمالي
        markMatchedInAttribution({
          clientId: click.client_id,
          code,
          conversationId: message.id,
          receivedAt: new Date(),
          platform: click.platform,
          campaignId: click.campaign_id ?? undefined,
        });

        // الرفع الآلي رجوعاً للمنصة نفسها (Offline Conversion) لسه مبني
        // لجوجل بس - لو الكليك جاي من منصة تانية، بنسجله كـ"متحقق" في
        // نظامنا احنا (وده الأهم لحساب verifiedConversions)، لكن مبنحاولش
        // نرفعه لمنصة معندهاش دالة رفع مبنية ليها لسه (كان ده هيحصل غلط
        // لو حاولنا - إرسال fbclid/ttclid لدالة مصممة لـ gclid بس)
        if (click.platform === "GOOGLE_ADS") {
          await sendOfflineConversion({
            gclid: click.gclid,
            conversionAction: "conversation_started", // اسم الـ conversion action في حسابك
            clientId: click.client_id,
            waPhone: fromPhone, // بيترفع كـ Enhanced Conversion مشفّر - بيحسّن دقة المطابقة فعلياً
          });
          await markSentToGoogle(code);
        }

        // ✅ ده اللي بيقفل الـTODO القديم (sendMetaConversion/sendTikTokConversion).
        // القرار المعماري: بدل ما نبني دالة رفع منفصلة لكل منصة هنا، بنسجّل
        // الحدث مرة واحدة في adloop-saas وهو بيرفعه للتلاتة من مكان واحد
        // (lib/conversionSync.ts). كده أي منصة جديدة بتتضاف في ملف واحد بدل
        // ما تتكرر في المشروعين، والرفع بيمرّ على فحص جودة المطابقة الأول
        // فمنستهلكش حصة المنصة على أحداث مش هتتربط بحد أصلاً.
        recordConversion({
          clientId: click.client_id,
          externalId: message.id, // معرف الرسالة نفسه - يمنع الازدواج لو الويب هوك اتكرر
          eventName: "Lead",
          visitorId: click.visitor_id ?? undefined,
          phone: fromPhone,
          verified: true, // رسالة واتساب حقيقية بكود مطابق - أقوى دليل تحقق عندنا
          gclid: click.platform === "GOOGLE_ADS" ? click.gclid : undefined,
          fbclid: click.platform === "META_ADS" ? click.gclid : undefined,
          ttclid: click.platform === "TIKTOK_ADS" ? click.gclid : undefined,
          ipAddress: click.ip_address ?? undefined,
          userAgent: click.user_agent ?? undefined,
          occurredAt: new Date(),
          // 🔴 محادثة واتساب مش زيارة موقع: الحدث اللي بيترفع لميتا بـ
          // `action_source: "website"` بيتقبل **ومبيتنسبش للإعلان** خالص،
          // فالخوارزمية مبتتعلّمش منه. المصدر الصح بيتحدّد من `sourceKind`،
          // و`ctwa_clid` اللي ميتا بتبعته في `referral` على أول رسالة هو
          // الرابط الوحيد بين المحادثة والإعلان اللي جابها.
          sourceKind: "whatsapp",
          ctwaClid: message.referral?.ctwa_clid ?? undefined,
        });

        // الرسالة نفسها لمسة أخيرة في الرحلة - من غيرها المسار بيقف عند
        // الكليك، فتبان الرحلة كأنها انتهت قبل التحويل
        if (click.visitor_id) {
          recordTouchpoint({
            clientId: click.client_id,
            visitorId: click.visitor_id,
            kind: "MESSAGE",
            platform: click.platform,
            campaignId: click.campaign_id ?? undefined,
            occurredAt: new Date(),
          });
        }
      }
    } else {
      // مفيش كود Ref خالص - بدل ما نتجاهل الرسالة دي زي ما كان بيحصل قبل
      // كده، بنبعتها لمحرك التوزيع الاحتمالي. لو مقدرناش نحدد العميل من
      // رقم واتساب البيزنس المستقبل، بنتخطاها بهدوء (مش خطأ، بس مش قادرين نعالجها)
      const phoneNumberId = value?.metadata?.phone_number_id;
      const tenant = phoneNumberId
        ? await tenantByPhoneNumberId(phoneNumberId).catch(() => null)
        : null;

      if (tenant) {
        await processUnattributedConversation({
          clientId: tenant.workspaceId,
          conversationId: message.id,
          receivedAt: new Date(),
          phoneNumber: fromPhone,
        });
      }
    }
  }
}
