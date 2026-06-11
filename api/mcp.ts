import { createClient } from "@supabase/supabase-js";

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
    const previousQuarterStartMonth =
      currentQuarter === 0 ? 9 : (currentQuarter - 1) * 3;
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
    ...rows.map((row) => headers.map((h) => JSON.stringify(row[h] ?? "")).join(",")),
  ].join("\n");
}

const tools = [
  {
    name: "describe_reporting_source",
    description: "Décrit la source Supabase utilisée pour le reporting commercial LPB.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_sales_by_product",
    description: "Retourne les ventes agrégées par produit sur une période donnée.",
    inputSchema: {
      type: "object",
      properties: {
        start_date: { type: "string", description: "Date de début incluse, format YYYY-MM-DD" },
        end_date: { type: "string", description: "Date de fin exclue, format YYYY-MM-DD" },
      },
      required: ["start_date", "end_date"],
    },
  },
  {
    name: "generate_sales_report",
    description: "Génère un reporting commercial prêt à envoyer par email.",
    inputSchema: {
      type: "object",
      properties: {
        period_type: {
          type: "string",
          enum: ["weekly", "monthly", "quarterly", "half_yearly", "yearly"],
        },
      },
      required: ["period_type"],
    },
  },
];

async function callTool(name: string, args: any) {
  if (name === "describe_reporting_source") {
    return {
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
        "total_ttc",
      ],
    };
  }

  if (name === "get_sales_by_product") {
    const { start_date, end_date } = args;

    const { data, error } = await supabase.rpc("get_sales_by_product", {
      p_start_date: start_date,
      p_end_date: end_date,
    });

    if (error) throw new Error(error.message);

    const products = data ?? [];
    const total_ttc = products.reduce((s: number, r: any) => s + Number(r.total_ttc ?? 0), 0);
    const total_quantity = products.reduce((s: number, r: any) => s + Number(r.total_quantity ?? 0), 0);

    return {
      period: { start_date, end_date },
      totals: { total_quantity, total_ttc },
      products,
      csv: toCsv(products),
    };
  }

  if (name === "generate_sales_report") {
    const period = getPreviousPeriod(args.period_type);

    const { data, error } = await supabase.rpc("get_sales_by_product", {
      p_start_date: period.start_date,
      p_end_date: period.end_date,
    });

    if (error) throw new Error(error.message);

    const products = data ?? [];
    const total_ttc = products.reduce((s: number, r: any) => s + Number(r.total_ttc ?? 0), 0);
    const total_quantity = products.reduce((s: number, r: any) => s + Number(r.total_quantity ?? 0), 0);

    return {
      report_name: `reporting_ventes_${args.period_type}_${period.start_date}_${period.end_date}`,
      period_type: args.period_type,
      period,
      totals: { total_quantity, total_ttc },
      products,
      csv: toCsv(products),
      email: {
        subject: `Reporting commercial LPB - ${period.label}`,
        summary: `CA TTC: ${total_ttc.toFixed(2)} €. Quantité totale: ${total_quantity}. Nombre de produits: ${products.length}.`,
      },
    };
  }

  throw new Error(`Unknown tool: ${name}`);
}

export default async function handler(req: any, res: any) {
  if (req.method === "GET") {
    return res.status(200).json({
      name: "lpb-sales-reporting",
      version: "1.0.0",
      tools,
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (mcpApiKey) {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${mcpApiKey}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  const body = req.body;
  const id = body?.id ?? null;
  const method = body?.method;
  const params = body?.params ?? {};

  try {
    if (method === "initialize") {
      return res.status(200).json({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: "lpb-sales-reporting",
            version: "1.0.0",
          },
        },
      });
    }

    if (method === "notifications/initialized") {
      return res.status(204).end();
    }

    if (method === "ping") {
      return res.status(200).json({
        jsonrpc: "2.0",
        id,
        result: {},
      });
    }

    if (method === "tools/list") {
      return res.status(200).json({
        jsonrpc: "2.0",
        id,
        result: {
          tools,
        },
      });
    }

    if (method === "tools/call") {
      const toolName = params.name;
      const toolArgs = params.arguments ?? {};

      const result = await callTool(toolName, toolArgs);

      return res.status(200).json({
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        },
      });
    }

    return res.status(200).json({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32601,
        message: `Method not found: ${method}`,
      },
    });
  } catch (e: any) {
    return res.status(200).json({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32000,
        message: e?.message ?? String(e),
      },
    });
  }
}