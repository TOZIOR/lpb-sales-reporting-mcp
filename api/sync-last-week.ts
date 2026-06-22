const supabaseUrl = process.env.SUPABASE_URL;
const cronSecret = process.env.CRON_SECRET;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const syncFunctionUrl =
  "https://aawucxidggmkpdcyhlpc.supabase.co/functions/v1/sync-pennylane-sales-reporting";

if (!supabaseUrl) throw new Error("Missing SUPABASE_URL");
if (!supabaseKey) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
if (!cronSecret) throw new Error("Missing CRON_SECRET");

function isoDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

function getLastCompleteWeek() {
  const now = new Date();
  const day = now.getUTCDay() || 7;

  const currentMonday = new Date(now);
  currentMonday.setUTCDate(now.getUTCDate() - day + 1);
  currentMonday.setUTCHours(0, 0, 0, 0);

  const previousMonday = new Date(currentMonday);
  previousMonday.setUTCDate(currentMonday.getUTCDate() - 7);

  return {
    startDate: isoDate(previousMonday),
    endDate: isoDate(currentMonday),
  };
}

export default async function handler(req: any, res: any) {
  try {
    const providedSecret = req.query?.secret || req.headers["x-cron-secret"];

    if (providedSecret !== cronSecret) {
      return res.status(401).json({
        ok: false,
        error: "Unauthorized",
      });
    }

    const period = getLastCompleteWeek();

    const syncResponse = await fetch(syncFunctionUrl, {
      method: "POST",
     headers: {
  "Content-Type": "application/json",
  Authorization: `Bearer ${supabaseKey}`,
},
      body: JSON.stringify({
        startDate: period.startDate,
        endDate: period.endDate,
        maxInvoices: 500,
        limit: 100,
      }),
    });

    const result = await syncResponse.json();

    if (!syncResponse.ok) {
      throw new Error(JSON.stringify(result));
    }

    return res.status(200).json({
      ok: true,
      period,
      sync: result,
    });
  } catch (e: any) {
    return res.status(500).json({
      ok: false,
      error: e?.message ?? String(e),
    });
  }
}