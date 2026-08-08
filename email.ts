import { Resend } from "resend";
import { createClient } from "@supabase/supabase-js";

const resend = new Resend(process.env.RESEND_API_KEY!);
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

/// Looks up the user's registered email (if any) and sends a notification.
/// Silently does nothing if the user never set an email — this is a genuine
/// convenience feature, not something that should ever block or fail the
/// actual on-chain action it's reporting on.
export async function sendNotificationEmail(userAddress: string, subject: string, body: string) {
  try {
    const { data, error } = await supabase
      .from("notification_emails")
      .select("email")
      .eq("user_address", userAddress.toLowerCase())
      .single();

    if (error || !data?.email) return; // no email on file — nothing to send

    await resend.emails.send({
      from: "Ledgerflow <notifications@ledgerflow-protocol.xyz>",
      to: data.email,
      subject,
      text: body,
    });
    console.log(`  Email sent to ${data.email}`);
  } catch (err) {
    // Never let a notification failure affect the actual protective/trading
    // action it's reporting on — just log and move on.
    console.log(`  Email notification failed (non-blocking): ${(err as Error).message}`);
  }
}
