import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const resendApiKey = process.env.RESEND_API_KEY;
const reportEmailTo = process.env.REPORT_EMAIL_TO;
const cronSecret = process.env.CRON_SECRET;

if (!supabaseUrl) throw new Error("Missing SUPABASE_URL");
if (!supabaseKey) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
if (!resendApiKey) throw new Error("Missing RESEND_API_KEY");
if (!reportEmailTo) throw new Error("Missing REPORT_EMAIL_TO");

const supabase = createClient(supabaseUrl, supabaseKey);
const resend = new Resend(resendApiKey);

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
    start_date: isoDate(previousMonday),
    end_date: isoDate(currentMonday),
    label: `du ${isoDate(previousMonday)} au ${isoDate(currentMonday)}`,
  };
}

function toCsv(rows: any[]) {
  const headers = ["product_name", "product_reference", "total_quantity", "total_ttc"];
  return [
    headers.join(","),
    ...rows.map((row) =>
      headers.map((h) => JSON.stringify(row[h] ?? "")).join(",")
    ),
  ].join("\n");
}

function money(value: number) {
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
  }).format(value);
}

export default async function handler(req: any, res: any) {
  try {
    if (cronSecret) {
      const providedSecret = req.query?.secret || req.headers["x-cron-secret"];

      if (providedSecret !== cronSecret) {
        return res.status(401).json({
          ok: false,
          error: "Unauthorized",
        });
      }
    }

    const period = getLastCompleteWeek();

    const { data, error } = await supabase.rpc("get_sales_by_product", {
      p_start_date: period.start_date,
      p_end_date: period.end_date,
    });

    if (error) throw new Error(error.message);

    const products = data ?? [];

    const totalTtc = products.reduce(
      (sum: number, row: any) => sum + Number(row.total_ttc ?? 0),
      0
    );

    const totalQuantity = products.reduce(
      (sum: number, row: any) => sum + Number(row.total_quantity ?? 0),
      0
    );

    const csv = toCsv(products);

    const topProducts = products
      .slice(0, 10)
      .map(
        (p: any, index: number) =>
          `${index + 1}. ${p.product_name || "Produit inconnu"} — ${p.total_quantity ?? 0} unités — ${money(Number(p.total_ttc ?? 0))}`
      )
      .join("<br>");

    const subject = `Reporting commercial LPB - semaine ${period.label}`;

    const html = `
      <h2>Reporting commercial LPB</h2>
      <p><strong>Période :</strong> ${period.label}</p>
      <p><strong>CA TTC :</strong> ${money(totalTtc)}</p>
      <p><strong>Quantité totale :</strong> ${totalQuantity}</p>
      <p><strong>Nombre de produits :</strong> ${products.length}</p>

      <h3>Top produits</h3>
      <p>${topProducts || "Aucune vente sur la période."}</p>

      <p>Le CSV détaillé par produit est joint à cet email.</p>
    `;

    const result = await resend.emails.send({
      from: "LPB Reporting <onboarding@resend.dev>",
      to: reportEmailTo,
      subject,
      html,
      attachments: [
        {
          filename: `reporting_ventes_${period.start_date}_${period.end_date}.csv`,
          content: Buffer.from(csv, "utf-8").toString("base64"),
        },
      ],
    });

    return res.status(200).json({
      ok: true,
      period,
      totals: {
        total_ttc: totalTtc,
        total_quantity: totalQuantity,
        products_count: products.length,
      },
      email: result,
    });
  } catch (e: any) {
    return res.status(500).json({
      ok: false,
      error: e?.message ?? String(e),
    });
  }
}