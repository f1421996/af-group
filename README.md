# AF Group

نظام الفواتير والمخزون والتصنيع لمجموعة الفارس (OL / EB / MG / RD / DN).

- الواجهة: ملف واحد `index.html` + `sw.js` (PWA).
- قاعدة البيانات: Supabase (مشروع `vgpqaubvshnwpryhkoil`).
- النشر: Vercel (مشروع `af`)، دومين `af-bay-eta.vercel.app`.

## ملفات النشر
كل الملفات في الجذر لازم تتنشر مع بعض: `index.html`, `sw.js`, `supabase-2.45.4.js`,
`manifest.json`, `vercel.json`, الأيقونات.

## تغييرات
- v85: هيدر موبايل مضغوط، تنقل سفلي لحسابات stock/maker، manifest وأيقونات،
  headers أمان، خطوط أخف، مكتبة supabase ذاتية الاستضافة.
