/**
 * Razorpay webhook -> confirmation email to the student + notification to the owner.
 * Listens for the "payment_link.paid" event. All secrets come from Vercel environment variables.
 *
 * Required env vars (Vercel -> Project -> Settings -> Environment Variables):
 *   RAZORPAY_WEBHOOK_SECRET  the secret you type when creating the webhook in Razorpay
 *   GMAIL_USER               the Gmail address that sends the emails
 *   GMAIL_APP_PASSWORD       a Google "App Password" (not your normal password)
 *   OWNER_EMAIL              (optional) where you get notified; defaults to GMAIL_USER
 */
const crypto = require("crypto");
const nodemailer = require("nodemailer");

const INSTITUTE = "Second Life Institute";
const PHONE = "+91 95519 45601";
const WHATSAPP = "https://wa.me/919551945601";

const esc = (v) =>
  String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function readRaw(req) {
  const chunks = [];
  for await (const c of req) chunks.push(typeof c === "string" ? Buffer.from(c) : c);
  return Buffer.concat(chunks);
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).send("Method not allowed");

  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!secret || !user || !pass) return res.status(500).send("Server not configured");

  // 1) Verify the request really came from Razorpay (signature of the RAW body)
  const raw = await readRaw(req);
  const sig = String(req.headers["x-razorpay-signature"] || "");
  const expected = crypto.createHmac("sha256", secret).update(raw).digest("hex");
  const valid = sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  if (!valid) return res.status(400).send("Invalid signature");

  let event;
  try { event = JSON.parse(raw.toString("utf8")); } catch (_) { return res.status(400).send("Bad JSON"); }
  if (event.event !== "payment_link.paid") return res.status(200).send("Ignored");

  // 2) Read payer details from the event
  const link = (event.payload && event.payload.payment_link && event.payload.payment_link.entity) || {};
  const pay = (event.payload && event.payload.payment && event.payload.payment.entity) || {};
  const email = String(pay.email || (link.customer && link.customer.email) || "").trim();
  const phone = pay.contact || (link.customer && link.customer.contact) || "";
  const name = (link.customer && link.customer.name) || "";
  const rupees = Number(pay.amount != null ? pay.amount : link.amount_paid || 0) / 100;
  const amount = "₹" + (rupees % 1 ? rupees.toFixed(2) : rupees);
  const payId = pay.id || "";

  const owner = process.env.OWNER_EMAIL || user;
  const from = `"${INSTITUTE}" <${user}>`;
  const transport = nodemailer.createTransport({ service: "gmail", auth: { user, pass } });
  const jobs = [];

  // 3) Confirmation email to the student
  if (email.includes("@")) {
    const hello = name ? `Hi ${esc(name)},` : "Hi,";
    jobs.push(
      transport.sendMail({
        from, to: email, replyTo: owner,
        subject: `Your SAP demo class booking is confirmed – ${INSTITUTE}`,
        text: `${name ? "Hi " + name : "Hi"},\n\nThank you for booking a demo class with ${INSTITUTE}. We have received your payment of ${amount}${payId ? " (Payment ID: " + payId + ")" : ""}.\n\nOur team will contact you on WhatsApp shortly to confirm your demo batch and share the joining details.\n\nQuestions? WhatsApp or call ${PHONE}.\n\n${INSTITUTE}\nTransforming Careers Through Expert SAP Training.`,
        html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#26334d;line-height:1.6">
<h2 style="color:#0b1f4b;margin-bottom:4px">Your demo class booking is confirmed</h2>
<p>${hello}</p>
<p>Thank you for booking a demo class with <b>${INSTITUTE}</b>. We have received your payment of <b>${esc(amount)}</b>${payId ? ` (Payment ID: ${esc(payId)})` : ""}.</p>
<p>Our team will contact you on WhatsApp shortly to confirm your demo batch and share the joining details.</p>
<p><a href="${WHATSAPP}" style="background:#0b1f4b;color:#fff;padding:12px 22px;border-radius:99px;text-decoration:none;display:inline-block">Chat on WhatsApp</a></p>
<p style="color:#66758f;font-size:13px">Questions? Call or WhatsApp ${PHONE}.<br>${INSTITUTE} – Transforming Careers Through Expert SAP Training.</p></div>`,
      })
    );
  }

  // 4) Notification to you
  jobs.push(
    transport.sendMail({
      from, to: owner,
      subject: `New paid demo booking – ${name || phone || email || payId}`,
      text: `A demo class payment was received.\n\nName: ${name}\nEmail: ${email || "(not provided)"}\nPhone: ${phone}\nAmount: ${amount}\nPayment ID: ${payId}\n\nStudent confirmation email: ${email.includes("@") ? "sent" : "NOT sent (no email on payment)"}`,
    })
  );

  const results = await Promise.allSettled(jobs);
  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length) {
    console.error("Email error:", failed.map((f) => String(f.reason)));
    return res.status(500).send("Email failed"); // Razorpay will retry
  }
  return res.status(200).send("OK");
};
