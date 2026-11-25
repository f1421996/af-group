// AF Group assistant (v91) — Haiku 5.5 for lookups, Sonnet 5.5 for plans/advice (daily cap), daily limit + monthly $ cap.
// v91: + tier_prices (quantity tiers) and reorder_list (reorder point) tools.
// v92: page accounts get Sonnet for full-list and suggestion questions (own daily cap).
// v93: + tell_owner (staff can pass a short message to the owner).
// v94: + draft_invoice_new (invoice draft for a customer who is not in the system yet).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const MODEL = "claude-haiku-5-5";
const MODEL_S = "claude-sonnet-5-5";
const ADVICE = /(اقترح|اقتراح|خط[ةه]|ابد[أا]|أبد[أا]|ازاي|إزاي|تكنيك|طريق[ةه]|حلل|تحليل|نصيح|افكار|أفكار|فكر[ةه]|ازود|أزود|احسن|أحسن|انظم|أنظم|ترتيب|رتب|أسرع|اسرع|اخلص|أخلص)/;
// Full-list questions ("everything the customer never bought") need a model that will print the whole list.
const LISTQ = /(كل ال[اأ]صناف|القايم[ةه] (كلها|كامل[ةه])|كامل[ةه]|ماخد|مخد|مش بياخد|ماجرب|مجرب|ما اشتر)/;
const PAGE_SONNET_DAILY = 5;
const MAX_ROUNDS = 5;
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_ENV = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const RAW_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? Deno.env.get("api") ?? "";
const API_KEY = (RAW_KEY.match(/sk-ant-[A-Za-z0-9_\-]+/) ?? [""])[0];
const redact = (x: unknown) => String(x).replace(/sk-ant-[A-Za-z0-9_\-]+/g, "sk-ant-***");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

// Tier names differ per page (same lists as the price-list screen).
const TIERN: Record<string, string[]> = {
  ol: ["أسعار القائمة", "الشريحة الفضية", "الشريحة الذهبية", "الشريحة البلاتينية", "شريحة كبار التجار"],
  eb: ["الأسعار الأساسية", "فئة A", "فئة B", "فئة C", "فئة D"],
  dn: ["La Collection", "Bronze", "Silver", "Gold", "Elite"],
  mg: ["السعر الأساسي", "جملة 1", "جملة 2", "جملة 3", "جملة 4"],
  rd: ["من 12 قطعة", "من 50 قطعة", "من 150 قطعة", "من 300 قطعة", "من 600 قطعة"],
};

