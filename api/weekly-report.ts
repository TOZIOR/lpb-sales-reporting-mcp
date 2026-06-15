import { createClient } from "@supabase/supabase-js";
import ExcelJS from "exceljs";

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

function money(value: number) {
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
  }).format(value);
}

async function buildExcel(products: any[], period: any, totals: any) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "LPB Reporting";
  workbook.created = new Date();

  const ws = workbook.addWorksheet("Ventes par produit");

  ws.columns = [
    { header: "Produit", key: "product_name", width: 42 },
    { header: "Référence", key: "product_reference", width: 18 },
    { header: "Quantité", key: "total_quantity", width: 14 },
    { header: "CA TTC", key: "total_ttc", width: 16 },
  ];

  ws.mergeCells("A1:D1");
  ws.getCell("A1").value = "Reporting commercial LPB";
  ws.getCell("A1").font = { bold: true, size: 18 };
  ws.getCell("A1").alignment = { horizontal: "center" };

  ws.mergeCells("A2:D2");
  ws.getCell("A2").value = `Période : ${period.label}`;
  ws.getCell("A2").alignment = { horizontal: "center" };

  ws.getCell("A4").value = "CA TTC";
  ws.getCell("B4").value = totals.totalTtc;
  ws.getCell("B4").numFmt = '#,##0.00 €';

  ws.getCell("A5").value = "Quantité vendue";
  ws.getCell("B5").value = totals.totalQuantity;

  ws.getCell("A6").value = "Nombre de produits";
  ws.getCell("B6").value = products.length;

  ["A4", "A5", "A6"].forEach((cell) => {
    ws.getCell(cell).font = { bold: true };
  });

  const headerRow = ws.getRow(8);
  headerRow.values = ["Produit", "Référence", "Quantité", "CA TTC"];
  headerRow.font = { bold: true };
  headerRow.alignment = { horizontal: "center" };

  products
    .sort((a, b) => Number(b.total_ttc ?? 0) - Number(a.total_ttc ?? 0))
    .forEach((p) => {
      ws.addRow({
        product_name: p.product_name ?? "",
        product_reference: p.product_reference ?? "",
        total_quantity: Number(p.total_quantity ?? 0),
        total_ttc: Number(p.total_ttc ?? 0),
      });
    });

  ws.eachRow((row, rowNumber) => {
    row.eachCell((cell) => {
      cell.border = {
        top: { style: "thin" },
        left: { style: "thin" },
        bottom: { style: "thin" },
        right: { style: "thin" },
      };
      cell.alignment = {
        vertical: "middle",
        wrapText: true,
      };
    });

    if (rowNumber === 8) {
      row.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFD9EAF7" },
      };
    }
  });

  ws.getColumn("C").alignment = { horizontal: "right" };
  ws.getColumn("D").alignment = { horizontal: "right" };
  ws.getColumn("D").numFmt = '#,##0.00 €';

  ws.autoFilter = {
    from: "A8",
    to: "D8",
  };

  ws.views = [{ state: "frozen", ySplit: 8 }];

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer).toString("base64");
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

    if (error) {
      throw new Error(`Supabase RPC error: ${error.message}`);
    }

    const products = data ?? [];

    const totalTtc = products.reduce(
      (sum: number, row: any) => sum + Number(row.total_ttc ?? 0),
      0
    );

    const totalQuantity = products.reduce(
      (sum: number, row: any) => sum + Number(row.total_quantity ?? 0),
      0
    );

    const totals = { totalTtc, totalQuantity };

    const excelBase64 = await buildExcel(products, period, totals);

    const topProducts = [...products]
      .sort((a, b) => Number(b.total_ttc ?? 0) - Number(a.total_ttc ?? 0))
      .slice(0, 10)
      .map(
        (p: any, index: number) =>
          `<tr>
            <td>${index + 1}</td>
            <td>${p.product_name || "Produit inconnu"}</td>
            <td style="text-align:right;">${p.total_quantity ?? 0}</td>
            <td style="text-align:right;">${money(Number(p.total_ttc ?? 0))}</td>
          </tr>`
      )
      .join("");

    const subject = `Reporting commercial LPB - semaine ${period.label}`;

    const html = `
      <div style="font-family: Arial, sans-serif; color: #222;">
        <h2>Reporting commercial LPB</h2>

        <p><strong>Période :</strong> ${period.label}</p>

        <table style="border-collapse: collapse; margin-bottom: 24px;">
          <tr>
            <td style="padding: 8px 14px; border: 1px solid #ddd;"><strong>CA TTC</strong></td>
            <td style="padding: 8px 14px; border: 1px solid #ddd; text-align: right;">${money(totalTtc)}</td>
          </tr>
          <tr>
            <td style="padding: 8px 14px; border: 1px solid #ddd;"><strong>Quantité vendue</strong></td>
            <td style="padding: 8px 14px; border: 1px solid #ddd; text-align: right;">${totalQuantity}</td>
          </tr>
          <tr>
            <td style="padding: 8px 14px; border: 1px solid #ddd;"><strong>Nombre de produits</strong></td>
            <td style="padding: 8px 14px; border: 1px solid #ddd; text-align: right;">${products.length}</td>
          </tr>
        </table>

        <h3>Top 10 produits par CA TTC</h3>

        <table style="border-collapse: collapse; width: 100%; max-width: 800px;">
          <thead>
            <tr>
              <th style="padding: 8px; border: 1px solid #ddd;">#</th>
              <th style="padding: 8px; border: 1px solid #ddd;">Produit</th>
              <th style="padding: 8px; border: 1px solid #ddd;">Quantité</th>
              <th style="padding: 8px; border: 1px solid #ddd;">CA TTC</th>
            </tr>
          </thead>
          <tbody>
            ${topProducts || "<tr><td colspan='4'>Aucune vente sur la période.</td></tr>"}
          </tbody>
        </table>

        <p style="margin-top: 24px;">
          Le fichier Excel détaillé est joint à cet email.
        </p>
      </div>
    `;

    const resendResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "LPB Reporting <onboarding@resend.dev>",
        to: [reportEmailTo],
        subject,
        html,
        attachments: [
          {
            filename: `reporting_ventes_${period.start_date}_${period.end_date}.xlsx`,
            content: excelBase64,
          },
        ],
      }),
    });

    const result = await resendResponse.json();

    if (!resendResponse.ok) {
      throw new Error(JSON.stringify(result));
    }

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