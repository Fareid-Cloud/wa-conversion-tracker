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

## رابط الإعلان اللي هتحطه في الإعلان

> ⚠️ **متكتبش الرابط بإيدك من هنا.** المشترك بيلاقيه مولَّد جاهز وصحيح
> لكل منصّة في **الإعدادات ← وسم التتبّع** جوّه AdLoop. النسخة اللي تحت
> للتوثيق وللفهم بس - والصيغة بتختلف بين المنصّات.

```
# جوجل - محتاجة ماكرو الحملة **وماكرو النقرة** صراحةً
https://yourdomain.com/api/track-click?ws=<workspace-id>&campaign={campaignid}&gclid={gclid}

# ميتا - بتلحق fbclid لوحدها، فماكرو الحملة بس
https://yourdomain.com/api/track-click?ws=<workspace-id>&campaign={{campaign.id}}

# تيك توك
https://yourdomain.com/api/track-click?ws=<workspace-id>&campaign=__CAMPAIGN_ID__
```

🔴 **`campaign` مش اختياري.** الصيغة القديمة هنا كانت `?gclid={gclid}&ws=...`
من غيره - والنتيجة إنّ التحقّق يوصل `mark-matched` بـ`campaignId = undefined`
**فيُسقَط بالكامل**: الرسالة بتتطابق فعلاً، والعميل حقيقي، وعمود «الرقم
المتحقَّق» - اللي هو دعوى المنتج كلّها - يفضل صفر ومحدش يعرف ليه. وماكرو
الحملة مالوش صيغة موحّدة بين المنصّات ومابيتلحقش تلقائياً زي معرّف النقرة،
فلازم يتكتب صراحةً في كل منصّة بصيغتها.

`ws` هو معرّف مساحة العمل في AdLoop، والمشترك بيلاقيه جاهز في صفحة وسم
التتبّع عنده. **الصيغة القديمة (`client=<slug>&phone=...`) اتشالت** -
كانت بتقرا من خريطة عملاء مكتوبة في الكود، يعني كل مشترك جديد محتاج
تعديل ونشر. دلوقتي المساحة بتتقري من قاعدة البيانات، ورقم الواتساب
بييجي من إعدادات المساحة نفسها فمش المعلن اللي بيكتبه في الرابط.

## ملاحظات مهمة قبل الإنتاج الفعلي

- ✅ **Postgres، مش SQLite.** الملاحظة القديمة هنا كانت بتقول SQLite للتجربة
  بس - ده اتغيّر: `lib/db.ts` بيشتغل على Postgres عبر `pg`، و`DATABASE_URL`
  **بنفس قيمة مشروع adloop-saas** (قاعدة واحدة مشتركة). وعشان كده جدول
  `wa_clicks` معلَن كموديل `WaClick` في مخطّط Prisma هناك: من غير الإعلان،
  كل `db push` كان بيمسحه.
- ✅ **تأمين الـ webhook متضمَّن.** الملاحظة القديمة كانت بتقول إنّه مش
  متضمّن - ده مابقاش صحيح: `verifyMetaSignature` بتتحقق من
  `X-Hub-Signature-256` بـ`timingSafeEqual`، وبتفشل مقفولة (غياب التوقيع
  أو غياب `WHATSAPP_APP_SECRET` = رفض 403، مش تمرير).
- ⚠️ **إعادة المحاولة لسه ناقصة.** النداءات على محرك الإسناد بقت بتتسلّم
  لـ`after()` فمابتضيعش لمّا الرد يمشي (كانت `void` سايبة والـruntime
  بيتقفل عليها)، لكن ده بيضمن **المحاولة** مش النجاح: لو adloop ردّت خطأ أو
  عدّت المهلة، النداء بيتسجّل في اللوج وبيروح. صندوق صادر (outbox) بإعادة
  محاولة لسه مبنيّاش.
