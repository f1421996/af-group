# النسخ الاحتياطي

- بيشتغل كل يوم الساعة 12 بالليل بتوقيت القاهرة، من GitHub Actions (`.github/workflows/backup.yml`).
- بياخد نسخة كاملة من القاعدة (`public` + `auth` يعني الجداول والمستخدمين) ويتأكد إنها سليمة.
- النسخة بتتحفظ 60 يوم في: Actions ← آخر تشغيل ← Artifacts.
- لو فشل، GitHub بيبعتلك إيميل.
- أول مرة: لازم تضيف Secret اسمه `SUPABASE_DB_URL` (شوف الخطوات في الرد).

## الاسترجاع (لو حصلت كارثة)
حمّل ملف `.dump` من Artifacts وفكه، وبعدين على مشروع Supabase جديد فاضي:

    pg_restore --no-owner --no-privileges --clean --if-exists -d "<رابط الاتصال>" af-backup-XXXX.dump

جرّب الاسترجاع على مشروع تجريبي الأول، مش على الأساسي.
