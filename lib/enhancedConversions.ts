// lib/enhancedConversions.ts
//
// "Enhanced Conversions for Leads" - بيانات العميل الأولى (رقم الهاتف
// في حالتنا، واتساب) مشفّرة بـ SHA-256 بترفع مع كل تحويل، بتحسّن دقة
// المطابقة عند جوجل بشكل حقيقي (مش تحسين تجميلي - مؤكد من التوثيق الرسمي
// وقائمة تحقق جوجل الخاصة بالتطبيق الصحيح).
//
// قواعد التطبيع دقيقة جداً ولازم تتبع بالحرف، وإلا التطابق بيفشل بصمت:
// - البريد: أحرف صغيرة، إزالة المسافات، ولـ gmail/googlemail تحديداً:
//   إزالة النقاط قبل @ وإزالة أي "+لاحقة" (plus addressing)
// - الهاتف: صيغة E.164 (كود دولة + رقم، بادئة +، بدون فراغات أو رموز)

import crypto from "crypto";

export function normalizeAndHashEmail(rawEmail: string): string {
  let email = rawEmail.trim().toLowerCase();

  const [localPart, domain] = email.split("@");
  if (domain === "gmail.com" || domain === "googlemail.com") {
    // إزالة النقاط قبل @ وأي حاجة بعد + (Plus Addressing) - خاص بـ Gmail
    // بس، مش قاعدة عامة لكل مزودي البريد - جوجل بتوضح ده صراحة في التوثيق
    const withoutPlus = localPart.split("+")[0];
    const withoutDots = withoutPlus.replace(/\./g, "");
    email = `${withoutDots}@${domain}`;
  }

  return sha256(email);
}

// بيتوقع رقم مُطبّع لصيغة E.164 مسبقاً (كود دولة + بادئة +) - التشفير
// بس هنا، مش التطبيع
export function hashPhoneE164(normalizedPhone: string): string {
  // فحص أمان بسيط: نتأكد إن الرقم فعلاً بصيغة E.164 قبل التشفير - رقم
  // مش مُطبّع صح هيفشل التطابق عند جوجل بصمت من غير أي تحذير
  if (!/^\+[1-9]\d{6,14}$/.test(normalizedPhone)) {
    throw new Error(`رقم الهاتف مش بصيغة E.164 صحيحة: ${normalizedPhone}`);
  }
  return sha256(normalizedPhone);
}

// أرقام واتساب بترجع من الـ webhook بكود الدولة لكن من غير علامة + (زي
// ما هي في توثيق ميتا الرسمي) - هنا بس بنضيف الـ + الناقصة، مش بنخمّن
// كود دولة من الأصل لأنه أصلاً موجود جوه الرقم
export function normalizeWhatsappPhoneToE164(waPhone: string): string {
  const digitsOnly = waPhone.replace(/[^0-9]/g, "");
  return `+${digitsOnly}`;
}

function sha256(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}