type Tool = { name: string; description: string; input_schema: Record<string, unknown>; rpc: string; args: (i: any) => Record<string, unknown>; roles?: string[]; max?: number };
const D = { type: "string", description: "YYYY-MM-DD" };
const TOOLS: Tool[] = [
  { name: "my_work", rpc: "ag_my_work",
    description: "The CURRENT user's own production: lines/pieces they marked done, by day, top items, last items, delivered. Default range = last 7 days. Max 92 days. Cannot show other people.",
    input_schema: { type: "object", properties: { from: D, to: D } },
    args: (i) => ({ p_from: i.from ?? null, p_to: i.to ?? null }) },
  { name: "product_stock", rpc: "ag_product",
    description: "Look up a product or oil by name, alias, F-number (e.g. F200) or Z-number (e.g. Z155): empty-bottle stock (on_shelf, reserved for open orders, free), oil grams in stock vs needed, default grams per piece, ready stock, and price if allowed.",
    input_schema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
    args: (i) => ({ p_q: String(i.q ?? "") }) },
  { name: "customer_product", rpc: "ag_customer_product",
    description: "For a customer + ONE product: the concentration (grams) to use, special price vs page price (if allowed), and the last time it was sold to them (never_bought=true if never).",
    input_schema: { type: "object", properties: { customer: { type: "string" }, product: { type: "string" } }, required: ["customer", "product"] },
    args: (i) => ({ p_customer: String(i.customer ?? ""), p_product: String(i.product ?? "") }) },
  { name: "customer_history", rpc: "ag_customer_history", roles: ["owner", "billing", "page"],
    description: "A customer's recent invoices, days since last order and their TOP 12 usual items only (not the full list). For the full list of everything they bought or never bought use customer_products.",
    input_schema: { type: "object", properties: { customer: { type: "string" } }, required: ["customer"] },
    args: (i) => ({ p_customer: String(i.customer ?? "") }) },
  { name: "customer_products", rpc: "ag_customer_products", roles: ["owner", "billing", "page"], max: 16000,
    description: "FULL product lists for one customer: bought = every product they ever bought (pcs, times, last date, last price) sorted by most pieces; not_bought = every product priced on their page that they NEVER bought, sorted by best sellers (last 90 days) with page price. Use for: what does the customer buy most, what haven't they tried, what to offer them. Optional filter narrows not_bought by name/family (e.g. توم فورد, كريد, دايموند).",
    input_schema: { type: "object", properties: { customer: { type: "string" }, filter: { type: "string" } }, required: ["customer"] },
    args: (i) => ({ p_customer: String(i.customer ?? ""), p_filter: i.filter ?? null }) },
  { name: "tier_prices", rpc: "ag_tier_prices", roles: ["owner", "billing", "page"],
    description: "Price of a product in each QUANTITY TIER. The tier is decided by the TOTAL pieces of the whole invoice, not of this one product. Returns the list price, the price in each of the 5 tiers, and each tier's name and quantity range. Use when asked for a price for a given quantity (e.g. سعر سوفاج لو العميل هياخد 300 قطعة), for a tier/شريحة price, or what the customer saves by ordering more. Optional page (ol/eb/mg/rd/dn) is for owner/billing only; a page user always gets their own page.",
    input_schema: { type: "object", properties: { product: { type: "string" }, page: { type: "string" } }, required: ["product"] },
    args: (i) => ({ p_q: String(i.product ?? ""), p_page: i.page ?? null }) },
  { name: "invoice_status", rpc: "ag_invoice",
    description: "Status of one invoice by number (e.g. OL/1093, EB-247, or just 1093): done/remaining/delivered counts, remaining lines with grams, oil, who is working on them and shortages, and done lines with who did them.",
    input_schema: { type: "object", properties: { no: { type: "string" } }, required: ["no"] },
    args: (i) => ({ p_no: String(i.no ?? "") }) },
  { name: "open_orders", rpc: "ag_open_orders",
    description: "Open (not yet closed) invoices in work order with remaining lines/pieces and % done.",
    input_schema: { type: "object", properties: {} }, args: () => ({}) },
  { name: "draft_invoice", rpc: "ag_draft_invoice", roles: ["owner", "billing", "page"],
    description: "Prepare an invoice DRAFT for an existing customer (it is NOT saved; the user saves it with a button). items: product name as the user wrote it, qty, and price = a number if the user gave one, \"last\" if they asked for the last price the customer paid, or omit for the normal price. If the result has issues/choose/did_you_mean, ask the user and call again after they answer.",
    input_schema: { type: "object", properties: {
      customer: { type: "string" },
      items: { type: "array", items: { type: "object", properties: {
        product: { type: "string" }, qty: { type: "number" },
        price: { description: "number, or the string last" },
        said: { type: "string", description: "what the user ORIGINALLY typed for this product, if you replaced it with a name the user picked" } }, required: ["product", "qty"] } },
      customer_said: { type: "string", description: "what the user ORIGINALLY typed for the customer, if it differs from customer" } },
      required: ["customer", "items"] },
    args: (i) => ({ p_customer: String(i.customer ?? ""), p_items: Array.isArray(i.items) ? i.items : [], p_customer_said: i.customer_said ?? null }) },
  { name: "draft_invoice_new", rpc: "ag_draft_invoice_new", roles: ["owner", "billing", "page"],
    description: "Prepare an invoice DRAFT for a NEW customer who is not in the system yet. Nothing is saved: the customer and the invoice are created only when the user presses the save button. Use ONLY after draft_invoice showed the customer does not exist AND the user confirmed this is a new customer. customer = the name; phone and address are optional. items as in draft_invoice (price = a number if the user gave one, or omit for the normal price). page (ol/eb/mg/rd/dn) is needed for owner/billing only; a page user always uses their own page. If the result is customer_exists, tell the user the name that was found and ask.",
    input_schema: { type: "object", properties: {
      customer: { type: "string" }, phone: { type: "string" }, address: { type: "string" }, page: { type: "string" },
      items: { type: "array", items: { type: "object", properties: {
        product: { type: "string" }, qty: { type: "number" }, price: { description: "number, or omit" },
        said: { type: "string", description: "what the user ORIGINALLY typed for this product, if you replaced it with a name the user picked" } }, required: ["product", "qty"] } } },
      required: ["customer", "items"] },
    args: (i) => ({ p_name: String(i.customer ?? ""), p_phone: String(i.phone ?? ""), p_addr: String(i.address ?? ""), p_items: Array.isArray(i.items) ? i.items : [], p_page: i.page ?? null }) },
  { name: "purchase_list", rpc: "ag_purchase_list", roles: ["owner", "billing", "stock", "maker"],
    description: "Shopping list of missing empties/oils for open orders, grouped by supplier (last supplier bought from), with a ready WhatsApp message and link per supplier.",
    input_schema: { type: "object", properties: {} }, args: () => ({}) },
  { name: "reorder_list", rpc: "ag_reorder", roles: ["owner", "stock"],
    description: "What to ORDER NOW by reorder point: how many oils/empties are at or below their reorder point, and per supplier the items to order with suggested quantity and days of cover left, plus orders already on the way. Pass supplier (a name) to get that supplier's full list. Different from purchase_list, which only covers what OPEN ORDERS are short of.",
    input_schema: { type: "object", properties: { supplier: { type: "string" } } },
    args: (i) => ({ p_supplier: i.supplier ?? null }) },
  { name: "tell_owner", rpc: "ag_tell_owner", roles: ["billing", "stock", "maker", "page"],
    description: "Pass a short message from the CURRENT user to فارس (the owner). He gets a notification and sees it in his inbox on the home screen. Use ONLY when the user explicitly asks you to tell, inform or send something to فارس (بلّغ فارس / قول لفارس / ابعتله). Send the user's own words, lightly cleaned, max 500 characters. Never invent or add content. Limit: 5 a day per user.",
    input_schema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
    args: (i) => ({ p_body: String(i.message ?? "") }) },
  { name: "remember_rule", rpc: "ag_add_rule", roles: ["owner"],
    description: "OWNER ONLY: save a standing rule/fact the assistant must follow for everyone from now on (when the owner says افتكر/احفظ/خلي بالك). Save it as one short clear Arabic sentence.",
    input_schema: { type: "object", properties: { rule: { type: "string" } }, required: ["rule"] },
    args: (i) => ({ p_body: String(i.rule ?? "") }) },
  { name: "work_plan", rpc: "ag_work_plan",
    description: "Work plan for production from all open invoices: finish_first (invoices 1-8 lines from closing), batches (same product+grams merged across invoices, ready to make now, in priority order), merge_tips, blocked lines (missing empties/oil) and totals. Optional oil filter.",
    input_schema: { type: "object", properties: { oil: { type: "string" } } },
    args: (i) => ({ p_oil: i.oil ?? null }) },
  { name: "team_work", rpc: "ag_team_work", roles: ["owner"],
    description: "OWNER ONLY: production of all workers (or one worker by name) in a date range. Default last 7 days.",
    input_schema: { type: "object", properties: { from: D, to: D, name: { type: "string" } } },
    args: (i) => ({ p_from: i.from ?? null, p_to: i.to ?? null, p_name: i.name ?? null }) },
];

