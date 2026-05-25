const RESEND_API = 'https://api.resend.com/emails';
const FROM = 'ItsLive <noreply@itslive.dev>';

async function send(apiKey: string, to: string, subject: string, html: string): Promise<void> {
  const resp = await fetch(RESEND_API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, to, subject, html }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Resend error ${resp.status}: ${err}`);
  }
}

export async function sendOtp(apiKey: string, email: string, code: string): Promise<void> {
  const html = `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:40px 24px">
      <h1 style="font-size:24px;font-weight:700;margin-bottom:8px">Verify your email</h1>
      <p style="color:#666;margin-bottom:32px">Enter this code to complete your ItsLive sign-up:</p>
      <div style="background:#f4f4f5;border-radius:12px;padding:24px;text-align:center;margin-bottom:32px">
        <span style="font-size:40px;font-weight:700;letter-spacing:8px;font-family:monospace">${code}</span>
      </div>
      <p style="color:#999;font-size:14px">This code expires in 10 minutes and can only be used once.</p>
      <p style="color:#999;font-size:14px">If you didn't request this, you can safely ignore this email.</p>
    </div>`;
  await send(apiKey, email, 'Your ItsLive verification code', html);
}

export async function sendWelcome(apiKey: string, email: string): Promise<void> {
  const html = `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:40px 24px">
      <h1 style="font-size:24px;font-weight:700;margin-bottom:8px">Welcome to ItsLive</h1>
      <p style="color:#666">Your account is ready. Your API key has been issued — store it securely.</p>
      <p style="color:#666;margin-top:16px">Deploy your first site in seconds. Your agent knows what to do.</p>
    </div>`;
  await send(apiKey, email, 'Welcome to ItsLive', html);
}

export async function sendExistingAccountNotice(apiKey: string, email: string): Promise<void> {
  const html = `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:40px 24px">
      <h1 style="font-size:24px;font-weight:700;margin-bottom:8px">Sign-up attempt notice</h1>
      <p style="color:#666">Someone tried to create an ItsLive account with your email address.</p>
      <p style="color:#666;margin-top:16px">If this was you, check your inbox for a separate verification code.</p>
      <p style="color:#666;margin-top:16px">If this wasn't you, no action is needed — your account is secure.</p>
    </div>`;
  await send(apiKey, email, 'ItsLive account activity', html);
}
