# WhatsApp → Google Ads Conversion Tracker (Proof of Concept)

نسخة مبسطة من فكرة WCI بتاعة جوجل، مبنية بـ Next.js عشان تكون سهلة عليك تشغلها وتطورها.

## الفكرة في 3 خطوات

1. **`app/api/track-click`** — الرابط اللي بيتحط في إعلان Google Ads بدل رابط الواتساب.
   بيمسك الـ `gclid`، يولّد كود قصير، يخزنه، ويحوّل المستخدم لواتساب برسالة فيها الكود.

2. **`app/api/whatsapp-webhook`** — بيستقبل أي رسالة واتساب واردة، يدور على الكود
   جوه نص الرسالة، ويربطه بالـ `gclid` المخزن.

3. **`lib/googleAds.ts`** — لما يحصل الربط، بيبعت "offline conversion" لجوجل
   عن طريق الـ Google Ads API، فيديك رقم حقيقي لعدد المحادثات الفعلية.

## خطوات التشغيل

### 1. تثبيت الحزم
```bash
npm install
```

### 2. نسخ ملف البيئة
```bash
cp .env.example .env.local
```
وتعبي القيم (شرح كل واحدة في الأسفل).

### 3. تشغيل محلي للتجربة
```bash
npm run dev
```

### 4. رفعه على استضافة (Vercel مثلاً، زي مشاريعك التانية)
لازم يكون على دومين حقيقي (https) عشان Meta تقدر توصله وقت التحقق من الـ webhook.

## إعداد WhatsApp Business Platform

1. روح لـ Meta for Developers → أنشئ WhatsApp Business App
2. من إعدادات الـ Webhook، حط:
   - Callback URL: `https://yourdomain.com/api/whatsapp-webhook`
   - Verify Token: نفس القيمة اللي حطيتها في `WHATSAPP_VERIFY_TOKEN`
3. اشترك (Subscribe) في حدث `messages`

## إعداد Google Ads API

1. اطلب Developer Token من [API Center](https://ads.google.com/aw/apicenter)
2. اعمل OAuth2 credentials (Client ID + Secret) من Google Cloud Console
3. اطلع Refresh Token (فيه أدوات جاهزة زي [OAuth2 Playground](https://developers.google.com/oauthplayground))
4. جهّز "Conversion Action" في حساب Google Ads بالاسم اللي هتستخدمه في الكود
   (Tools → Conversions → New conversion action → Import → Offline)

## رابط الإعلان اللي هتحطه في Google Ads

بدل ما تحط رابط واتساب مباشر، حط:
```
https://yourdomain.com/api/track-click?gclid={gclid}&ws=<workspace-id>
```
`{gclid}` هي value track parameter، جوجل بتعوضها تلقائي وقت الكليك.

`ws` هو معرّف مساحة العمل في AdLoop، والمشترك بيلاقيه جاهز في صفحة وسم
التتبّع عنده. **الصيغة القديمة (`client=<slug>&phone=...`) اتشالت** -
كانت بتقرا من خريطة عملاء مكتوبة في الكود، يعني كل مشترك جديد محتاج
تعديل ونشر. دلوقتي المساحة بتتقري من قاعدة البيانات، ورقم الواتساب
بييجي من إعدادات المساحة نفسها فمش المعلن اللي بيكتبه في الرابط.

## ملاحظات مهمة قبل الإنتاج الفعلي

- **SQLite للتجربة بس.** لو هتشغلها على Vercel أو أي منصة serverless، لازم تنقل
  لقاعدة بيانات حقيقية زي Postgres (Supabase / Neon) لأن SQLite مش بتتحمل
  الكتابة المتزامنة على السيرفرات دي.
- **تأمين الـ webhook**: لازم تتحقق من توقيع الطلب الجاي من Meta (X-Hub-Signature-256)
  قبل ما تعتبره موثوق — مش متضمن في النسخة دي عشان تفضل بسيطة للتجربة الأولى.
- **معالجة الأخطاء وإعادة المحاولة**: لو فشل إرسال الـ conversion لجوجل، محتاج
  queue بسيطة (زي BullMQ أو حتى cron يعيد المحاولة) بدل ما تفقد البيانات.