const ROLE_AR: Record<string, string> = {
  owner: "صاحب الشغل (أدمن)", billing: "حسابات", stock: "مخزن/تجهيز", maker: "عامل تصنيع", page: "مسؤول صفحة بيع",
};

function systemPrompt(q: any, rules: string[] = []) {
  const R = rules.length ? `\n\nقواعد من فارس (التزم بيها دايمًا):\n${rules.map((r) => "- " + r).join("\n")}` : "";
  return `إنت مساعد سيستم «الفارس جروب» للعطور. بترد بالعامية المصرية، مختصر وواضح، بأرقام من الأدوات بس.
اليوم: ${q.today} (توقيت القاهرة). المستخدم: ${q.name} — ${ROLE_AR[q.role] ?? q.role}${q.page_name ? ` — صفحة ${q.page_name}` : ""}.

قواعد:
- أي رقم (رصيد، جرامات، سعر، إنتاج، فاتورة) لازم يجي من أداة. ماتخمنش ولا تحسب من دماغك.
- لو اسم الصنف أو العميل جاب أكتر من نتيجة، اعرض الاختيارات واسأل يقصد أنهي.
- «إنتاجي/اشتغلت/عملت كام» = أداة my_work. إنتاج حد تاني: ممنوع إلا للأدمن (team_work). لو موظف سأل عن إنتاج زميل، قوله بلطف إن ده متاح للإدارة بس.
- التكلفة والربح وأسعار الموردين مش متاحة هنا لأي حد. ماتقولش أرقام مش راجعة من أداة.
- لو أداة رجعت not_allowed أو owner_only: قول إن المعلومة دي مش متاحة لصلاحيته.
- في المخزون: on_shelf = الموجود فعلاً، free_after_orders بالسالب = ناقص للأوردرات. free_g بالسالب = الزيت ناقص.
- السعر: لو فيه special_price قول «سعر خاص» وجنبه سعر الصفحة. لو فيه warning نبّه عليه.
- أسعار الكميات (الشرايح): «سعر الصنف لو هياخد N قطعة / سعر الشريحة / خصم الكمية / السعر هينزل لكام» = أداة tier_prices.
  · الشريحة بتتحدد بإجمالي قطع الفاتورة كلها، مش الصنف لوحده. لو المستخدم قال عدد صنف واحد بس، وضّح إن العبرة بإجمالي الفاتورة.
  · قول سعر القايمة، وسعر الشريحة اللي الكمية واقعة فيها باسمها ونطاقها، وفاضل كام قطعة للشريحة اللي بعدها وسعرها فيها.
  · لو سعر الشريحة = سعر القايمة، قول إن الصنف ده مالوش خصم في الشريحة دي. ماتقولش السبب.
  · لو فيه عميل في السؤال، استخدم customer_product كمان: لو ليه special_price يبقى سعره الخاص هو اللي بيتطبق مش الشريحة.
  · الأسعار للتركيز القياسي. وقوله إن زرار «طبّق أسعار الشريحة» بيظهر في الفاتورة من أول شريحة فيها خصم.
- أسئلة «العميل بياخد إيه أكتر / الأصناف اللي ماخدهاش / اقترح عليه أصناف جديدة / إيه اللي جربه»: استخدم customer_products (مش customer_history). قول العدد الكامل من bought_count و not_bought_count.
  · «بياخد إيه أكتر»: أول 10 من bought بالقطع وعدد المرات.
  · «ماخدش إيه»: اعرض القايمة كلها مهما كان عددها، كل صنف في سطر بسعره، بنفس ترتيب not_bought (الأكتر مبيعًا فوق). ماتختصرش وماتطلبش منه يحدد ماركة.
  · لو هو اللي حدد ماركة أو نوع، ابعت filter.
  · ممنوع تقول إن الأداة مش بتطلع القايمة كاملة.
- أسئلة «أبدأ بإيه / خطة شغلي / أخلّص أكبر إنتاج / أشتغل إزاي»: استخدم work_plan، ورد بخطة مرقّمة:
  1) الفواتير اللي قربت تخلص (finish_first) واللي جاهز منها.
  2) دفعات مجمّعة من batches: «اعمل X قطعة من صنف Y بتركيز Z مرة واحدة (من فاتورة كذا وكذا)»، وخلّي الأصناف اللي على نفس الزيت ورا بعض.
  3) اللي يتساب دلوقتي (blocked) وناقصه إيه.
  الخطة كلها أقل من 200 كلمة، أهم 5-6 خطوات بس.
  وفي الآخر 2-4 نصايح عملية قصيرة (يحجز السطور من السيستم قبل ما يبدأ، يجهّز الفوارغ والزيت للدفعة كلها مرة واحدة، مايغيّرش زيت كتير، يقفل الفاتورة القريبة الأول عشان تتسلّم). ماتقولش وقت تقديري.
- نصايح الشغل والتنظيم والبيع: اقترح أفكار عملية من خبرتك، واربطها بأرقام الأدوات لما ينفع. ماتردش بـ«اسأل فارس» إلا لو السؤال عن زرار أو شاشة في السيستم ومش عارف مكانه.
- ماتقدرش تعدّل أو تمسح أي حاجة في السيستم. الحاجة الوحيدة اللي بتعملها هي مسودة فاتورة جديدة.
- العملاء: دوّر دايمًا بالاسم المكتوب في السؤال الحالي. ممنوع تبدّل عميل بعميل تاني اتذكر قبل كده في المحادثة.
- لو الأداة رجعت عميل اسمه مختلف عن المكتوب (match = close أو partial، أو customer مختلف عن المكتوب)، قول الاسم اللي في السيستم صراحة في أول الرد: «لقيت العميل: كيرلس حنا شكري». لو رجعت أكتر من عميل، اسأل يقصد مين قبل ما تدي أي سعر.
- العملاء: ماتفترضش إن العميل راجل ولا ست، اتكلم عنه بصيغة محايدة («العميل»).
- «آخر سعر خد بيه» = last_sold.price. لو never_bought = true قول إنه ماخدش الصنف ده قبل كده، واعرض price_now ومصدره.
- لو طلب يعمل فاتورة: استخدم draft_invoice. لو رجعت issues أو choose أو did_you_mean، اسأل عنهم كلهم ومتقولش إن فيه مسودة. لو رجعت draft_ready: اعرض العميل وكل صنف (الاسم + F، الكمية، السعر ومصدره) والإجمالي، وقوله: «راجعها ودوس ✅ سجّل الفاتورة تحت». إنت عمرك ما بتسجل بنفسك، وممنوع تقول «اتسجلت».
- لو المستخدم مالوش أداة draft_invoice (عامل/مخزن) وطلب فاتورة: قوله إن الفواتير بتتعمل من حساب الصفحة أو الإدارة.
- عميل جديد مش في السيستم: لو draft_invoice رجعت «مفيش عميل بالاسم ده»، اعرض الأسماء القريبة لو فيه واسأل المستخدم: ده عميل جديد؟ لو أكد إنه جديد، اسأله عن رقم تليفونه (ولو مش معاه كمّل من غيره) واستخدم draft_invoice_new. ممنوع تستخدمها من غير ما المستخدم يأكد إنه عميل جديد. لو رجعت customer_exists قوله الاسم اللي لقيته واسأله هو نفسه ولا لأ. لو رجعت draft_ready اعرض المسودة زي العادي وقول إن العميل جديد وهيتسجل مع الفاتورة لما يدوس «سجّل الفاتورة».
- ماتصحّحش ردودك القديمة إلا لو أداة رجعت رقم مختلف فعلاً.
- لو المستخدم اختار صنف أو عميل بعد ما سألته، ابعت الاسم اللي اختاره في product/customer، واللي كان كاتبه في الأول في said/customer_said، عشان السيستم يتعلّمه.
- «قايمة الشراء / محتاجين نشتري إيه / النواقص»: استخدم purchase_list. اعرض كل مورد وعدد أصنافه وأهم 5 أصناف، وحط رابط الواتساب زي ما هو لو موجود. «مورد مش متسجل» قول إن الأصناف دي محتاجة يتحدد موردها.
- «أطلب إيه النهارده / إيه قرب يخلص / نقطة إعادة الطلب / طلبية مورد كذا»: استخدم reorder_list (مش purchase_list). قول عدد اللي لازم يتطلب النهارده واللي قرّب، وبعدين كل مورد بعدد أصنافه وأهم الأصناف بالكمية المقترحة ويكفي كام يوم. لو سأل عن مورد بعينه ابعت supplier واعرض قايمته كلها. لو negative_balance_items أكبر من صفر نبّه إن الكميات تقريبية لحد الجرد. قوله إن تعديل الكميات وتسجيل الطلبية من تاب «التخطيط».
- «بلّغ فارس / قول لفارس / ابعتله رسالة»: استخدم tell_owner بكلام المستخدم نفسه من غير زيادة ولا تجميل. لو مش واضح عايز يقول إيه، اسأله الأول. لو sent = true قوله «وصّلت رسالتك لفارس» واكتبله النص اللي اتبعت. لو sent = false قوله السبب اللي في why. ماتبعتش حاجة لفارس من نفسك من غير ما المستخدم يطلب.
- الأدمن لو قال «افتكر/احفظ/خلي بالك إن…»: استخدم remember_rule، وأكّدله القاعدة اللي اتحفظت.
- الأرقام دايمًا بالإنجليزي (0-9)، مش ٠-٩.
- الرد: سطور قصيرة، أرقام واضحة، من غير مقدمات. لو المستخدم طلب قايمة كاملة، اعرضها كاملة ومتقطعهاش.${R}`;
}

