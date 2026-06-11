import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const SYNC_NAME = "pennylane_sales_reporting";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toNumber(value: any, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function firstDefined(...values: any[]) {
  return values.find((v) => v !== undefined && v !== null && v !== "");
}

async function fetchPennylaneWithRetry(url: string, token: string) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });

    if (res.status !== 429) return res;

    const retryAfter = res.headers.get("retry-after");
    const waitMs = retryAfter ? Number(retryAfter) * 1000 : attempt * 3000;

    console.log(`PennyLane 429. Retry ${attempt}/6 in ${waitMs}ms`);
    await sleep(waitMs);
  }

  throw new Error("PennyLane rate limit: too many retries");
}

async function fetchAllInvoiceLines(invoiceId: string, token: string) {
  let cursor: string | null = null;
  const allLines: any[] = [];

  while (true) {
    const url = cursor
      ? `https://app.pennylane.com/api/external/v2/customer_invoices/${invoiceId}/invoice_lines?limit=100&cursor=${encodeURIComponent(cursor)}`
      : `https://app.pennylane.com/api/external/v2/customer_invoices/${invoiceId}/invoice_lines?limit=100`;

    const res = await fetchPennylaneWithRetry(url, token);

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`PennyLane invoice lines error: ${res.status} - ${body}`);
    }

    const data = await res.json();
    allLines.push(...(data.items || data.invoice_lines || data.lines || []));

    if (!data.has_more || !data.next_cursor) break;

    cursor = data.next_cursor;
    await sleep(300);
  }

  return allLines;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const token = Deno.env.get("PENNYLANE_API_TOKEN");

    if (!supabaseUrl) throw new Error("Missing SUPABASE_URL");
    if (!supabaseKey) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
    if (!token) throw new Error("Missing PENNYLANE_API_TOKEN");

    const supabase = createClient(supabaseUrl, supabaseKey);

    let body: any = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    const maxInvoices = body.maxInvoices ?? 25;
    const limit = body.limit ?? 100;
    const reset = body.reset === true;

    if (reset) {
      await supabase.from("pennylane_sync_state").upsert({
        sync_name: SYNC_NAME,
        next_cursor: null,
        is_finished: false,
        updated_at: new Date().toISOString(),
      });
    }

    const { data: state } = await supabase
      .from("pennylane_sync_state")
      .select("*")
      .eq("sync_name", SYNC_NAME)
      .maybeSingle();

    if (state?.is_finished && !reset) {
      return new Response(
        JSON.stringify(
          {
            ok: true,
            message: "Import déjà terminé. Utilise { reset: true } pour recommencer depuis le début.",
            totalInvoices: 0,
            totalLines: 0,
          },
          null,
          2
        ),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let cursor: string | null = state?.next_cursor ?? null;

    let totalInvoices = 0;
    let totalLines = 0;
    let upsertedInvoices = 0;
    let upsertedLines = 0;
    let skippedLines = 0;
    let pagesProcessed = 0;
    let lastNextCursor: string | null = cursor;
    let finished = false;

    const errors: string[] = [];

    while (totalInvoices < maxInvoices) {
      const invoicesUrl = cursor
        ? `https://app.pennylane.com/api/external/v2/customer_invoices?limit=${limit}&cursor=${encodeURIComponent(cursor)}`
        : `https://app.pennylane.com/api/external/v2/customer_invoices?limit=${limit}`;

      console.log("Fetching invoices:", invoicesUrl);

      const invoicesRes = await fetchPennylaneWithRetry(invoicesUrl, token);

      if (!invoicesRes.ok) {
        const text = await invoicesRes.text();
        throw new Error(`PennyLane invoices error: ${invoicesRes.status} - ${text}`);
      }

      const invoicesData = await invoicesRes.json();
      const invoices =
        invoicesData.items ||
        invoicesData.customer_invoices ||
        invoicesData.invoices ||
        [];

      pagesProcessed++;

      if (!invoices.length) {
        finished = true;
        lastNextCursor = null;
        break;
      }

      for (const invoice of invoices) {
        if (totalInvoices >= maxInvoices) break;

        totalInvoices++;

        const pennylaneDocumentId = String(invoice.id);

        const documentNumber = firstDefined(
          invoice.invoice_number,
          invoice.document_number,
          invoice.number,
          invoice.label
        );

        const documentDate = firstDefined(
          invoice.date,
          invoice.invoice_date,
          invoice.document_date,
          invoice.issued_at,
          invoice.created_at
        );

        const customerName = firstDefined(
          invoice.customer?.name,
          invoice.customer_name,
          invoice.customer?.source_name,
          invoice.customer?.label,
          invoice.thirdparty?.name
        );

        const status = firstDefined(invoice.status, invoice.state);

        const { data: savedInvoice, error: invoiceError } = await supabase
          .from("pennylane_sales_imports")
          .upsert(
            {
              pennylane_document_id: pennylaneDocumentId,
              document_number: documentNumber ?? null,
              document_date: documentDate ? String(documentDate).slice(0, 10) : null,
              customer_name: customerName ?? null,
              status: status ?? null,
              raw_payload: invoice,
              imported_at: new Date().toISOString(),
            },
            { onConflict: "pennylane_document_id" }
          )
          .select("id")
          .maybeSingle();

        if (invoiceError) {
          errors.push(`Invoice ${pennylaneDocumentId}: ${invoiceError.message}`);
          continue;
        }

        if (!savedInvoice?.id) {
          errors.push(`Invoice ${pennylaneDocumentId}: no saved invoice id returned`);
          continue;
        }

        upsertedInvoices++;

        await sleep(300);

        let lines: any[] = [];

        try {
          lines = await fetchAllInvoiceLines(pennylaneDocumentId, token);
        } catch (e) {
          errors.push(
            `Invoice lines ${pennylaneDocumentId}: ${
              e instanceof Error ? e.message : String(e)
            }`
          );
          continue;
        }

        for (const line of lines) {
          totalLines++;

          const lineId = firstDefined(
            line.id,
            line.invoice_line_id,
            line.pennylane_line_id
          );

          if (!lineId) {
            skippedLines++;
            errors.push(`Invoice ${pennylaneDocumentId}: line without id`);
            continue;
          }

          const productName = firstDefined(
            line.product_name,
            line.product?.name,
            line.label,
            line.description
          );

          const productReference = firstDefined(
            line.product_reference,
            line.product?.reference,
            line.reference,
            line.product?.id
          );

          const quantity = toNumber(firstDefined(line.quantity, line.qty), 0);
          const unit = firstDefined(line.unit, line.unit_name);

          const unitPriceHt = toNumber(
            firstDefined(
              line.unit_price_before_tax,
              line.unit_price_ht,
              line.unit_price,
              line.price
            ),
            0
          );

          const totalHt = toNumber(
            firstDefined(
              line.amount_before_tax,
              line.total_ht,
              line.price_before_tax,
              line.amount_without_tax
            ),
            quantity * unitPriceHt
          );

          const totalTtc = toNumber(
            firstDefined(
              line.amount,
              line.total_ttc,
              line.amount_with_tax,
              line.price_with_tax
            ),
            totalHt
          );

          const { error: lineError } = await supabase
            .from("pennylane_sales_lines")
            .upsert(
              {
                sale_import_id: savedInvoice.id,
                pennylane_line_id: String(lineId),
                product_name: productName ?? null,
                product_reference: productReference ? String(productReference) : null,
                quantity,
                unit: unit ?? null,
                unit_price_ht: unitPriceHt,
                total_ht: totalHt,
                total_ttc: totalTtc,
                raw_payload: line,
              },
              { onConflict: "pennylane_line_id" }
            );

          if (lineError) {
            errors.push(`Line ${lineId}: ${lineError.message}`);
            continue;
          }

          upsertedLines++;
        }

        await sleep(300);
      }

      if (!invoicesData.has_more || !invoicesData.next_cursor) {
        finished = true;
        lastNextCursor = null;
        break;
      }

      lastNextCursor = invoicesData.next_cursor;
      cursor = invoicesData.next_cursor;

      if (totalInvoices >= maxInvoices) break;

      await sleep(500);
    }

    await supabase.from("pennylane_sync_state").upsert({
      sync_name: SYNC_NAME,
      next_cursor: lastNextCursor,
      is_finished: finished,
      updated_at: new Date().toISOString(),
    });

    return new Response(
      JSON.stringify(
        {
          ok: errors.length === 0,
          totalInvoices,
          totalLines,
          upsertedInvoices,
          upsertedLines,
          skippedLines,
          pagesProcessed,
          saved_next_cursor: lastNextCursor,
          is_finished: finished,
          errorCount: errors.length,
          errors: errors.slice(0, 30),
        },
        null,
        2
      ),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("FULL ERROR", e);

    return new Response(
      JSON.stringify(
        {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
          stack: e instanceof Error ? e.stack : null,
        },
        null,
        2
      ),
      {
        status: 500,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  }
});