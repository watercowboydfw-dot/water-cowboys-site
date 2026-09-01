import type { Context, Config } from "@netlify/functions";

// ============================================================
// Water Cowboys — website-to-Close lead bridge
//
// Receives lead data from the site's contact gate, booking
// widget, and package buttons, then creates/updates the
// corresponding Lead, Contact, and (optionally) Opportunity in
// Close CRM. The Close API key lives only in this server-side
// function via the CLOSE_API_KEY environment variable — it is
// never sent to or readable by the browser.
// ============================================================

const CLOSE_API_BASE = "https://api.close.com/api/v1";

// Real IDs pulled from the live Close account during setup.
const FIELD = {
  leadZip: "cf_NSi3UXqA79kXPJeJQX9ganS3cnedJ7CFRM5tgxHBuJ2",
  leadGpg: "cf_2MaeXFonHDRx2hhZ7GLIKWHeBRUEy4HR0i5eTVujh4g",
  leadSource: "cf_AO2z8SgJm5k660War5CvISKHKOI5KCFAq6sgb7gIBCh",
  oppPackage: "cf_GWZMBo6Ee2jyL5iDrSZNj2P7fmLCMyawwHh2Yzggh1R",
  oppInstallType: "cf_teiFizC4FpdfcCCVq3R88lLIEx4OFw45LZJqkGwfAV2",
};

const LEAD_STATUS_NEW = "stat_pIO47ufUBHlJDVBDuxaOj4Qu4jTjgJd8ghCkZPb8MKz"; // "New Lead"
const OPP_STATUS_CONTACTED = "stat_B19zALzkSxYQxpwkQKQna566FFBV45HefiHvId34rLa"; // "Contacted"

// Flat prices, in cents, matching the site's published packages.
const PACKAGE_PRICE_CENTS: Record<string, number> = {
  Starter: 79900,
  Essential: 259900,
  Complete: 399900,
  Ultimate: 449900,
};

interface LeadPayload {
  name?: string;
  email?: string;
  phone?: string;
  zip?: string;
  gpg?: number;
  package?: string; // "Starter" | "Essential" | "Complete" | "Ultimate"
  source?: string; // e.g. "main-site-gate", "landing-a-control", "booking-widget"
  note?: string; // e.g. requested callback day/time
}

function closeHeaders(apiKey: string) {
  return {
    Authorization: "Basic " + Buffer.from(apiKey + ":").toString("base64"),
    "Content-Type": "application/json",
  };
}

async function closeRequest(
  apiKey: string,
  method: string,
  path: string,
  body?: Record<string, unknown>
) {
  const res = await fetch(`${CLOSE_API_BASE}${path}`, {
    method,
    headers: closeHeaders(apiKey),
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `Close API ${method} ${path} failed (${res.status}): ${JSON.stringify(data)}`
    );
  }
  return data;
}

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  const apiKey = Netlify.env.get("CLOSE_API_KEY");
  if (!apiKey) {
    console.error("CLOSE_API_KEY is not set in this environment.");
    return new Response(
      JSON.stringify({ error: "Server misconfiguration" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  let payload: LeadPayload;
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const phone = (payload.phone || "").trim();
  const email = (payload.email || "").trim();
  const phoneValid = /^[\d\s\-\(\)\+]{7,}$/.test(phone);
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

  if (!phoneValid && !emailValid) {
    return new Response(
      JSON.stringify({ error: "A valid phone or email is required" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    // 1. Create the Lead
    const leadName =
      payload.name?.trim() ||
      `Website Lead${payload.zip ? " — ZIP " + payload.zip : ""}`;

    const leadCustomFields: Record<string, unknown> = {};
    if (payload.zip) leadCustomFields[`custom.${FIELD.leadZip}`] = payload.zip;
    if (typeof payload.gpg === "number")
      leadCustomFields[`custom.${FIELD.leadGpg}`] = payload.gpg;
    if (payload.source)
      leadCustomFields[`custom.${FIELD.leadSource}`] = payload.source;

    const lead = await closeRequest(apiKey, "POST", "/lead/", {
      name: leadName,
      status_id: LEAD_STATUS_NEW,
      ...leadCustomFields,
    });

    // 2. Create the Contact on that lead
    const contactPayload: Record<string, unknown> = {
      lead_id: lead.id,
      name: payload.name?.trim() || undefined,
    };
    if (emailValid) {
      contactPayload.emails = [{ email, type: "office" }];
    }
    if (phoneValid) {
      contactPayload.phones = [{ phone, type: "mobile" }];
    }
    const contact = await closeRequest(apiKey, "POST", "/contact/", contactPayload);

    // 3. If a package was selected, create an Opportunity too
    let opportunity = null;
    if (payload.package && PACKAGE_PRICE_CENTS[payload.package] !== undefined) {
      const installType =
        payload.package === "Starter" ? "Point of Use" : "Main Line Tie-in";
      // NOTE: "Point of Use" is a best-guess match for the Install Type
      // dropdown in Close — only "Main Line Tie-in" has been confirmed
      // against the real configured choices. Verify this value if
      // Starter-package opportunities fail to create.

      opportunity = await closeRequest(apiKey, "POST", "/opportunity/", {
        lead_id: lead.id,
        contact_id: contact.id,
        status_id: OPP_STATUS_CONTACTED,
        value: PACKAGE_PRICE_CENTS[payload.package],
        value_period: "one_time",
        [`custom.${FIELD.oppPackage}`]: payload.package,
        [`custom.${FIELD.oppInstallType}`]: installType,
        note: payload.note || undefined,
      });
    } else if (payload.note) {
      // No package selected, but there's context worth logging
      // (e.g. a requested callback day/time from the booking widget).
      await closeRequest(apiKey, "POST", "/lead/" + lead.id + "/", {
        description: payload.note,
      }).catch(() => {
        // Non-fatal — the lead and contact already exist either way.
      });
    }

    return new Response(
      JSON.stringify({
        success: true,
        lead_id: lead.id,
        contact_id: contact.id,
        opportunity_id: opportunity?.id || null,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Lead submission failed:", err);
    return new Response(
      JSON.stringify({ error: "Failed to create lead in CRM" }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }
};

export const config: Config = {
  path: "/api/submit-lead",
};