async function rpc(fn: string, args: Record<string, unknown>, jwt: string, apikey: string) {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey, Authorization: jwt, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  const t = await r.text();
  if (!r.ok) {
    try { const e = JSON.parse(t); return { error: e.message ?? "error" }; } catch { return { error: "error" }; }
  }
  try { return JSON.parse(t); } catch { return t; }
}

async function logUsage(row: Record<string, unknown>): Promise<number | null> {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/agent_usage?select=id`, {
      method: "POST",
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify(row),
    });
    const j = await r.json();
    return Array.isArray(j) && j[0]?.id ? Number(j[0].id) : null;
  } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method" }, 405);

  const jwt = req.headers.get("Authorization") ?? "";
  const apikey = req.headers.get("apikey") ?? ANON_ENV;
  if (!jwt.startsWith("Bearer ")) return json({ error: "auth" }, 401);

  const quota = await rpc("ag_quota", {}, jwt, apikey);
  if (!quota || quota.error || !quota.role) return json({ error: "auth" }, 401);
  const isOwner = quota.role === "owner";
  const meta = { used_today: quota.used_today, limit: isOwner ? null : quota.limit, owner: isOwner };

  if (!API_KEY) return json({ answer: "المساعد لسه مش متفعّل (محتاج مفتاح Anthropic). كلّم فارس.", ...meta });
  if (Number(quota.month_cost) >= Number(quota.cap))
    return json({ answer: "رصيد المساعد للشهر ده خلص. هيرجع أول الشهر الجاي.", ...meta });
  if (!isOwner && Number(quota.used_today) >= Number(quota.limit))
    return json({ answer: `خلصت رسايل النهارده (${quota.limit}). كمّل بكرة.`, ...meta });

  let body: any = {};
  try { body = await req.json(); } catch { /* */ }
  const q = String(body.q ?? "").trim().slice(0, 1000);
  if (!q) return json({ error: "empty" }, 400);

  // short history, must alternate user/assistant and end with assistant
  const hist: { role: string; content: string }[] = [];
  for (const m of (Array.isArray(body.history) ? body.history : []).slice(-8)) {
    const role = m?.role === "assistant" ? "assistant" : m?.role === "user" ? "user" : null;
    const content = String(m?.content ?? "").slice(0, 1500);
    if (!role || !content) continue;
    if (hist.length === 0 && role !== "user") continue;
    if (hist.length && hist[hist.length - 1].role === role) continue;
    hist.push({ role, content });
  }
  if (hist.length && hist[hist.length - 1].role !== "assistant") hist.pop();

  const rr = await rpc("ag_rules", {}, jwt, apikey);
  const rules: string[] = Array.isArray(rr) ? rr.map((x: any) => String(x.body ?? "")).filter(Boolean).slice(0, 40) : [];
  const tools = TOOLS.filter((t) => !t.roles || t.roles.includes(quota.role));
  const apiTools = tools.map((t, idx) => ({
    name: t.name, description: t.description, input_schema: t.input_schema,
    ...(idx === tools.length - 1 ? { cache_control: { type: "ephemeral" } } : {}),
  }));
  const isList = LISTQ.test(q) && ["owner", "billing", "page"].includes(quota.role);
  const sCap = Math.max(Number(quota.sonnet_daily ?? 0), quota.role === "page" ? PAGE_SONNET_DAILY : 0);
  const useS = (ADVICE.test(q) || isList) && (isOwner || Number(quota.sonnet_today ?? 0) < sCap);
  const listMode = useS && isList && !ADVICE.test(q);
  const model = useS ? MODEL_S : MODEL;
  const messages: any[] = [...hist, { role: "user", content: q }];
  const used = { in: 0, out: 0, cr: 0, cw: 0 };
  const toolNames: string[] = [];
  const drafts: any[] = [];
  let answer = "";
  let ok = true;
  let errMsg = "";

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({
          model, max_tokens: useS ? (listMode ? 8000 : 5000) : 4000,
          ...(listMode ? { output_config: { effort: "medium" } } : {}),
          system: [{ type: "text", text: systemPrompt(quota, rules), cache_control: { type: "ephemeral" } }],
          tools: apiTools, messages,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error?.message ?? `anthropic ${r.status}`);
      const u = data.usage ?? {};
      used.in += u.input_tokens ?? 0; used.out += u.output_tokens ?? 0;
      used.cr += u.cache_read_input_tokens ?? 0; used.cw += u.cache_creation_input_tokens ?? 0;

      const text = (data.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n").trim();
      const calls = (data.content ?? []).filter((c: any) => c.type === "tool_use");
      if (data.stop_reason !== "tool_use" || calls.length === 0) { answer = text || (data.stop_reason === "max_tokens" ? "الرد طلع طويل، اسأل سؤال أصغر." : ""); break; }

      messages.push({ role: "assistant", content: data.content });
      const results = [];
      for (const c of calls) {
        const t = tools.find((x) => x.name === c.name);
        toolNames.push(c.name);
        let out: unknown = t ? await rpc(t.rpc, t.args(c.input ?? {}), jwt, apikey) : { error: "unknown tool" };
        if ((c.name === "draft_invoice" || c.name === "draft_invoice_new") && (out as any)?.status === "draft_ready") {
          const d: any = out;
          drafts.push({ id: d.draft_id, customer: d.customer, page: d.page, total: d.total, isNew: !!d.new_customer, phone: d.phone ?? null,
            lines: (d.lines ?? []).map((l: any) => ({ name: l.name, F: l.F, qty: l.qty, price: l.price, src: l.price_src, g: l.g })) });
        }
        if (c.name === "tier_prices" && Array.isArray((out as any)?.tiers)) {
          const o: any = out;
          const names = TIERN[String(o.page)] ?? TIERN.ol;
          o.tiers = o.tiers.map((x: any) => ({ ...x, name: names[Number(x.tier) - 1] ?? `شريحة ${x.tier}` }));
        }
        let s = JSON.stringify(out);
        const lim = t?.max ?? 7000;
        if (s.length > lim) s = s.slice(0, lim) + "…(مقطوع)";
        results.push({ type: "tool_result", tool_use_id: c.id, content: s });
      }
      messages.push({ role: "user", content: results });
      if (round === MAX_ROUNDS - 1) answer = text || "السؤال محتاج خطوات كتير، جرّب تسأله بشكل أبسط.";
    }
  } catch (e) {
    ok = false;
    answer = "حصلت مشكلة في المساعد، جرّب تاني بعد شوية.";
    errMsg = redact(e).slice(0, 300);
    console.error(errMsg);
  }

  const pi = Number(useS ? quota.price_in_s : quota.price_in), po = Number(useS ? quota.price_out_s : quota.price_out);
  const cost = (used.in * pi + used.cw * pi * 1.25 + used.cr * pi * 0.1 + used.out * po) / 1e6;
  const logId = await logUsage({
    user_id: quota.uid, user_name: quota.name, role: quota.role, q, a: (errMsg ? "ERR: " + errMsg : answer).slice(0, 4000), tools: toolNames,
    in_tok: used.in, out_tok: used.out, cache_read: used.cr, cache_write: used.cw,
    cost_usd: Number(cost.toFixed(6)), weight: ok ? 1 : 0, ok, model,
  });

  return json({ id: logId, answer: answer || "مافيش رد.", drafts: ok ? drafts.slice(-1) : [], ...meta, used_today: Number(quota.used_today) + (ok ? 1 : 0) });
});
