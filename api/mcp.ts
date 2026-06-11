import { createClient } from "@supabase/supabase-js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const mcpApiKey = process.env.MCP_API_KEY;

if (!supabaseUrl) throw new Error("Missing SUPABASE_URL");
if (!supabaseKey) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");

const supabase = createClient(supabaseUrl, supabaseKey);

function isoDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

function getPreviousPeriod(periodType: string) {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();

  if (periodType === "weekly") {
    const day = now.getUTCDay() || 7;
    const currentMonday = new Date(now);
    currentMonday.setUTCDate(now.getUTCDate() - day + 1);
    currentMonday.setUTCHours(0, 0, 0, 0);

    const previousMonday = new Date(currentMonday);
    previousMonday.setUTCDate(currentMonday.getUTCDate() - 7);

    return {
      start_date: isoDate(previousMonday),
      end_date: isoDate(currentMonday),
      label: "Dernière semaine complète",
    };
  }

  if (periodType === "monthly") {
    return {
      start_date: isoDate(new Date(Date.UTC(y, m - 1, 1))),
      end_date: isoDate(new Date(Date.UTC(y, m, 1))),
      label: "Mois précédent complet",
    };
  }

  if (periodType === "quarterly") {
    const currentQuarter = Math.floor(m / 3);
    const previousQuarterStartMonth = currentQuarter === 0 ? 9 : (currentQuarter - 1) * 3;
    const startYear = currentQuarter === 0 ? y - 1 : y;
    const endMonth = currentQuarter * 3;

    return {
      start_date: isoDate(new Date(Date.UTC(startYear, previousQuarterStartMonth, 1))),
      end_date: isoDate(new Date(Date.UTC(y, endMonth, 1))),
      label: "Trimestre précédent complet",
    };
  }

  if (periodType === "half_yearly") {
    const currentHalfStart = m < 6 ? 0 : 6;
    const previousHalfStart = currentHalfStart === 0 ? 6 : 0;
    const startYear = currentHalfStart === 0 ? y - 1 : y;

    return {
      start_date: isoDate(new Date(Date.UTC(startYear, previousHalfStart, 1))),
      end_date: isoDate(new Date(Date.UTC(y, currentHalfStart, 1))),
      label: "Semestre précédent complet",
    };
  }

  if (periodType === "yearly") {
    return {
      start_date: isoDate(new Date(Date.UTC(y - 1, 0, 1))),
      end_date: isoDate(new Date(Date.UTC(y, 0, 1))),
      label: "Année précédente complète",
    };
  }

  throw new Error(`Unsupported period_type: ${periodType}`);
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

function createServer() {
  const server = new McpServer({
    name: "lpb-sales-reporting",
    version: "1.0.0",
  });

  server.tool(
    "describe_reporting_source",
    "Décrit la source Supabase utilisée pour le reporting commercial LPB.",
    {},
    async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            source: "reporting_sales",
            aggregation_function: "get_sales_by_product",
            fields: [
              "sale_date",
              "document_number",
              "customer_name",
              "status",
              "product_name",
              "product_reference",
              "quantity",
              "total_ttc"
            ],
          }),
        },
      ],
    })
  );

  server.tool(
    "get_sales_by_product",
    "Retourne les ventes agrégées par produit sur une période donnée.",
    {
      start_date: z.string(),
      end_date: z.string(),
    },
    async ({ start_date, end_date }) => {
      const { data, error } = await supabase.rpc("get_sales_by_product", {
        p_start_date: start_date,
        p_end_date: end_date,
      });

      if (error) throw new Error(error.message);

      const products = data ?? [];
      const total_ttc = products.reduce((s: number, r: any) => s + Number(r.total_ttc ?? 0), 0);
      const total_quantity = products.reduce((s: number, r: any) => s + Number(r.total_quantity ?? 0), 0);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              period: { start_date, end_date },
              totals: { total_quantity, total_ttc },
              products,
              csv: toCsv(products),
            }),
          },
        ],
      };
    }
  );

  server.tool(
    "generate_sales_report",
    "Génère un export commercial prêt à envoyer par email.",
    {
      period_type: z.enum(["weekly", "monthly", "quarterly", "half_yearly", "yearly"]),
    },
    async ({ period_type }) => {
      const period = getPreviousPeriod(period_type);

      const { data, error } = await supabase.rpc("get_sales_by_product", {
        p_start_date: period.start_date,
        p_end_date: period.end_date,
      });

      if (error) throw new Error(error.message);

      const products = data ?? [];
      const total_ttc = products.reduce((s: number, r: any) => s + Number(r.total_ttc ?? 0), 0);
      const total_quantity = products.reduce((s: number, r: any) => s + Number(r.total_quantity ?? 0), 0);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              report_name: `reporting_ventes_${period_type}_${period.start_date}_${period.end_date}`,
              period_type,
              period,
              totals: { total_quantity, total_ttc },
              products,
              csv: toCsv(products),
              email: {
                subject: `Reporting commercial LPB - ${period.label}`,
                summary: `CA TTC: ${total_ttc.toFixed(2)} €. Quantité totale: ${total_quantity}. Nombre de produits: ${products.length}.`,
              },
            }),
          },
        ],
      };
    }
  );

  return server;
}

export default async function handler(req: any, res: any) {
  console.log("METHOD:", req.method);

  if (req.method === "GET") {
    return res.status(200).json({
      name: "lpb-sales-reporting",
      version: "1.0.0",
      status: "ok"
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }
  if (mcpApiKey) {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${mcpApiKey}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  const server = createServer();

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}