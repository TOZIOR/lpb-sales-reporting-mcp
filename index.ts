import express from "express";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const MCP_API_KEY = process.env.MCP_API_KEY!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

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

  throw new Error(`Période non supportée: ${periodType}`);
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

function createMcpServer() {
  const server = new McpServer({
    name: "lpb-sales-reporting",
    version: "1.0.0",
  });

  server.tool(
    "describe_reporting_source",
    "Décrit la source Supabase utilisée pour le reporting commercial LPB.",
    {},
    async () => {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              source: "reporting_sales",
              description: "Vue Supabase consolidant les ventes PennyLane importées.",
              fields: {
                sale_date: "Date de facture",
                document_number: "Numéro de facture",
                customer_name: "Client, si disponible",
                status: "Statut PennyLane",
                product_name: "Produit vendu",
                product_reference: "Référence produit",
                quantity: "Quantité vendue",
                total_ttc: "Montant TTC",
              },
              aggregation_function: "get_sales_by_product(p_start_date, p_end_date)",
            }),
          },
        ],
      };
    }
  );

  server.tool(
    "get_sales_raw",
    "Récupère les ventes brutes depuis Supabase sur une période donnée.",
    {
      start_date: z.string(),
      end_date: z.string(),
      limit: z.number().default(5000),
    },
    async ({ start_date, end_date, limit }) => {
      const { data, error } = await supabase
        .from("reporting_sales")
        .select("*")
        .gte("sale_date", start_date)
        .lt("sale_date", end_date)
        .order("sale_date", { ascending: false })
        .limit(limit);

      if (error) throw new Error(error.message);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              period: { start_date, end_date },
              row_count: data?.length ?? 0,
              rows: data ?? [],
            }),
          },
        ],
      };
    }
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

      const rows = data ?? [];
      const total_ttc = rows.reduce((s: number, r: any) => s + Number(r.total_ttc ?? 0), 0);
      const total_quantity = rows.reduce((s: number, r: any) => s + Number(r.total_quantity ?? 0), 0);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              period: { start_date, end_date },
              totals: { total_quantity, total_ttc },
              products: rows,
              csv: toCsv(rows),
            }),
          },
        ],
      };
    }
  );

  server.tool(
    "generate_sales_report",
    "Génère un export commercial prêt à envoyer par email pour une période standard.",
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
              totals: {
                total_quantity,
                total_ttc,
              },
              products,
              csv: toCsv(products),
              email_suggestion: {
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

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  if (!MCP_API_KEY) return next();

  const auth = req.headers.authorization;
  if (auth !== `Bearer ${MCP_API_KEY}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
});

app.post("/mcp", async (req, res) => {
  const server = createMcpServer();

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    name: "lpb-sales-reporting-mcp",
    endpoint: "/mcp",
  });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`LPB Sales Reporting MCP running on port ${port}`);
});