import * as http from "node:http";
import { env } from "@telnyx/edge-runtime";

const port = Number(process.env.PORT ?? 8080);

// ⚠️ CHANGE BEFORE DEPLOYING — replace with your transfer target (E.164).
// This is a placeholder; leaving it will attempt to bridge callers to a real number.
const SALES = "+13125550100";
const VOICE = "Telnyx.KokoroTTS.af"; // any Telnyx TTS voice
const MENU =
  "Thanks for calling Acme. For sales, press 1. " +
  "For our hours, press 2. To leave a message, press 3.";
const HOURS = "We're open Monday through Friday, 9 a.m. to 5 p.m. Eastern. Goodbye.";

// client_state is base64 on the wire and echoed back on later events — we use it
// to remember which prompt is playing so we know what to do when it ends.
const enc = (s: string) => Buffer.from(s).toString("base64");
const dec = (s?: string) => (s ? Buffer.from(s, "base64").toString() : "");

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b));
  });
}

http.createServer(async (req, res) => {
  if (req.method === "GET") { res.writeHead(200); res.end(); return; } // health

  // Each inbound call is a *sequence* of webhooks to this one handler. We answer,
  // then drive the tree by reacting to the event each prior action produced.
  // Parse + dispatch inside try/catch so a malformed body or one failed action
  // never crashes the process — Telnyx retries any non-2xx.
  try {
    const evt = (env.MY_TELNYX.webhooks.unsafeUnwrap(await readBody(req)) as { data: any }).data;
    const id = evt?.payload?.call_control_id;
    const A = env.MY_TELNYX.calls.actions; // shorthand

    switch (evt?.event_type) {
      case "call.initiated":
        if (id) await A.answer(id, {});
        break;

      // Answered → read the menu and collect one digit.
      case "call.answered":
        if (id) await A.gatherUsingSpeak(id, {
          payload: MENU,
          voice: VOICE,
          valid_digits: "123",
          maximum_digits: 1,
          timeout_millis: 8000,
        });
        break;

      // A digit came in (or the gather timed out with none).
      case "call.gather.ended": {
        if (!id) break;
        switch (evt.payload.digits) {
          case "1": // hand off to a human — Telnyx bridges when they answer
            await A.transfer(id, { to: SALES });
            break;
          case "2": // speak, then hang up when that speak ends
            await A.speak(id, { payload: HOURS, voice: VOICE, client_state: enc("hangup") });
            break;
          case "3": // prompt, then start recording when that speak ends
            await A.speak(id, {
              payload: "Leave your message after the tone, then hang up.",
              voice: VOICE,
              client_state: enc("record"),
            });
            break;
          default: // no/invalid input — re-read the menu once more
            await A.gatherUsingSpeak(id, {
              payload: MENU, voice: VOICE, valid_digits: "123", maximum_digits: 1,
            });
        }
        break;
      }

      // A speak finished — client_state tells us which one and what's next.
      case "call.speak.ended": {
        if (!id) break;
        const stage = dec(evt.payload.client_state);
        if (stage === "hangup") await A.hangup(id, {});
        if (stage === "record") await A.startRecording(id, {
          format: "mp3",
          channels: "single",
          play_beep: true,
          max_length: 120,       // seconds — safety cap
          transcription: true,   // get text alongside the audio
        });
        break;
      }

      // Voicemail is stored — the URL + transcript arrive here. Fan out to your
      // own systems (email, ticket, SMS) over plain fetch(), then end the call.
      case "call.recording.saved": {
        if (!id) break;
        const url = evt.payload.public_recording_urls?.mp3 ?? evt.payload.recording_urls?.mp3;
        console.log("voicemail", { call: id, url, transcription: evt.payload.transcription });
        await A.hangup(id, {});
        break;
      }
    }
  } catch (err) {
    console.error("handler error", err); // malformed body or failed action — don't wedge the webhook
  }

  res.writeHead(200); // ack promptly — Telnyx retries non-2xx
  res.end();
}).listen(port);
